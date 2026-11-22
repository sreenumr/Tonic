// Tonic frontend: a single-screen app with two views - Live (mic) and File
// (upload) - both rendering the same result shape from the Go backend into
// a fixed layout that's built once up front and then updated in place.

// PWA service worker (network-first; see sw.js). Harmless in the Android
// WebView.
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
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// Display toggles (dock buttons): one app-wide preference each, remembered
// per device.
const PREFS = {
  notes: { key: "tonic.showNotes", on: false, button: document.getElementById("toggle-notes") },
  chords: { key: "tonic.showChords", on: true, button: document.getElementById("toggle-chords") },
};
for (const name in PREFS) {
  try {
    const v = localStorage.getItem(PREFS[name].key);
    if (v !== null) PREFS[name].on = v === "1";
  } catch (e) {
    /* storage unavailable - keep the default */
  }
}
const panels = []; // { container, state } for both views

// ---------- Circle of fifths ----------
//
// 12 positions clockwise from C at the top, each a fifth above the last.
// Outer ring = major chords, inner ring = their relative minors. A key's
// six common chords always sit in one 3-wide wedge: the tonic's position
// plus its two neighbours, on both rings.

const COF_MAJOR = ["C", "G", "D", "A", "E", "B", "F♯", "D♭", "A♭", "E♭", "B♭", "F"];
const COF_MINOR = ["Am", "Em", "Bm", "F♯m", "C♯m", "G♯m", "D♯m", "B♭m", "Fm", "Cm", "Gm", "Dm"];
const SHARP_SPELL = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const FLAT_SPELL = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];
const SVG_NS = "http://www.w3.org/2000/svg";
const COF_C = 160;
const COF_RINGS = {
  major: { r0: 104, r1: 152, label: 134, roman: 113 },
  minor: { r0: 64, r1: 104, label: 89, roman: 73 },
};

const mod12 = (n) => ((n % 12) + 12) % 12;
const cofPos = (pc) => mod12(pc * 7); // pitch class -> circle position (7 is its own inverse mod 12)
const cofMajorPc = (pos) => mod12(pos * 7);

function polar(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [COF_C + r * Math.cos(a), COF_C + r * Math.sin(a)];
}

function sectorPath(r0, r1, a0, a1) {
  const [x0, y0] = polar(r1, a0);
  const [x1, y1] = polar(r1, a1);
  const [x2, y2] = polar(r0, a1);
  const [x3, y3] = polar(r0, a0);
  return "M" + x0 + " " + y0 + " A" + r1 + " " + r1 + " 0 0 1 " + x1 + " " + y1 +
    " L" + x2 + " " + y2 + " A" + r0 + " " + r0 + " 0 0 0 " + x3 + " " + y3 + " Z";
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function triadNotes(rootPc, minor, pos) {
  const spell = pos >= 7 ? FLAT_SPELL : SHARP_SPELL;
  return [rootPc, rootPc + (minor ? 3 : 4), rootPc + 7].map((pc) => spell[mod12(pc)]);
}

function buildCircle(fields) {
  const svg = svgEl("svg", { viewBox: "0 0 320 320", class: "fifths", role: "img", "aria-label": "Circle of fifths" });
  fields.cofSegs = { major: [], minor: [] };

  for (const ring of ["major", "minor"]) {
    const g = COF_RINGS[ring];
    for (let pos = 0; pos < 12; pos++) {
      const mid = -90 + pos * 30;
      const seg = svgEl("g", { class: "cof-seg cof-" + ring, tabindex: "0", role: "button" });
      seg.appendChild(svgEl("path", { d: sectorPath(g.r0, g.r1, mid - 15, mid + 15) }));
      const [lx, ly] = polar(g.label, mid);
      const label = svgEl("text", { x: lx, y: ly, class: "cof-label" });
      label.textContent = ring === "major" ? COF_MAJOR[pos] : COF_MINOR[pos];
      seg.appendChild(label);
      const [rx, ry] = polar(g.roman, mid);
      const roman = svgEl("text", { x: rx, y: ry, class: "cof-roman" });
      seg.appendChild(roman);

      const select = () => {
        fields.cofSelected = { ring, pos };
        updateCircleCaption(fields);
      };
      seg.addEventListener("click", select);
      seg.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          select();
        }
      });
      svg.appendChild(seg);
      fields.cofSegs[ring].push({ seg, roman });
    }
  }

  svg.appendChild(svgEl("circle", { cx: COF_C, cy: COF_C, r: 62, class: "cof-center" }));
  fields.cofKey = svgEl("text", { x: COF_C, y: COF_C - 4, class: "cof-key" });
  fields.cofSub = svgEl("text", { x: COF_C, y: COF_C + 16, class: "cof-sub" });
  svg.appendChild(fields.cofKey);
  svg.appendChild(fields.cofSub);

  fields.fifthsWrap.appendChild(svg);
  fields.cofSelected = null;
  fields.cofKeyInfo = null;
}

