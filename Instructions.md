Instructions for MusicHelper

Develop an app that can detect scales by listening to the song ( similar to the Shazam app ) real time.

The app should detect the song/music and display the right scale. Then it should show the corresponding chords associated with that scale.
Show the top scale also potential similar scales.
Develop this app in go if possible else pick the right language.

## Decisions

- Interface: web app (browser GUI) first, architected so it could become a
  native app later without a rewrite - now also shipped as a **standalone
  native Android app** (own icon, works fully offline, no PC required) that
  embeds the exact same Go server + `web/` frontend via `gomobile`, proving
  out that "no rewrite" plan.
- Audio input: both live microphone capture and file upload (WAV/MP3)
  analysis.
- Backend: Go, serving a plain HTML/CSS/JS frontend with no build step. Mic
  capture happens in the browser/WebView (Web Audio API); Go does 100% of
  the DSP/music-theory analysis, so there are no native/cgo audio
  dependencies on desktop, and on Android the only "native" code is the thin
  Kotlin WebView shell.

## Architecture

**One Go codebase, three build targets, cleanly separated by directory.**
Everything under `internal/` (the actual analysis engine) and `assets/web/`
(the frontend) is 100% shared and platform-agnostic - it has no idea whether
it'll end up in a desktop binary or an Android APK. Only two thin
platform-specific entry points sit on top of it:

```
internal/theory/        Krumhansl-Schmuckler key profiles, key correlation,
                         diatonic chord derivation (major + natural minor)
internal/dsp/            Hann-windowed FFT -> 12-bin chroma vector extraction
internal/audio/          WAV/MP3 decode -> mono float64 PCM
internal/analysis/       Glues dsp+theory: AnalyzeFile (whole file) and
                         StreamAnalyzer (rolling 6s key window + 1.5s chord
                         window for live mic)
internal/api/            NewMux(fs.FS) - POST /api/analyze, GET /ws, static
                         file serving; used by both entry points below
internal/tlscert/        Self-signed HTTPS cert generation (desktop only)
assets/assets.go         //go:embed web -> embed.FS, shared by both entry
                         points below
assets/web/               index.html, style.css, app.js, worklet.js, plus
                         manifest.json/sw.js/icons/ (PWA) - THE one frontend,
                         served identically by both desktop and Android

  -- platform entry points, everything above this line is shared --

cmd/server/main.go       Desktop web app: HTTP (:8080) + self-signed HTTPS
                         (:8443, for PWA install from other LAN devices)
mobile/mobile.go         gomobile-bindable entry point: Start(port) launches
                         the same server on 127.0.0.1 inside an Android
                         app's own process (HTTP only - it's process-local,
                         not network-facing, so no TLS needed there)
android/                 Android Studio Gradle project (Kotlin) - the only
                         genuinely platform-specific code. Single Activity +
                         WebView loading the embedded server; live mic
                         capture uses native AudioRecord (see Progress Log -
                         WebView's own getUserMedia hit a platform bug),
                         streamed to the same /ws endpoint over OkHttp.
                         Package com.musichelper.app.

scripts/build-web.ps1     -> dist\musichelper-server.exe (the web app)
scripts/build-android.ps1 -> dist\musichelper-debug.apk  (the native app)
```

Three ways to run/install the same app:
1. **Web app**: `dist\musichelper-server.exe` (or `go run ./cmd/server`) -
   visit `http://localhost:8080` in any browser.
2. **PWA** (installable icon on a phone/tablet, no native build needed):
   same server, but visit the `https://<lan-ip>:8443` address it prints at
   startup from another device on the same WiFi, then use the browser's
   "Install app" prompt. Requires accepting a one-time self-signed-
   certificate warning (see Progress Log).
3. **Native Android app**: `dist\musichelper-debug.apk` - a real installed
   app, own icon, works fully offline with no PC involved at all (embeds
   the Go server inside the app process itself).

