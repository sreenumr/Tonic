// MusicHelper frontend: live-mic streaming panel + file-upload panel, both
// rendering the same result shape returned by the Go backend.

// PWA: cache the app shell for instant loads + offline support. No-op
// (and harmless) inside the Android app's WebView, which doesn't do
// install prompts but still benefits from the caching.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.error("Service worker registration failed:", err);
    });
  });
}

if (window.AndroidAudio && window.AndroidAudio.isDebugBuild && window.AndroidAudio.isDebugBuild()) {
  const debugBadge = document.getElementById("debug-badge");
  if (debugBadge) debugBadge.hidden = false;
}

const resultTemplate = document.getElementById("result-template");
const DEFAULT_LEVEL = "medium";

function createPanelState() {
  return { lastResult: null, level: DEFAULT_LEVEL };
}

/**
 * Builds the result DOM from the <template> once per container and caches
 * field references on it (container._resultNodes), so later updates can
 * mutate the existing nodes in place instead of tearing the whole block
 * down and rebuilding it - which used to replay the .results > * entrance
 * animation (style.css fade-in-up) on every single analysis tick, reading
 * as a constant flash/refresh while listening live.
 */
function buildResultNodes(container, state) {
  container.innerHTML = "";
  container.appendChild(resultTemplate.content.cloneNode(true));

  const q = (name) => container.querySelector('[data-field="' + name + '"]');
  const fields = {
    currentChordBlock: q("currentChordBlock"),
    currentChordValue: q("currentChordValue"),
    warming: q("warming"),
    scaleBlock: q("scaleBlock"),
    topScale: q("topScale"),
    confidenceFill: q("confidenceFill"),
    confidenceLabel: q("confidenceLabel"),
    chordsBlock: q("chordsBlock"),
    chords: q("chords"),
    similarBlock: q("similarBlock"),
    similar: q("similar"),
    levelTabs: Array.from(container.querySelectorAll(".level-tab")),
  };

  fields.levelTabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      state.level = btn.dataset.level;
      renderResult(container, state.lastResult, state);
    });
  });

  container._resultNodes = fields;
  return fields;
}

/**
 * Renders an analysis Result (see internal/analysis.Result) into container,
 * remembering the raw result + selected chord-progression level in `state`
 * so switching levels re-renders instantly without another request.
 */
function renderResult(container, result, state) {
  state.lastResult = result;
  const fields = container._resultNodes || buildResultNodes(container, state);

  fields.currentChordBlock.hidden = !result.currentChord;
  if (result.currentChord) {
    fields.currentChordValue.textContent = chordLabel(result.currentChord);
  }

  const hasScale = !!result.topScale;
  fields.warming.hidden = hasScale;
  fields.scaleBlock.hidden = !hasScale;
  fields.chordsBlock.hidden = !hasScale;
  fields.similarBlock.hidden = !hasScale;

  if (hasScale) {
    fields.topScale.textContent = result.topScale;

    const pct = Math.max(0, Math.min(1, result.confidence)) * 100;
    fields.confidenceFill.style.width = pct.toFixed(0) + "%";
    fields.confidenceLabel.textContent = pct.toFixed(0) + "%";

    fields.levelTabs.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.level === state.level);
    });

    const chords = (result.chords && result.chords[state.level]) || [];
    fields.chords.innerHTML = "";
    for (const chord of chords) {
      const li = document.createElement("li");
      li.className = "chord-chip quality-" + chord.quality;
      li.innerHTML =
        '<div class="roman">' + chord.roman + "</div>" +
        '<div class="name">' + chordLabel(chord) + "</div>" +
        '<div class="notes">' + chord.notes.join(" ") + "</div>";
      fields.chords.appendChild(li);
    }

    fields.similar.innerHTML = "";
    for (const cand of result.similar || []) {
      const candPct = Math.max(0, Math.min(1, cand.confidence)) * 100;
      const li = document.createElement("li");
      li.className = "similar-row";
      li.innerHTML =
        '<span class="name">' + cand.name + "</span>" +
        '<span class="meter"><span class="meter-track"><span class="meter-fill" style="width:' +
        candPct.toFixed(0) + '%"></span></span></span>' +
        '<span class="pct">' + candPct.toFixed(0) + "%</span>";
      fields.similar.appendChild(li);
    }
  }

  container.hidden = false;
}

function chordLabel(chord) {
  if (chord.quality === "minor") return chord.root + "m";
  if (chord.quality === "diminished") return chord.root + "°";
  return chord.root;
}

function showError(container, message) {
  container._resultNodes = null;
  container.hidden = false;
  container.innerHTML = '<p class="error-message"></p>';
  container.querySelector(".error-message").textContent = message;
}

// ---------- File upload panel ----------

const fileInput = document.getElementById("file-input");
const dropzone = document.getElementById("dropzone");
const fileResults = document.getElementById("file-results");
const fileHint = document.getElementById("file-hint");
const filePanelState = createPanelState();

fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) analyzeFile(fileInput.files[0]);
});

["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  })
);
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) analyzeFile(file);
});