/** Parses "C# Major" / "A Minor" into { pc, minor }. */
function parseKey(name) {
  if (!name) return null;
  const [root, mode] = name.split(" ");
  const pc = NOTE_NAMES.indexOf(root);
  if (pc < 0) return null;
  return { pc, minor: /minor/i.test(mode || "") };
}

function renderCircle(fields, result) {
  const key = parseKey(result.topScale);
  fields.cofKeyInfo = key;

  // Wedge centre: the position of the key's (relative) major.
  const center = key ? cofPos(key.minor ? key.pc + 3 : key.pc) : -1;
  const majorRomans = key && key.minor ? ["VI", "III", "VII"] : ["IV", "I", "V"];
  const minorRomans = key && key.minor ? ["iv", "i", "v"] : ["ii", "vi", "iii"];

  let nowRing = null;
  let nowPos = -1;
  const cc = result.currentChord;
  if (cc) {
    const rootPc = NOTE_NAMES.indexOf(cc.root);
    if (["major", "dominant7", "major7"].includes(cc.quality)) {
      nowRing = "major";
      nowPos = cofPos(rootPc);
    } else if (["minor", "minor7"].includes(cc.quality)) {
      nowRing = "minor";
      nowPos = cofPos(rootPc + 3);
    }
  }

  for (const ring of ["major", "minor"]) {
    fields.cofSegs[ring].forEach(({ seg, roman }, pos) => {
      const offset = key ? mod12(pos - center + 1) : -1; // 0,1,2 inside the wedge
      const inKey = offset >= 0 && offset <= 2;
      seg.classList.toggle("in-key", inKey);
      seg.classList.toggle("tonic", inKey && offset === 1 && (ring === "minor") === !!(key && key.minor));
      seg.classList.toggle("now", ring === nowRing && pos === nowPos);
      roman.textContent = inKey ? (ring === "major" ? majorRomans : minorRomans)[offset] : "";
    });
  }

  if (key) {
    fields.cofKey.textContent = result.topScale.replace(" Major", " major").replace(" Minor", " minor");
    const dimPc = key.minor ? key.pc + 2 : key.pc + 11;
    fields.cofSub.textContent = (key.minor ? "ii°" : "vii°") + " = " + SHARP_SPELL[mod12(dimPc)] + "dim";
  } else {
    fields.cofKey.textContent = cc ? cc.name || chordLabel(cc) : "—";
    fields.cofSub.textContent = "finding the key…";
  }
  updateCircleCaption(fields);
}

function updateCircleCaption(fields) {
  const sel = fields.cofSelected;
  for (const ring of ["major", "minor"]) {
    fields.cofSegs[ring].forEach(({ seg }, pos) => {
      seg.classList.toggle("selected", !!sel && sel.ring === ring && sel.pos === pos);
    });
  }
  if (!sel) {
    fields.fifthsCaption.textContent = fields.cofKeyInfo
      ? "Blue wedge = chords in this key · tap any chord for its notes"
      : "Neighbours on the circle sound good together · tap a chord";
    return;
  }
  const minor = sel.ring === "minor";
  const majorPc = cofMajorPc(sel.pos);
  const rootPc = minor ? mod12(majorPc + 9) : majorPc;
  const name = minor ? COF_MINOR[sel.pos] : COF_MAJOR[sel.pos];
  const roman = fields.cofSegs[sel.ring][sel.pos].roman.textContent;
  fields.fifthsCaption.textContent =
    name + " (" + (minor ? "minor" : "major") + "): " + triadNotes(rootPc, minor, sel.pos).join(" · ") +
    (roman ? "  —  " + roman + " in this key" : "");
}