Live pipeline: browser captures mic via `getUserMedia` + `AudioWorklet`,
streams float32 PCM over a WebSocket with a JSON `{sampleRate}` setup
message first; the server keeps a rolling ~6s buffer per connection and,
every ~500ms, pushes back two independent estimates:
- **Scale/key** - correlated over the full ~6s window (with hysteresis: a
  new key must beat the currently-shown one by a margin to take over) so it
  reads as a stable, slow-moving "this song is in X" rather than flickering
  with every chord.
- **Current chord** - correlated over just the trailing ~1.5s, independent
  of key context, so it tracks whatever chord is sounding right now. Shown
  as its own clearly-labeled "chord playing now" UI element, separate from
  the scale.

File pipeline: `POST /api/analyze` (multipart, field `audio`) decodes the
file and runs the same chroma/key-detection pipeline once over the whole
track, reusing all the same theory/dsp code as the live path.

## Progress Log

- 2026-07-27: Initial build complete and verified end-to-end.
  - `internal/theory`: 24-candidate (12 tonics x major/minor) Krumhansl-
    Schmuckler correlation + diatonic triad builder. Unit tested.
  - `internal/dsp`: FFT-based chroma extraction, verified against pure sine
    tones (correct pitch class detected). Unit tested.
  - `internal/audio`: WAV (github.com/go-audio/wav) and MP3
    (github.com/hajimehoshi/go-mp3) decoding to mono PCM.
  - `internal/api` + `cmd/server`: file-upload endpoint and WebSocket live
    endpoint wired up and serving `web/`.
  - `web/`: two-panel UI (Live listening / Analyze a file) with a scale
    stat-tile + confidence meter, a 7-chord diatonic grid color-coded by
    quality, and a ranked similar-scales list.
  - Verified end-to-end: generated a synthetic C-major test WAV and
    (a) POSTed it to `/api/analyze` - correctly returned "C Major" at ~94%
    confidence with correct diatonic chords; (b) streamed the same audio
    over `/ws` via a throwaway Go test client mimicking the browser's
    worklet - correctly and consistently returned "C Major" every ~500ms.
    Both throwaway test tools were removed after verification (not part of
    the app).
  - Not yet verified: real browser microphone capture end-to-end (needs a
    human to grant mic permission in an actual browser -
    `go run ./cmd/server`, visit `http://localhost:8080`, click
    "Start listening"). The underlying WebSocket protocol was verified via
    the test client above, so this is a UI/permissions check, not a logic
    risk.
  - Future enhancement ideas (not yet built): additional modes beyond
    major/natural minor (dorian, mixolydian, etc.) - the profile table in
    `internal/theory/theory.go` is structured so these are just additional
    entries; a native desktop shell via Wails around the same backend/web
    assets.

- 2026-07-27 (follow-up): fixed live-mode UX feedback - the on-screen label
  was updating every ~500ms and calling each update a "scale", which read
  as the detected key changing every time the chord changed.
  - `internal/theory`: added `DetectChord` - direct chroma-vs-triad-template
    matching (36 candidates: 12 roots x major/minor/diminished), independent
    of key context, for "what chord is playing right now". Added `Level` +
    `ChordsForLevel` - chord-progression complexity tiers (`easy`=I IV V,
    `medium`=+vi, `hard`=+ii, `full`=all 7 diatonic triads), so a detected
    key can be shown as a 3/4/5/7-chord progression.
  - `internal/analysis`: `StreamAnalyzer` now tracks two windows instead of
    one - a ~6s window for the key/scale estimate (was 3s) and a ~1.5s
    trailing window for the chord estimate, exposed as separate
    `topScale`/`confidence` vs `currentChord` fields in the JSON result.
    Added switch-margin hysteresis (`keySwitchMargin`) so the displayed key
    only changes when a new candidate clearly outscores the current one,
    rather than on every window recompute. `Result.Chords` is now
    `{easy,medium,hard,full}` (all four tiers precomputed) instead of a flat
    7-chord list, for both the live and file-upload paths.
  - `web/`: added a distinct "Chord playing now" badge (fast-updating,
    accent-colored) separate from the "Detected scale" stat tile (slow-
    moving); added Easy/Medium/Hard/Full pill tabs over the chord grid that
    re-render instantly from the already-fetched result (no extra request).
  - Verified with a throwaway Go WebSocket test client that played a
    C-F-G-Am (I-IV-V-vi) progression: `currentChord` correctly tracked each
    chord in real time while `topScale` held steady at "C Major" through the
    I-IV-V chords. It does drift to the relative minor if a single chord
    (e.g. the vi) is sustained alone for the entire ~6s window with no other
    harmonic content - an extreme synthetic-sine-wave case; real recordings
    (with a bassline/other voices reinforcing the tonic) should be more
    stable than that. Test tool removed after verification.