async function analyzeFile(file) {
  fileHint.textContent = "Analyzing " + file.name + "…";
  fileResults.hidden = true;

  const form = new FormData();
  form.append("audio", file);

  try {
    const res = await fetch("/api/analyze", { method: "POST", body: form });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "analysis failed");
    fileHint.textContent = "Analyzed " + file.name;
    renderResult(fileResults, body, filePanelState);
  } catch (err) {
    fileHint.textContent = "";
    showError(fileResults, "Could not analyze file: " + err.message);
  }
}

// ---------- Live mic panel ----------

const liveToggle = document.getElementById("live-toggle");
const liveResults = document.getElementById("live-results");
const liveHint = document.getElementById("live-hint");
const liveStatusDot = document.getElementById("live-status-dot");
const livePanelState = createPanelState();

let liveSession = null; // browser path: { audioContext, stream, ws, workletNode }; native path: {} while listening

function setLiveUIListening() {
  liveToggle.disabled = false;
  liveToggle.textContent = "Stop listening";
  liveToggle.classList.add("stop");
  liveStatusDot.classList.add("live");
  liveHint.textContent = "Listening… the chord updates fast, the scale settles in after a few seconds.";
}

function setLiveUIIdle(message) {
  liveToggle.disabled = false;
  liveToggle.textContent = "Start listening";
  liveToggle.classList.remove("stop");
  liveStatusDot.classList.remove("live");
  liveHint.textContent = message || "Play or perform some music near your mic, then wait a couple of seconds.";
}

if (window.AndroidAudio) {
  // Running inside the MusicHelper Android app. The WebView's own
  // getUserMedia is broken by a known Android/Chromium bug (mic capture
  // fails with NotReadableError due to an audio-permission-attribution
  // issue), so mic capture happens natively in Kotlin (AudioRecord)
  // instead, with results pushed back in here via these two callbacks.
  window.__nativeAudioResult = function (jsonStr) {
    const result = JSON.parse(jsonStr);
    if (result.error) {
      showError(liveResults, result.error);
      return;
    }
    renderResult(liveResults, result, livePanelState);
  };

  window.__nativeAudioError = function (message) {
    liveSession = null;
    setLiveUIIdle(message);
  };

  liveToggle.addEventListener("click", () => {
    if (liveSession) {
      window.AndroidAudio.stopListening();
      liveSession = null;
      setLiveUIIdle();
    } else {
      liveToggle.disabled = true;
      liveHint.textContent = "Requesting microphone access…";
      livePanelState.lastResult = null;
      liveSession = {};
      window.AndroidAudio.startListening();
      setLiveUIListening();
    }
  });
} else {
  liveToggle.addEventListener("click", () => {
    if (liveSession) {
      stopLive();
    } else {
      startLive();
    }
  });

  async function startLive() {
    liveToggle.disabled = true;
    liveHint.textContent = "Requesting microphone access…";
    livePanelState.lastResult = null;

    // Isolate the actual mic-permission step from everything after it, so a
    // failure elsewhere (audio pipeline setup, worklet loading, websocket)
    // doesn't get misreported as a microphone problem.
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      liveToggle.disabled = false;
      liveHint.textContent = "Microphone access failed (" + err.name + "): " + err.message;
      return;
    }

    try {
      const audioContext = new AudioContext();
      await audioContext.audioWorklet.addModule("/worklet.js");

      const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(wsProtocol + "//" + location.host + "/ws");
      ws.binaryType = "arraybuffer";

      const session = { audioContext, stream, ws, workletNode: null };
      liveSession = session;

      ws.onopen = () => {
        ws.send(JSON.stringify({ sampleRate: audioContext.sampleRate }));

        const source = audioContext.createMediaStreamSource(stream);
        const workletNode = new AudioWorkletNode(audioContext, "pcm-capture-processor");
        session.workletNode = workletNode;

        workletNode.port.onmessage = (event) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(event.data.buffer);
          }
        };
        source.connect(workletNode);

        setLiveUIListening();
      };

      ws.onmessage = (event) => {
        const result = JSON.parse(event.data);
        if (result.error) {
          showError(liveResults, result.error);
          return;
        }
        renderResult(liveResults, result, livePanelState);
      };

      ws.onerror = () => {
        showError(liveResults, "Connection error.");
      };

      ws.onclose = () => {
        if (liveSession === session) stopLive();
      };
    } catch (err) {
      liveToggle.disabled = false;
      liveHint.textContent = "Could not start audio processing (" + err.name + "): " + err.message;
      stream.getTracks().forEach((t) => t.stop());
    }
  }

  function stopLive() {
    const session = liveSession;
    liveSession = null;
    if (!session) return;

    if (session.workletNode) session.workletNode.disconnect();
    session.stream.getTracks().forEach((t) => t.stop());
    if (session.ws.readyState === WebSocket.OPEN || session.ws.readyState === WebSocket.CONNECTING) {
      session.ws.close();
    }
    session.audioContext.close();

    setLiveUIIdle();
  }
}