function setPref(name, on) {
  PREFS[name].on = on;
  try {
    localStorage.setItem(PREFS[name].key, on ? "1" : "0");
  } catch (e) {
    /* ignore */
  }
  syncPrefButtons();
  for (const p of panels) renderResult(p.container, p.state.lastResult || {}, p.state);
}

function syncPrefButtons() {
  for (const name in PREFS) PREFS[name].button.setAttribute("aria-pressed", PREFS[name].on ? "true" : "false");
}

for (const name in PREFS) {
  PREFS[name].button.addEventListener("click", () => setPref(name, !PREFS[name].on));
}
syncPrefButtons();

function createPanelState(kind) {
  return { kind, lastResult: null, level: DEFAULT_LEVEL, fileName: "", chordsSig: "" };
}

/**
 * Builds the result DOM from the <template> once per view and caches field
 * references (container._resultNodes); every later update mutates those
 * nodes in place, so nothing is torn down, re-animated or shifted.
 */
function buildResultNodes(container, state) {
  container.innerHTML = "";
  container.appendChild(resultTemplate.content.cloneNode(true));

  const q = (name) => container.querySelector('[data-field="' + name + '"]');
  const fields = {
    currentChordBlock: q("currentChordBlock"),
    nowLabel: q("nowLabel"),
    currentChordValue: q("currentChordValue"),
    currentChordTones: q("currentChordTones"),
    scaleBlock: q("scaleBlock"),
    topScale: q("topScale"),
    confidenceFill: q("confidenceFill"),
    confidenceLabel: q("confidenceLabel"),
    notesBlock: q("notesBlock"),
    noteStrip: q("noteStrip"),
    noteCells: [],
    fifthsWrap: q("fifthsWrap"),
    fifthsCaption: q("fifthsCaption"),
    chordsBlock: q("chordsBlock"),
    chords: q("chords"),
    similarBlock: q("similarBlock"),
    similar: q("similar"),
    levelTabs: Array.from(container.querySelectorAll(".level-tab")),
  };

  fields.levelTabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      state.level = btn.dataset.level;
      renderResult(container, state.lastResult || {}, state);
    });
  });

  for (let pc = 0; pc < 12; pc++) {
    const li = document.createElement("li");
    li.className = "note-cell" + (NOTE_NAMES[pc].length > 1 ? " sharp" : "");
    li.innerHTML = '<span class="note-bar"><span class="note-fill"></span></span><span class="note-name">' + NOTE_NAMES[pc] + "</span>";
    fields.noteStrip.appendChild(li);
    fields.noteCells.push({ li, fill: li.querySelector(".note-fill") });
  }
  buildCircle(fields);

  if (!panels.some((p) => p.container === container)) panels.push({ container, state });
  container._resultNodes = fields;
  return fields;
}

/** Triad-level label of a detected chord ("G7" -> "G", "Am7" -> "Am"). */
function triadLabel(cc) {
  if (!cc) return "";
  if (cc.quality === "minor" || cc.quality === "minor7") return cc.root + "m";
  if (cc.quality === "diminished") return cc.root + "°";
  if (["major", "dominant7", "major7"].includes(cc.quality)) return cc.root;
  return "";
}

/**
 * Renders an analysis Result (see internal/analysis.Result; {} = empty
 * placeholder state) into a view.
 */