- 2026-07-27 (Android native app): shipped MusicHelper as a standalone
  native Android app per user request ("run natively on my Android
  device"), no separate PC required.
  - Refactored static-asset serving from `http.Dir("web")` to
    `//go:embed` (new `assets` package, `web/` moved under `assets/web/`)
    and extracted `api.NewMux(fs.FS)` so the exact same server-building code
    works both on disk (desktop) and baked into a binary (mobile, which has
    no "web" directory on disk). No behavior change for the desktop server -
    re-verified with the same curl smoke test used originally.
  - Added `mobile/mobile.go`: a minimal gomobile-bindable `Start(port) error`
    that runs the server on `127.0.0.1` only (unlike the desktop server,
    which listens on all interfaces) since this now runs inside one person's
    phone, not shared on a network. Idempotent via `sync.Once`.
  - Toolchain installed this session: Android NDK 26.1.10909125, SDK
    platforms 34/36, build-tools, `gomobile`/`gobind` (added as a Go tool
    dependency via `go get -tool`), and a standalone Gradle 9.6.1 (used once
    to generate a proper wrapper for the new `android/` project - AGP 9.3.1 +
    Gradle 9.6.1 was required for JDK 24 compatibility, since that's what's
    installed on this machine).
  - `android/` is a Kotlin Gradle project, package `com.musichelper.app`,
    minSdk 26 / compileSdk+targetSdk 36 (bumped from 34 mid-build - latest
    `androidx.activity` required it). `MainActivity` is a plain
    `ComponentActivity` (not `AppCompatActivity` - that requires an AppCompat
    theme and crashed on first launch; fixed by switching base class rather
    than pulling in the AppCompat dependency, since the app has no need for
    AppCompat widgets) hosting a `WebView`: starts `Mobile.start(8080)` on a
    background thread, requests `RECORD_AUDIO` at runtime, grants
    `RESOURCE_AUDIO_CAPTURE` via `WebChromeClient.onPermissionRequest` when
    the page calls `getUserMedia`, then loads `http://127.0.0.1:8080/`.
    `usesCleartextTraffic="true"` (loopback-only, so acceptable) since
    Android blocks plain HTTP by default from API 28+.
  - Built the AAR with `gomobile bind -target=android -androidapi 24`,
    built the APK with `./gradlew assembleDebug`, installed on the user's
    physical phone (Samsung SM-A156B) via `adb install` over USB debugging.
  - Verified end-to-end on-device: confirmed via `adb logcat` that the app
    launches without crashing and its process stays alive (fixed one crash
    along the way - the AppCompat theme mismatch above), and via
    `adb forward` that the embedded server actually serves `/` and
    `/api/analyze` correctly from inside the app's own process.

- 2026-07-27 (follow-up): two more requests from the user.
  1. **Separate on-demand builds** for the web app vs. the native Android
     app, from the same codebase. Added `scripts/build-web.ps1` (`go build
     ./cmd/server` -> a single self-contained `dist\musichelper-server.exe`,
     frontend baked in via the existing `go:embed`) and
     `scripts/build-android.ps1` (`gomobile bind` + `gradlew assembleDebug`/
     `assembleRelease` -> `dist\musichelper-<variant>.apk`). Both tested
     working end-to-end (binary smoke-tested with curl; APK reinstalled and
     relaunched on-device via adb).
  2. **"Microphone access failed" on the Android app** even after granting
     the permission. First fix: `web/app.js`'s `startLive()` had a single
     catch-all around getUserMedia *and* AudioContext/AudioWorklet/WebSocket
     setup, mislabeling any of those failures as a mic problem - split into
     separate try/catches with `err.name` included, so failures are now
     accurately diagnosable. Also added `onConsoleMessage`/logging on the
     Android `WebChromeClient` so WebView JS console output reaches
     `adb logcat` (tag `MusicHelperWeb`) for future debugging without
     needing eyes on the device screen.
     With that in place, the real error surfaced: `NotReadableError: Could
     not start audio source`, and `adb logcat` showed the root cause -
     `AttributionAndPermissionUtils: ... Permission hard denied for client
     attribution [uid ..., packageName "<unknown>"]`. This is a known
     Android WebView/Chromium bug: on API 31+, WebView's internal audio-
     capture code doesn't always correctly identify itself to Android's
     audio permission-attribution system, so the OS hard-denies the mic
     open at the hardware level even though the app legitimately holds
     `RECORD_AUDIO` and the WebView-level JS permission grant succeeded
     (`onPermissionRequest` logs confirmed the grant happened). This is a
     platform/WebView compatibility issue, not a bug in this app's
     permission-handling code.
     Two remediations identified: (a) update "Android System WebView" /
     "Google Chrome" via Play Store on the device - this bug is frequently
     patched over time and often just goes away with an updated WebView
     build; (b) if that doesn't resolve it, replace WebView's `getUserMedia`
     for the live-mic path with native `AudioRecord` capture in Kotlin,
     streamed into the same analysis pipeline - bypasses WebView's audio
     capture entirely, more engineering work but immune to this class of
     WebView bug. User is trying (a) first as of this writing.

- 2026-07-27 (native audio fix + PWA): remedy (a) above (updating WebView/
  Chrome) did not fix the mic bug, so implemented remedy (b), then the user
  asked for a PWA build and to confirm/organize the shared codebase.
  - **Native mic capture on Android**: `android/.../MainActivity.kt` no
    longer relies on the WebView's `getUserMedia` at all for live listening.
    It now exposes a small JS bridge (`window.AndroidAudio`, via
    `addJavascriptInterface`) with `startListening()`/`stopListening()`;
    Kotlin captures mono 16-bit PCM via `AudioRecord`, converts it to the
    same little-endian float32 wire format the browser path already used,
    and streams it to the same `/ws` endpoint via an OkHttp WebSocket client
    (`com.squareup.okhttp3:okhttp`). Results come back over that same
    connection and get pushed into the page via
    `webView.evaluateJavascript("window.__nativeAudioResult(...)")`.
    `assets/web/app.js` now branches on `window.AndroidAudio` at load time:
    inside the Android app it drives the native bridge, everywhere else
    (desktop/mobile browsers) it uses the original getUserMedia+AudioWorklet
    path - same rendering code either way. Verified on-device: live
    detection now works in the native app.
  - **Build scripts** (also requested: separate on-demand builds for the
    web app vs. the native app from the same codebase):
    `scripts/build-web.ps1` (`go build ./cmd/server` -> a single self-
    contained `dist\musichelper-server.exe`) and `scripts/build-android.ps1`
    (`gomobile bind` + `gradlew assembleDebug`/`assembleRelease` ->
    `dist\musichelper-<variant>.apk`, `-SkipBind` flag to iterate on the
    Android/Kotlin side without re-binding Go). Both used repeatedly since
    to rebuild after each change; both work.
  - **PWA**: added `assets/web/manifest.json`, `assets/web/sw.js` (caches
    the app shell - not `/api/*` - for instant loads + offline use), icons
    (`assets/web/icons/`, generated with a throwaway Go `image/draw`
    script matching the Android launcher's mark), and registration/links in
    `index.html`/`app.js`. Because this all lives under `assets/web/`, it's
    automatically served by both the desktop server *and* the Android app's
    embedded server - no duplication.
    Added `internal/tlscert`: generates (and reuses) a long-lived self-
    signed cert so `cmd/server` also serves HTTPS on `:8443` alongside
    plain HTTP on `:8080`. This matters because full PWA install + service
    workers require a secure origin, and `localhost` is the *only* HTTP
    exception to that - a phone visiting the PC's LAN IP needs real (if
    self-signed) HTTPS, or Chrome will only offer a plain bookmark shortcut
    instead of a real installable app icon. The server now prints the LAN
    HTTPS URL(s) to visit from another device at startup. One-time cost to
    the user: their phone's browser will show an untrusted-certificate
    warning on first visit that they need to click through (`Advanced ->
    Proceed`) - after that it behaves like a normal installable PWA.
    `mobile/mobile.go` (the Android-embedded server) deliberately stays
    HTTP-only on `127.0.0.1` - it's process-local, never network-facing, so
    TLS adds nothing there.
  - **Codebase organization** (also asked whether the web/PWA/native builds
    share one codebase or need separating): confirmed already correctly
    organized - see the Architecture section above, rewritten this session
    to make the shared-vs-platform-specific split explicit.
  - Also wrote `RUNNING.md`: a plain how-to-start-each-version reference
    (separate from this file, which is more architecture/dev-diary).

- 2026-07-27 (native app accuracy investigation - PAUSED, resume here):
  user reported the native Android app's live detection (key/chord) looks
  "off" / unstable compared to the web app - important context: the shared
  Go analysis engine (`internal/theory`, `internal/dsp`, `internal/analysis`,
  `internal/api`) was **not touched** by any change this session (native
  audio bridge, PWA, HTTPS were all additive elsewhere), so if native and
  web disagree on the same audio, the cause has to be in what audio actually
  reaches that shared engine on Android, not the detection algorithm itself.
  - Added on-device level telemetry to `MainActivity.kt`'s capture loop
    (logcat tag `MusicHelperWeb`, `audio level: peak=.../32768 rms=... clipped=.../...`,
    logged roughly once/second) to diagnose with real numbers instead of
    guessing.
  - First hypothesis tried: `AudioSource.MIC`'s OEM voice-tuned processing
    (AGC/noise suppression) distorting harmonic content -> switched to
    `AudioSource.UNPROCESSED` (with fallback to `MIC` if unavailable).
    **Disproven by telemetry**: on the user's device, `UNPROCESSED` captured
    near-silence even while actively playing (peak ~20-300 out of 32768,
    i.e. roughly -40dB) - no gain applied at all, so the useful signal was
    almost certainly being swamped by noise floor, which explains
    unstable/wrong detection far better than an AGC-distortion theory would.
    Reverted `createRecorder()` back to `MIC` only.
  - **Not yet done**: a fresh telemetry + accuracy check with `MIC`
    reinstated - rebuilt and reinstalled
    (`.\scripts\build-android.ps1 -SkipBind` then `adb install -r
    dist\musichelper-debug.apk`), confirmed launches without crashing, but
    the user hadn't retested live listening yet when they asked to pause
    here. **Resume by**: asking the user to retest (tap Start listening,
    play/sing ~15-20s), then pull fresh telemetry via
    `adb -s <device> logcat -d | grep "audio level:"` - if `MIC`'s peak/rms
    now look reasonable (not near-zero, not clipped near 32768) but
    detection is still visibly wrong, the bug is likely somewhere in the
    native capture/framing/sample-rate path rather than input gain (worth
    double-checking `captureSampleRate = 44100` is what `AudioRecord`
    actually delivers on this device, and that chunk timing isn't dropping/
    duplicating samples under load); if levels are still off, that's the
    next thing to chase.
  - Device used for all testing: Samsung SM-A156B, adb serial `RZCX30Y1F1J`.

