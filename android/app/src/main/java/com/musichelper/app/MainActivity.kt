package com.musichelper.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import mobile.Mobile
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Hosts the Tonic web UI in a WebView, backed by the same Go server
 * used on desktop - started here on 127.0.0.1 inside this app's own
 * process via the gomobile-bound `mobile` package, so the app works fully
 * offline with no separate PC required.
 *
 * Live mic capture does NOT use the WebView's own getUserMedia: on-device
 * testing hit a known Android/Chromium WebView bug where its internal audio
 * capture fails with NotReadableError (an audio-permission-attribution
 * issue in the OS's AudioPolicyService, unrelated to whether the app holds
 * RECORD_AUDIO). Instead, mic capture happens natively here via
 * AudioRecord, streamed to the same /ws endpoint the browser build uses,
 * with results pushed into the page through a small JS bridge.
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private val serverPort = 8080
    private val captureSampleRate = 44100

    // Per-chunk software gain applied to captured samples before analysis -
    // see the comment in beginRecording() for why this exists.
    private val targetPeak = 0.6f * 32768f
    private val maxGain = 12f
    private val noiseFloor = 50 // raw int16 magnitude; chunks quieter than this are left ungained

    private val httpClient = OkHttpClient()
    private var webSocket: WebSocket? = null
    private var audioRecord: AudioRecord? = null
    @Volatile private var capturing = false

    private enum class MicPermissionPurpose { STARTUP, START_CAPTURE }
    private var micPermissionPurpose = MicPermissionPurpose.STARTUP

    private val requestMicPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            when (micPermissionPurpose) {
                MicPermissionPurpose.STARTUP -> loadApp()
                MicPermissionPurpose.START_CAPTURE ->
                    if (granted) startCapture() else notifyJsError("Microphone permission was denied.")
            }
        }

    // Plain WebView doesn't show a file picker for <input type="file"> on
    // its own - it has to be driven manually via onShowFileChooser below,
    // which hands off to this launcher and reports the chosen file back
    // through the WebView-supplied callback.
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooserLauncher =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
            fileChooserCallback?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
            fileChooserCallback = null
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)
        configureWebView()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })

        // Start the embedded server on a background thread, then only load
        // the page once Start() has returned - its underlying net.Listen
        // is effectively instant, but this avoids any race with loadUrl.
        Thread {
            try {
                Mobile.start(serverPort.toLong())
            } catch (e: Exception) {
                e.printStackTrace()
            }
            runOnUiThread {
                micPermissionPurpose = MicPermissionPurpose.STARTUP
                requestMicPermissionThenLoad()
            }
        }.start()
    }

    override fun onDestroy() {
        stopCapture()
        super.onDestroy()
    }

    private fun configureWebView() {
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.addJavascriptInterface(JsBridge(), "AndroidAudio")
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                Log.d(TAG, "onPermissionRequest: ${request.resources.joinToString()}")
                runOnUiThread { request.grant(request.resources) }
            }

            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.d(TAG, "console: ${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                return true
            }

            override fun onShowFileChooser(
                view: WebView?,
                callback: ValueCallback<Array<Uri>>,
                params: WebChromeClient.FileChooserParams?
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = callback
                return try {
                    fileChooserLauncher.launch("audio/*")
                    true
                } catch (e: Exception) {
                    fileChooserCallback = null
                    false
                }
            }
        }
    }

    private fun requestMicPermissionThenLoad() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED
        ) {
            loadApp()
        } else {
            requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    private fun loadApp() {
        webView.loadUrl("http://127.0.0.1:$serverPort/")
    }

    /** Exposed to the page as `window.AndroidAudio`. */
    private inner class JsBridge {
        @JavascriptInterface
        fun startListening() {
            runOnUiThread {
                if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO)
                    == PackageManager.PERMISSION_GRANTED
                ) {
                    startCapture()
                } else {
                    micPermissionPurpose = MicPermissionPurpose.START_CAPTURE
                    requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
                }
            }
        }

        @JavascriptInterface
        fun stopListening() {
            stopCapture()
        }

        @JavascriptInterface
        fun isDebugBuild(): Boolean = BuildConfig.DEBUG
    }

    private fun startCapture() {
        if (capturing) return
        capturing = true

        val request = Request.Builder().url("ws://127.0.0.1:$serverPort/ws").build()
        webSocket = httpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                ws.send("""{"sampleRate":$captureSampleRate}""")
                beginRecording(ws)
            }

            override fun onMessage(ws: WebSocket, text: String) {
                notifyJsResult(text)
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                Log.e(TAG, "websocket failure", t)
                capturing = false
                notifyJsError("Connection to analysis server failed: ${t.message}")
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                capturing = false
            }
        })
    }

    @SuppressLint("MissingPermission") // capturing==true is only reached after RECORD_AUDIO is confirmed granted
    private fun beginRecording(ws: WebSocket) {
        val minBuf = AudioRecord.getMinBufferSize(
            captureSampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
        )
        if (minBuf == AudioRecord.ERROR || minBuf == AudioRecord.ERROR_BAD_VALUE) {
            notifyJsError("Could not configure microphone recording")
            capturing = false
            return
        }

        val recorder = createRecorder(minBuf)
        if (recorder == null) {
            notifyJsError("Microphone could not be initialized")
            capturing = false
            return
        }

        audioRecord = recorder
        recorder.startRecording()

        Thread {
            val chunkSamples = 2048
            val shortBuf = ShortArray(chunkSamples)

            // Level telemetry (logcat, tag TonicWeb) to diagnose
            // capture quality issues - e.g. clipping (peak pinned near
            // 32768, distorting harmonic content and throwing off key/chord
            // detection) vs. a too-quiet signal.
            var peak = 0
            var clipped = 0
            var sumSquares = 0.0
            var samplesSinceLog = 0
            var chunksSinceLog = 0

            while (capturing) {
                val read = recorder.read(shortBuf, 0, chunkSamples)
                if (read <= 0) continue

                // On-device level telemetry (below) showed this device's MIC
                // source landing around rms 0.001-0.02 even during active
                // playing - close enough to the analysis pipeline's noise
                // floor that real tonal content couldn't reliably win out,
                // producing drifting/inaccurate key and chord detection.
                // Apply a per-chunk gain (peak-normalizing toward
                // targetPeak, capped at maxGain, skipped below the noise
                // floor so we don't amplify silence into false content)
                // before sending samples for analysis - independent of
                // whatever gain/AGC behavior this device's mic driver has.
                var chunkPeak = 0
                for (i in 0 until read) {
                    val abs = if (shortBuf[i] < 0) -shortBuf[i].toInt() else shortBuf[i].toInt()
                    if (abs > chunkPeak) chunkPeak = abs
                }
                val gain = if (chunkPeak > noiseFloor) {
                    (targetPeak / chunkPeak).coerceAtMost(maxGain)
                } else {
                    1f
                }

                val bytes = ByteArray(read * 4)
                val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
                for (i in 0 until read) {
                    val s = shortBuf[i]
                    val abs = if (s < 0) -s.toInt() else s.toInt()
                    if (abs > peak) peak = abs
                    if (abs >= 32760) clipped++
                    val gained = (s.toFloat() * gain / 32768f).coerceIn(-1f, 1f)
                    sumSquares += gained * gained
                    bb.putFloat(gained)
                }
                ws.send(ByteString.of(*bytes))

                samplesSinceLog += read
                chunksSinceLog++
                if (chunksSinceLog >= 20) { // roughly once a second at 2048 samples/chunk @44.1kHz
                    val rms = Math.sqrt(sumSquares / samplesSinceLog)
                    Log.d(TAG, "audio level: peak=$peak/32768 rms=${"%.4f".format(rms)} clipped=$clipped/$samplesSinceLog")
                    peak = 0
                    clipped = 0
                    sumSquares = 0.0
                    samplesSinceLog = 0
                    chunksSinceLog = 0
                }
            }
            try {
                recorder.stop()
            } catch (e: IllegalStateException) {
                // already stopped
            }
            recorder.release()
        }.start()
    }

    /**
     * MIC applies this device's normal capture gain. UNPROCESSED was tried
     * first (in case MIC's voice-tuned processing was distorting musical
     * content) but on-device level telemetry showed it capturing near-
     * silence (peak ~20-300/32768, no gain applied at all) even during
     * active playing - the useful signal was likely being swamped by noise
     * floor, which explains unstable/wrong detection far better than
     * anything AGC-related. Reverted to MIC.
     */
    private fun createRecorder(minBuf: Int): AudioRecord? {
        val sources = intArrayOf(MediaRecorder.AudioSource.MIC)
        for (source in sources) {
            val recorder = AudioRecord(
                source, captureSampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, minBuf * 4
            )
            if (recorder.state == AudioRecord.STATE_INITIALIZED) {
                Log.d(TAG, "AudioRecord initialized with source=$source")
                return recorder
            }
            recorder.release()
        }
        return null
    }

    private fun stopCapture() {
        capturing = false
        webSocket?.close(1000, "stopped")
        webSocket = null
    }

    private fun notifyJsResult(json: String) {
        runOnUiThread {
            webView.evaluateJavascript(
                "window.__nativeAudioResult && window.__nativeAudioResult(${JSONObject.quote(json)})", null
            )
        }
    }

    private fun notifyJsError(message: String) {
        runOnUiThread {
            webView.evaluateJavascript(
                "window.__nativeAudioError && window.__nativeAudioError(${JSONObject.quote(message)})", null
            )
        }
    }

    companion object {
        private const val TAG = "TonicWeb"
    }
}