function renderResult(container, result, state) {
  state.lastResult = result;
  const fields = container._resultNodes || buildResultNodes(container, state);
  const live = state.kind === "live";
  const cc = live ? result.currentChord : null;

  // Hero, left: the chord playing now (live) or the track (file).
  if (live) {
    fields.currentChordBlock.classList.toggle("idle", !cc);
    fields.currentChordValue.textContent = cc ? cc.name || chordLabel(cc) : "—";
    if (cc) fields.currentChordTones.textContent = (cc.notes || []).join(" · ");
  } else {
    fields.currentChordBlock.classList.add("is-file");
    fields.currentChordBlock.classList.toggle("idle", !state.fileName);
    fields.nowLabel.textContent = "Track";
    fields.currentChordValue.textContent = state.fileName || "No file yet";
    fields.currentChordTones.textContent = state.fileName ? "Whole-song analysis" : "Tap ⬆ below to pick a WAV or MP3";
  }

  // Hero, right: the key.
  const hasScale = !!result.topScale;
  fields.scaleBlock.classList.toggle("pending", !hasScale);
  if (hasScale) {
    fields.topScale.textContent = result.topScale;
    const pct = Math.max(0, Math.min(1, result.confidence)) * 100;
    fields.confidenceFill.style.width = pct.toFixed(0) + "%";
    fields.confidenceLabel.textContent = pct.toFixed(0) + "%";
  } else {
    fields.topScale.textContent = live && liveSession ? "Play a few chords…" : "—";
  }

  renderNotes(fields, result.notes);
  renderCircle(fields, result);

  // Chords in key (only rebuilt when the key or level changes).
  fields.chordsBlock.hidden = !PREFS.chords.on;
  fields.levelTabs.forEach((btn) => btn.classList.toggle("active", btn.dataset.level === state.level));
  const sig = (result.topScale || "") + "|" + state.level;
  if (sig !== state.chordsSig) {
    state.chordsSig = sig;
    fields.chords.innerHTML = "";
    const chords = (hasScale && result.chords && result.chords[state.level]) || [];
    if (!chords.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "Chords appear once the key is found";
      fields.chords.appendChild(li);
    }
    for (const chord of chords) {
      const li = document.createElement("li");
      li.className = "chord-chip quality-" + chord.quality;
      li.dataset.label = chordLabel(chord);
      li.innerHTML = '<span class="roman">' + chord.roman + '</span><span class="name">' + chordLabel(chord) + "</span>";
      fields.chords.appendChild(li);
    }
  }
  const nowLabel = triadLabel(cc);
  fields.chords.querySelectorAll(".chord-chip").forEach((li) => {
    li.classList.toggle("now", !!nowLabel && li.dataset.label === nowLabel);
  });

  // Similar keys, one line.
  fields.similar.innerHTML = "";
  const similar = (hasScale && result.similar) || [];
  if (!similar.length) {
    fields.similar.textContent = "—";
  } else {
    similar.slice(0, 3).forEach((cand, i) => {
      if (i) fields.similar.appendChild(document.createTextNode("  ·  "));
      const name = document.createElement("span");
      name.textContent = cand.name.replace(" Major", " major").replace(" Minor", " minor") + " ";
      const pct = document.createElement("span");
      pct.className = "pct";
      pct.textContent = Math.round(Math.max(0, Math.min(1, cand.confidence)) * 100) + "%";
      fields.similar.append(name, pct);
    });
  }
}

function renderNotes(fields, notes) {
  fields.notesBlock.hidden = !PREFS.notes.on;
  if (!PREFS.notes.on) return;

  const active = new Set((notes && notes.active) || []);
  fields.noteCells.forEach((cell, pc) => {
    const v = notes ? notes.chroma[pc] : 0;
    cell.fill.style.height = Math.round(Math.max(0, Math.min(1, v)) * 100) + "%";
    cell.li.classList.toggle("active", active.has(NOTE_NAMES[pc]));
    cell.li.classList.toggle("bass", !!notes && notes.bass === NOTE_NAMES[pc]);
  });
}

function chordLabel(chord) {
  if (chord.quality === "minor") return chord.root + "m";
  if (chord.quality === "diminished") return chord.root + "°";
  return chord.root;
}

// ---------- Views, status line, main button ----------

const liveToggle = document.getElementById("live-toggle"); // the dock's main button
const liveResults = document.getElementById("live-results");
const fileResults = document.getElementById("file-results");
const liveStatusDot = document.getElementById("live-status-dot");
const statusEl = document.getElementById("status");
const fileInput = document.getElementById("file-input");
const livePanelState = createPanelState("live");
const filePanelState = createPanelState("file");

let liveSession = null; // browser path: { audioContext, stream, ws, workletNode }; native path: {} while listening
let activeView = "live";
const statusText = {
  live: { text: "Tap the mic and play some chords", error: false },
  file: { text: "Analyze a WAV or MP3 from your device", error: false },
};

function setStatus(view, text, isError) {
  statusText[view] = { text: text || "", error: !!isError };
  if (view === activeView) {
    statusEl.textContent = statusText[view].text;
    statusEl.classList.toggle("error", statusText[view].error);
  }
}

function syncMainButton() {
  const fileMode = activeView === "file";
  liveToggle.classList.toggle("upload", fileMode);
  liveToggle.classList.toggle("stop", !fileMode && !!liveSession);
  liveToggle.setAttribute("aria-label", fileMode ? "Choose an audio file" : liveSession ? "Stop listening" : "Start listening");
}

function switchView(view) {
  activeView = view;
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.view === view;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.getElementById("view-live").hidden = view !== "live";
  document.getElementById("view-file").hidden = view !== "file";
  setStatus(view, statusText[view].text, statusText[view].error);
  syncMainButton();
}

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));

// In File view the main button picks a file; in Live view it starts/stops.
// (Capturing listener so it runs before the live start/stop handler below.)
liveToggle.addEventListener(
  "click",
  (e) => {
    if (activeView === "file") {
      e.stopImmediatePropagation();
      fileInput.click();
    }
  },
  true
);

// Build both views in their empty state up front: the layout is final from
// the first frame and results only fill it in.
renderResult(liveResults, {}, livePanelState);
renderResult(fileResults, {}, filePanelState);
switchView("live");

// ---------- File view ----------

fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) analyzeFile(fileInput.files[0]);
  fileInput.value = "";
});

const fileView = document.getElementById("view-file");
["dragenter", "dragover"].forEach((evt) => fileView.addEventListener(evt, (e) => e.preventDefault()));
fileView.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) analyzeFile(file);
});

async function analyzeFile(file) {
  setStatus("file", "Analyzing " + file.name + "…");
  liveToggle.disabled = true;

  const form = new FormData();
  form.append("audio", file);

  try {
    const res = await fetch("/api/analyze", { method: "POST", body: form });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "analysis failed");
    filePanelState.fileName = file.name;
    renderResult(fileResults, body, filePanelState);
    setStatus("file", "Done — tap ⬆ to analyze another file");
  } catch (err) {
    setStatus("file", "Could not analyze file: " + err.message, true);
  } finally {
    liveToggle.disabled = false;
  }
}

// ---------- Live view ----------

function resetLivePanel() {
  livePanelState.lastResult = null;
  renderResult(liveResults, {}, livePanelState);
}

function setLiveUIListening() {
  liveToggle.disabled = false;
  liveStatusDot.classList.add("live");
  syncMainButton();
  setStatus("live", "Listening… the chord updates fast, the key settles in after a few chords.");
  renderResult(liveResults, livePanelState.lastResult || {}, livePanelState);
}

function setLiveUIIdle(message) {
  liveToggle.disabled = false;
  liveStatusDot.classList.remove("live");
  syncMainButton();
  setStatus("live", message || "Stopped — tap the mic to listen again", !!message);
  // Keep the last key/chords on screen, but nothing is "playing now".
  const last = livePanelState.lastResult || {};
  renderResult(liveResults, Object.assign({}, last, { currentChord: null, notes: null }), livePanelState);
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
      setStatus("live", result.error, true);
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
      setStatus("live", "Requesting microphone access…");
      resetLivePanel();
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
    setStatus("live", "Requesting microphone access…");
    resetLivePanel();

    // Isolate the actual mic-permission step from everything after it, so a
    // failure elsewhere (audio pipeline setup, worklet loading, websocket)
    // doesn't get misreported as a microphone problem.
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      liveToggle.disabled = false;
      setStatus("live", "Microphone access failed (" + err.name + "): " + err.message, true);
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
          setStatus("live", result.error, true);
          return;
        }
        renderResult(liveResults, result, livePanelState);
      };

      ws.onerror = () => {
        setStatus("live", "Connection error.", true);
      };

      ws.onclose = () => {
        if (liveSession === session) stopLive();
      };
    } catch (err) {
      liveToggle.disabled = false;
      setStatus("live", "Could not start audio processing (" + err.name + "): " + err.message, true);
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
