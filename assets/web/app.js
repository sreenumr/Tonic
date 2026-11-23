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
  if (name === "chords") renderSets();
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
  sets: { text: "Change a song's key and its chords follow", error: false },
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
  const setsMode = activeView === "sets";
  liveToggle.classList.toggle("upload", fileMode);
  const saveMode = setsMode && setsSaveMode();
  liveToggle.classList.toggle("add", setsMode && !saveMode);
  liveToggle.classList.toggle("save", saveMode);
  liveToggle.classList.toggle("stop", activeView === "live" && !!liveSession);
  liveToggle.setAttribute(
    "aria-label",
    fileMode ? "Choose an audio file" : saveMode ? "Done" : setsMode ? "Add a song" : liveSession ? "Stop listening" : "Start listening"
  );
  // Notes (live detected pitches) mean nothing for a set list.
  PREFS.notes.button.style.visibility = setsMode ? "hidden" : "";
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
  document.getElementById("view-sets").hidden = view !== "sets";
  if (view === "sets") syncActiveJump(); // positions are only real once visible
  setStatus(view, statusText[view].text, statusText[view].error);
  syncMainButton();
}

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));

// In File view the main button picks a file, in Sets view it adds a song;
// in Live view it starts/stops.
// (Capturing listener so it runs before the live start/stop handler below.)
liveToggle.addEventListener(
  "click",
  (e) => {
    if (activeView === "file") {
      e.stopImmediatePropagation();
      fileInput.click();
    } else if (activeView === "sets") {
      e.stopImmediatePropagation();
      toggleAddSong();
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

// ---------- Sets view (programs > sets > songs) ----------
//
// A program is one live show (e.g. "Baithak Nov 29"); it holds several
// sets, each a list of songs with the key they'll be played in. The key can
// be changed (picker or ±1 semitone) and the playable chords update right
// away. Pure music theory, so it's computed here - no server round trip -
// and it all lives in localStorage on this device (the Android app always
// loads from the same 127.0.0.1:8080 origin, so it persists there too).

const PROGRAMS_STORAGE = "tonic.programs";
const LEGACY_SETS_STORAGE = "tonic.setlists"; // v1: flat set lists, migrated once
const SETS_LEVEL_STORAGE = "tonic.setsLevel";
const MAJOR_TONICS = ["C", "D♭", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
const MINOR_TONICS = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "G♯", "A", "B♭", "B"];
const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
const LETTER_PCS = [0, 2, 4, 5, 7, 9, 11];
const SCALES = {
  major: { steps: [0, 2, 4, 5, 7, 9, 11], qual: ["major", "minor", "minor", "major", "major", "minor", "diminished"], roman: ["I", "ii", "iii", "IV", "V", "vi", "vii°"] },
  minor: { steps: [0, 2, 3, 5, 7, 8, 10], qual: ["minor", "diminished", "major", "minor", "minor", "major", "major"], roman: ["i", "ii°", "III", "iv", "v", "VI", "VII"] },
};
// Same tiers as the server (internal/theory levelDegrees).
const LEVEL_LABELS = { easy: "Easy", medium: "Med", hard: "Hard", full: "All" };
const LEVEL_DEGREES = { easy: [1, 4, 5], medium: [1, 4, 5, 6], hard: [1, 2, 4, 5, 6], full: [1, 2, 3, 4, 5, 6, 7] };
// Spelled-correctly-but-unfriendly names a player would just call by their
// everyday name (e.g. the VI of E♭ minor is C♭ on paper, B on the fretboard).
const FRIENDLY = { "C♭": "B", "F♭": "E", "E♯": "F", "B♯": "C" };

function keyName(key) {
  return (key.minor ? MINOR_TONICS : MAJOR_TONICS)[mod12(key.pc)] + (key.minor ? " minor" : " major");
}

/** The 7 diatonic triads of a key, spelled from the key's own letters. */
function keyChords(key) {
  const scale = SCALES[key.minor ? "minor" : "major"];
  const tonic = (key.minor ? MINOR_TONICS : MAJOR_TONICS)[mod12(key.pc)];
  const li = LETTERS.indexOf(tonic[0]);
  return scale.steps.map((step, d) => {
    const letterIdx = (li + d) % 7;
    const diff = mod12(key.pc + step - LETTER_PCS[letterIdx]);
    let root = LETTERS[letterIdx] + (diff === 1 ? "♯" : diff === 11 ? "♭" : "");
    root = FRIENDLY[root] || root;
    const q = scale.qual[d];
    return { degree: d + 1, roman: scale.roman[d], quality: q, label: root + (q === "minor" ? "m" : q === "diminished" ? "°" : "") };
  });
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function newSet(n) {
  return { id: newId(), name: "Set " + n, songs: [] };
}

function newProgram(name) {
  return { id: newId(), name, createdAt: Date.now(), sets: [newSet(1)] };
}

/**
 * Programs saved before dates were tracked: newId() starts with a base-36
 * timestamp, so the creation time can be read back out of the id.
 */
function backfillCreatedAt(data) {
  let changed = false;
  for (const p of data.programs) {
    if (typeof p.createdAt === "number") continue;
    const t = parseInt(String(p.id).slice(0, -5), 36);
    const plausible = t > Date.UTC(2024, 0, 1) && t < Date.now() + 864e5;
    p.createdAt = plausible ? t : Date.now();
    changed = true;
  }
  return changed;
}

function loadPrograms() {
  try {
    const data = JSON.parse(localStorage.getItem(PROGRAMS_STORAGE));
    if (data && Array.isArray(data.programs) && data.programs.length) return data;
  } catch (e) {
    /* missing or unreadable - fall through */
  }
  // v1 data: each old set list was really named for a show, so it becomes a
  // program of that name with its songs in "Set 1".
  try {
    const old = JSON.parse(localStorage.getItem(LEGACY_SETS_STORAGE));
    if (old && Array.isArray(old.sets) && old.sets.length) {
      const programs = old.sets.map((s) => ({
        id: s.id,
        name: s.name || "Untitled program",
        sets: [{ id: newId(), name: "Set 1", songs: Array.isArray(s.songs) ? s.songs : [] }],
      }));
      return { activeId: old.activeId, programs };
    }
  } catch (e) {
    /* ignore */
  }
  const p = newProgram("My program");
  return { activeId: p.id, programs: [p] };
}

const progData = loadPrograms();
if (backfillCreatedAt(progData)) {
  try {
    localStorage.setItem(PROGRAMS_STORAGE, JSON.stringify(progData));
  } catch (e) {
    /* ignore */
  }
}
const setsUI = {
  editing: false,
  armed: null, // id of the program/set waiting for a second "delete" tap
  addingTo: null, // id of the set whose add-song form is open
  level: (() => {
    try {
      return localStorage.getItem(SETS_LEVEL_STORAGE) || "full";
    } catch (e) {
      return "full";
    }
  })(),
  lastKey: { pc: 7, minor: false },
};
const setEls = {
  picker: document.getElementById("program-picker"),
  nameInput: document.getElementById("program-name-input"),
  editBtn: document.getElementById("program-edit"),
  newBtn: document.getElementById("program-new"),
  deleteBtn: document.getElementById("program-delete"),
  count: document.getElementById("program-count"),
  levelBtn: document.getElementById("set-level"),
  addForm: document.getElementById("song-add"),
  addTitle: document.getElementById("song-add-title"),
  addKey: document.getElementById("song-add-key"),
  sections: document.getElementById("set-sections"),
};

const setJumps = document.getElementById("set-jumps");

function saveSets() {
  try {
    localStorage.setItem(PROGRAMS_STORAGE, JSON.stringify(progData));
  } catch (e) {
    setStatus("sets", "Couldn't save on this device", true);
  }
}

/**
 * A set can't be empty: drop empty sets (except the one being filled right
 * now, and a program's only set) and keep default "Set N" names in order.
 */
function normalizeProgram(prog) {
  let changed = false;
  const kept = prog.sets.filter((s) => s.songs.length || s.id === setsUI.addingTo);
  if (!kept.length) kept.push(prog.sets[0] || newSet(1));
  if (kept.length !== prog.sets.length) changed = true;
  prog.sets = kept;
  prog.sets.forEach((s, i) => {
    if (/^Set \d+$/.test(s.name) && s.name !== "Set " + (i + 1)) {
      s.name = "Set " + (i + 1);
      changed = true;
    }
  });
  if (changed) saveSets();
}

function activeProgram() {
  return progData.programs.find((p) => p.id === progData.activeId) || progData.programs[0];
}

function fillKeySelect(select, key) {
  if (!select.options.length) {
    for (const minor of [false, true]) {
      const group = document.createElement("optgroup");
      group.label = minor ? "Minor" : "Major";
      for (let pc = 0; pc < 12; pc++) {
        const opt = document.createElement("option");
        opt.value = pc + ":" + (minor ? 1 : 0);
        opt.textContent = keyName({ pc, minor }).replace(" major", "").replace(" minor", "m");
        group.appendChild(opt);
      }
      select.appendChild(group);
    }
  }
  select.value = key.pc + ":" + (key.minor ? 1 : 0);
}

function readKeySelect(select) {
  const [pc, m] = select.value.split(":");
  return { pc: Number(pc), minor: m === "1" };
}

function iconButton(cls, label, text, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "icon-btn" + (cls ? " " + cls : "");
  b.setAttribute("aria-label", label);
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

function plural(n, word) {
  return n + " " + word + (n === 1 ? "" : "s");
}

function renderSets() {
  const prog = activeProgram();
  progData.activeId = prog.id;
  if (setsUI.editing || !prog.sets.some((s) => s.id === setsUI.addingTo)) setsUI.addingTo = null;
  normalizeProgram(prog);
  const songTotal = prog.sets.reduce((n, s) => n + s.songs.length, 0);

  // Header: program picker, or the name field while editing.
  setEls.picker.textContent = prog.name || "Untitled program";
  setEls.picker.hidden = setsUI.editing;
  if (setsUI.editing) closeProgramMenu();
  setEls.nameInput.hidden = !setsUI.editing;
  if (setsUI.editing && document.activeElement !== setEls.nameInput) setEls.nameInput.value = prog.name;
  setEls.editBtn.textContent = setsUI.editing ? "Done" : "Edit";
  setEls.editBtn.setAttribute("aria-pressed", setsUI.editing ? "true" : "false");
  setEls.newBtn.hidden = setsUI.editing;
  setEls.deleteBtn.hidden = !setsUI.editing;
  const progArmed = setsUI.armed === prog.id;
  setEls.deleteBtn.textContent = progArmed ? "Tap again to delete" : "Delete program";
  setEls.deleteBtn.classList.toggle("armed", progArmed);
  setEls.count.textContent = plural(prog.sets.length, "set") + " · " + plural(songTotal, "song");
  setEls.levelBtn.textContent = LEVEL_LABELS[setsUI.level] || LEVEL_LABELS.full;
  setEls.levelBtn.hidden = !PREFS.chords.on || setsUI.editing;
  setJumps.hidden = setsUI.editing;
  document.getElementById("set-add-top").hidden = setsUI.editing;

  const scrollTop = setEls.sections.scrollTop;
  setEls.addForm.remove();
  setEls.sections.innerHTML = "";
  prog.sets.forEach((set, si) => setEls.sections.appendChild(setSection(prog, set, si)));

  const addSet = document.createElement("button");
  addSet.type = "button";
  addSet.className = "add-set-btn";
  addSet.textContent = "+ Add set";
  addSet.addEventListener("click", addNewSet);
  setEls.sections.appendChild(addSet);
  setEls.sections.scrollTop = scrollTop;
  renderSetJumps(prog);
  syncMainButton();
}

function setSection(prog, set, si) {
  const sec = document.createElement("section");
  sec.className = "set-block";
  sec.dataset.setId = set.id;

  const head = document.createElement("div");
  head.className = "set-block-head";
  if (setsUI.editing) {
    const name = document.createElement("input");
    name.className = "set-name-input";
    name.type = "text";
    name.maxLength = 40;
    name.value = set.name;
    name.setAttribute("aria-label", "Set name");
    name.addEventListener("input", () => {
      set.name = name.value.trim() || "Set " + (si + 1);
      saveSets();
    });
    head.appendChild(name);
    const armed = setsUI.armed === set.id;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "pill-btn danger" + (armed ? " armed" : "");
    del.textContent = armed ? "Tap again" : "Delete set";
    del.addEventListener("click", () => {
      if (!armed && set.songs.length) {
        setsUI.armed = set.id;
        renderSets();
        return;
      }
      prog.sets.splice(si, 1);
      if (!prog.sets.length) prog.sets.push(newSet(1));
      setsUI.armed = null;
      saveSets();
      renderSets();
    });
    head.appendChild(del);
  } else {
    const name = document.createElement("span");
    name.className = "set-block-name";
    name.textContent = set.name;
    const count = document.createElement("span");
    count.className = "set-block-count";
    count.textContent = plural(set.songs.length, "song");
    const add = document.createElement("button");
    add.type = "button";
    add.className = "pill-btn";
    add.textContent = setsUI.addingTo === set.id ? "Close" : "+ Song";
    add.addEventListener("click", () => openAddSong(setsUI.addingTo === set.id ? null : set.id));
    head.append(name, count, add);
  }
  sec.appendChild(head);

  const list = document.createElement("ol");
  list.className = "song-list";
  set.songs.forEach((song, i) => list.appendChild(songRow(prog, si, song, i)));
  if (!set.songs.length && setsUI.addingTo !== set.id) {
    const li = document.createElement("li");
    li.className = "song-empty";
    li.textContent = setsUI.editing ? "No songs in this set" : "No songs yet — tap + Song";
    list.appendChild(li);
  }
  sec.appendChild(list);

  if (setsUI.addingTo === set.id) {
    fillKeySelect(setEls.addKey, setsUI.lastKey);
    sec.appendChild(setEls.addForm);
  }
  return sec;
}

/** Moves a song one step up/down, crossing into the neighbouring set at the ends. */
function moveSong(prog, si, i, delta) {
  const songs = prog.sets[si].songs;
  const j = i + delta;
  if (j >= 0 && j < songs.length) {
    [songs[i], songs[j]] = [songs[j], songs[i]];
  } else {
    const target = prog.sets[si + delta];
    if (!target) return;
    const [song] = songs.splice(i, 1);
    if (delta < 0) target.songs.push(song);
    else target.songs.unshift(song);
  }
  saveSets();
  renderSets();
}

function songRow(prog, si, song, i) {
  const set = prog.sets[si];
  const li = document.createElement("li");
  li.className = "song";
  if (!song.id) song.id = newId();
  li.dataset.songId = song.id;

  const top = document.createElement("div");
  top.className = "song-top";
  const grip = document.createElement("span");
  grip.className = "drag-handle";
  grip.title = "Drag to reorder";
  grip.setAttribute("aria-hidden", "true");
  grip.addEventListener("pointerdown", (e) => startSongDrag(e, li));
  const num = document.createElement("span");
  num.className = "song-num";
  num.textContent = i + 1;
  top.append(grip, num);

  if (setsUI.editing) {
    const title = document.createElement("input");
    title.className = "song-title-input";
    title.type = "text";
    title.maxLength = 80;
    title.value = song.title;
    title.setAttribute("aria-label", "Song title");
    title.addEventListener("change", () => {
      song.title = title.value.trim() || song.title;
      saveSets();
    });
    top.appendChild(title);
    const up = iconButton("", "Move up", "↑", () => moveSong(prog, si, i, -1));
    up.disabled = si === 0 && i === 0;
    const down = iconButton("", "Move down", "↓", () => moveSong(prog, si, i, 1));
    down.disabled = si === prog.sets.length - 1 && i === set.songs.length - 1;
    const del = iconButton("danger", "Remove song", "✕", () => {
      set.songs.splice(i, 1);
      saveSets();
      renderSets();
    });
    top.append(up, down, del);
    li.appendChild(top);
    return li;
  }

  const title = document.createElement("span");
  title.className = "song-title";
  title.textContent = song.title;
  top.appendChild(title);

  const chordRow = document.createElement("ol");
  chordRow.className = "chord-row compact";
  chordRow.hidden = !PREFS.chords.on;

  const keyBox = document.createElement("div");
  keyBox.className = "song-key";
  const select = document.createElement("select");
  select.className = "key-select";
  select.setAttribute("aria-label", "Key for " + song.title);
  fillKeySelect(select, song.key);
  const setKey = (key) => {
    song.key = key;
    setsUI.lastKey = key;
    saveSets();
    select.value = key.pc + ":" + (key.minor ? 1 : 0);
    renderSongChords(chordRow, song.key);
  };
  select.addEventListener("change", () => setKey(readKeySelect(select)));
  const down = iconButton("", "Key down a semitone", "−", () => setKey({ pc: mod12(song.key.pc - 1), minor: song.key.minor }));
  const up = iconButton("", "Key up a semitone", "+", () => setKey({ pc: mod12(song.key.pc + 1), minor: song.key.minor }));
  keyBox.append(down, select, up);
  top.appendChild(keyBox);
  li.appendChild(top);

  renderSongChords(chordRow, song.key);
  li.appendChild(chordRow);
  return li;
}

function renderSongChords(row, key) {
  row.innerHTML = "";
  const all = keyChords(key);
  for (const d of LEVEL_DEGREES[setsUI.level] || LEVEL_DEGREES.full) {
    const chord = all[d - 1];
    const li = document.createElement("li");
    li.className = "chord-chip quality-" + chord.quality;
    const roman = document.createElement("span");
    roman.className = "roman";
    roman.textContent = chord.roman;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = chord.label;
    li.append(roman, name);
    row.appendChild(li);
  }
}

// ---------- Set shortcuts (jump buttons next to "+ Set") ----------


function renderSetJumps(prog) {
  setJumps.innerHTML = "";
  prog.sets.forEach((set) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "jump-chip";
    b.dataset.setId = set.id;
    b.textContent = set.name;
    b.addEventListener("click", () => scrollToSet(set.id));
    setJumps.appendChild(b);
  });
  syncActiveJump();
}

function scrollToSet(setId) {
  const block = setEls.sections.querySelector('.set-block[data-set-id="' + setId + '"]');
  if (!block) return;
  const top = block.getBoundingClientRect().top - setEls.sections.getBoundingClientRect().top + setEls.sections.scrollTop;
  setEls.sections.scrollTo({ top: Math.max(0, top - 2), behavior: "smooth" });
}

/** Highlights the shortcut of the set at the top of the list (scroll spy). */
function syncActiveJump() {
  if (!setEls.sections.clientHeight) return; // Sets view hidden: nothing laid out
  const top = setEls.sections.getBoundingClientRect().top + 48;
  let current = null;
  for (const block of setEls.sections.querySelectorAll(".set-block")) {
    if (!current || block.getBoundingClientRect().top <= top) current = block;
  }
  // Scrolled to the very bottom: the last set is the one being looked at.
  const s = setEls.sections;
  if (s.scrollTop > 0 && s.scrollTop + s.clientHeight >= s.scrollHeight - 2) {
    const blocks = s.querySelectorAll(".set-block");
    current = blocks[blocks.length - 1] || current;
  }
  const id = current && current.dataset.setId;
  for (const chip of setJumps.children) {
    const on = chip.dataset.setId === id;
    if (on && !chip.classList.contains("active")) {
      // Keep the active shortcut visible in the strip (no page scroll).
      const cr = chip.getBoundingClientRect();
      const sr = setJumps.getBoundingClientRect();
      if (cr.left < sr.left || cr.right > sr.right) {
        setJumps.scrollBy({ left: cr.left - sr.left - (sr.width - cr.width) / 2, behavior: "smooth" });
      }
    }
    chip.classList.toggle("active", on);
  }
}

let jumpSpyQueued = false;
setEls.sections.addEventListener("scroll", () => {
  if (jumpSpyQueued) return;
  jumpSpyQueued = true;
  requestAnimationFrame(() => {
    jumpSpyQueued = false;
    syncActiveJump();
  });
});

/** Appends a new set to the program and opens its add-song form. */
function addNewSet() {
  const prog = activeProgram();
  const set = newSet(prog.sets.length + 1);
  prog.sets.push(set);
  saveSets();
  setsUI.editing = false;
  setsUI.armed = null;
  setsUI.addingTo = set.id;
  renderSets();
  setEls.addForm.scrollIntoView({ block: "nearest" });
  setEls.addTitle.focus();
}

document.getElementById("set-add-top").addEventListener("click", addNewSet);

/** Opens the add-song form under a set (null closes it). */
function openAddSong(setId) {
  setsUI.editing = false;
  setsUI.armed = null;
  setsUI.addingTo = setId;
  renderSets();
  if (setId) {
    setEls.addForm.scrollIntoView({ block: "nearest" });
    setEls.addTitle.focus();
  }
}

// ---------- Program menu (search + sort) ----------

const PROGRAM_SORT_STORAGE = "tonic.programSort";
const PROGRAM_SORTS = {
  newest: { label: "Newest", cmp: (a, b) => b.createdAt - a.createdAt },
  oldest: { label: "Oldest", cmp: (a, b) => a.createdAt - b.createdAt },
  name: { label: "A–Z", cmp: (a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base", numeric: true }) },
};
const menuEls = {
  menu: document.getElementById("program-menu"),
  search: document.getElementById("program-search"),
  sort: document.getElementById("program-sort"),
  list: document.getElementById("program-list"),
};
let programSort = "newest";
try {
  const v = localStorage.getItem(PROGRAM_SORT_STORAGE);
  if (v && PROGRAM_SORTS[v]) programSort = v;
} catch (e) {
  /* ignore */
}

function formatDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function renderProgramMenu() {
  menuEls.sort.textContent = "Sort: " + PROGRAM_SORTS[programSort].label;
  const q = menuEls.search.value.trim().toLowerCase();
  const items = progData.programs
    .filter((p) => !q || (p.name || "").toLowerCase().includes(q))
    .sort(PROGRAM_SORTS[programSort].cmp);
  menuEls.list.innerHTML = "";
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "program-empty";
    li.textContent = "No programs match “" + menuEls.search.value.trim() + "”";
    menuEls.list.appendChild(li);
    return;
  }
  for (const p of items) {
    const li = document.createElement("li");
    li.className = "program-item" + (p.id === progData.activeId ? " current" : "");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", p.id === progData.activeId ? "true" : "false");
    li.tabIndex = 0;
    const name = document.createElement("span");
    name.className = "program-item-name";
    name.textContent = p.name || "Untitled program";
    const songs = p.sets.reduce((n, s) => n + s.songs.length, 0);
    const meta = document.createElement("span");
    meta.className = "program-item-meta";
    meta.textContent = formatDate(p.createdAt) + " · " + plural(p.sets.length, "set") + " · " + plural(songs, "song");
    li.append(name, meta);
    const choose = () => {
      progData.activeId = p.id;
      setsUI.addingTo = null;
      saveSets();
      closeProgramMenu();
      setEls.sections.scrollTop = 0;
      renderSets();
    };
    li.addEventListener("click", choose);
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        choose();
      }
    });
    menuEls.list.appendChild(li);
  }
}

function openProgramMenu() {
  menuEls.search.value = "";
  renderProgramMenu();
  menuEls.menu.hidden = false;
  setEls.picker.setAttribute("aria-expanded", "true");
  // Only jump to the search box when there's enough to search through - on
  // a phone, focusing it pops the keyboard over the list.
  if (progData.programs.length > 6) menuEls.search.focus();
}

function closeProgramMenu() {
  if (menuEls.menu.hidden) return;
  menuEls.menu.hidden = true;
  setEls.picker.setAttribute("aria-expanded", "false");
}

setEls.picker.addEventListener("click", () => {
  if (menuEls.menu.hidden) openProgramMenu();
  else closeProgramMenu();
});
menuEls.search.addEventListener("input", renderProgramMenu);
menuEls.search.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const first = menuEls.list.querySelector(".program-item");
    if (first) first.click();
  }
});
menuEls.sort.addEventListener("click", () => {
  const order = Object.keys(PROGRAM_SORTS);
  programSort = order[(order.indexOf(programSort) + 1) % order.length];
  try {
    localStorage.setItem(PROGRAM_SORT_STORAGE, programSort);
  } catch (e) {
    /* ignore */
  }
  renderProgramMenu();
});
document.addEventListener("pointerdown", (e) => {
  if (!menuEls.menu.hidden && !menuEls.menu.contains(e.target) && !setEls.picker.contains(e.target)) closeProgramMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeProgramMenu();
});

setEls.newBtn.addEventListener("click", () => {
  const p = newProgram("Program " + (progData.programs.length + 1));
  progData.programs.push(p);
  progData.activeId = p.id;
  saveSets();
  setsUI.editing = true; // straight into naming it
  setEls.sections.scrollTop = 0;
  renderSets();
  setEls.nameInput.focus();
  setEls.nameInput.select();
});

setEls.editBtn.addEventListener("click", () => {
  setsUI.editing = !setsUI.editing;
  setsUI.armed = null;
  renderSets();
});

setEls.nameInput.addEventListener("input", () => {
  activeProgram().name = setEls.nameInput.value.trim() || "Untitled program";
  saveSets();
});
setEls.nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") setEls.nameInput.blur();
});

setEls.deleteBtn.addEventListener("click", () => {
  const prog = activeProgram();
  if (setsUI.armed !== prog.id) {
    setsUI.armed = prog.id;
    renderSets();
    return;
  }
  progData.programs = progData.programs.filter((p) => p.id !== prog.id);
  if (!progData.programs.length) progData.programs.push(newProgram("My program"));
  progData.activeId = progData.programs[0].id;
  setsUI.armed = null;
  setsUI.editing = false;
  saveSets();
  renderSets();
});

// One compact button instead of four tabs (keeps the row free for the set
// shortcuts): each tap steps Easy -> Med -> Hard -> All -> Easy.
setEls.levelBtn.addEventListener("click", () => {
  const order = Object.keys(LEVEL_LABELS);
  setsUI.level = order[(order.indexOf(setsUI.level) + 1) % order.length];
  try {
    localStorage.setItem(SETS_LEVEL_STORAGE, setsUI.level);
  } catch (e) {
    /* ignore */
  }
  renderSets();
});

setEls.addForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const title = setEls.addTitle.value.trim();
  if (!title) {
    setEls.addTitle.focus();
    return;
  }
  const set = activeProgram().sets.find((s) => s.id === setsUI.addingTo);
  if (!set) return;
  const key = readKeySelect(setEls.addKey);
  setsUI.lastKey = key;
  set.songs.push({ id: newId(), title, key });
  saveSets();
  setEls.addTitle.value = "";
  renderSets(); // form stays open under the same set for the next song
  setEls.addForm.scrollIntoView({ block: "nearest" });
  setEls.addTitle.focus();
});

/** True while the dock's floating button acts as "Done" (adding or editing). */
function setsSaveMode() {
  return setsUI.editing || !!setsUI.addingTo;
}

/**
 * Dock main button in Sets view: "+" opens the add form on the last set;
 * while adding/editing it's "Done" - keeps any title typed so far, then
 * closes the form / leaves edit mode.
 */
function toggleAddSong() {
  if (setsUI.editing) {
    setsUI.editing = false;
    setsUI.armed = null;
    renderSets();
    return;
  }
  if (setsUI.addingTo) {
    const title = setEls.addTitle.value.trim();
    const set = activeProgram().sets.find((s) => s.id === setsUI.addingTo);
    if (title && set) {
      const key = readKeySelect(setEls.addKey);
      setsUI.lastKey = key;
      set.songs.push({ id: newId(), title, key });
      saveSets();
    }
    setEls.addTitle.value = "";
    setEls.addTitle.blur();
    openAddSong(null);
    return;
  }
  const sets = activeProgram().sets;
  openAddSong(sets[sets.length - 1].id);
}

// ---------- Drag to reorder songs ----------
//
// Grab a song by its grip and drag: it follows the finger, the list reflows
// live, and dropping it in another set moves it there. Pointer events on a
// touch-action:none grip, so it works with touch (HTML5 drag-and-drop
// doesn't on mobile) without fighting the list's own scrolling.

let songDrag = null;

function startSongDrag(e, li) {
  if (songDrag || (e.pointerType === "mouse" && e.button !== 0)) return;
  e.preventDefault();
  const r = li.getBoundingClientRect();
  songDrag = { li, pointerId: e.pointerId, grabY: e.clientY - r.top, y: e.clientY, raf: 0 };
  li.classList.add("dragging");
  setEls.sections.classList.add("drag-active");
  window.addEventListener("pointermove", onSongDragMove, { passive: false });
  window.addEventListener("pointerup", endSongDrag);
  window.addEventListener("pointercancel", endSongDrag);
  songDrag.raf = requestAnimationFrame(songDragFrame);
}

function onSongDragMove(e) {
  if (!songDrag || e.pointerId !== songDrag.pointerId) return;
  e.preventDefault();
  songDrag.y = e.clientY;
}

function songDragFrame() {
  if (!songDrag) return;
  const { li, y } = songDrag;
  const box = setEls.sections.getBoundingClientRect();

  // Auto-scroll near the edges of the list.
  const edge = 56;
  if (y < box.top + edge) setEls.sections.scrollTop -= Math.ceil((box.top + edge - y) / 6);
  else if (y > box.bottom - edge) setEls.sections.scrollTop += Math.ceil((y - (box.bottom - edge)) / 6);

  // Which set is under the finger (the one above, if between sets)?
  const blocks = Array.from(setEls.sections.querySelectorAll(".set-block"));
  let block = blocks[0];
  for (const b of blocks) {
    if (b.getBoundingClientRect().top <= y) block = b;
  }
  const list = block.querySelector(".song-list");
  const others = Array.from(list.querySelectorAll(".song")).filter((x) => x !== li);
  const before = others.find((x) => {
    const r = x.getBoundingClientRect();
    return y < r.top + r.height / 2;
  });
  const empty = list.querySelector(".song-empty");
  if (empty) empty.remove();
  if (before) {
    if (li.nextElementSibling !== before) list.insertBefore(li, before);
  } else if (li.parentNode !== list || li.nextElementSibling) {
    list.appendChild(li);
  }

  // Keep the card under the finger wherever it now sits in the flow.
  li.style.transform = "";
  const natural = li.getBoundingClientRect().top;
  li.style.transform = "translateY(" + (y - songDrag.grabY - natural) + "px)";
  songDrag.raf = requestAnimationFrame(songDragFrame);
}

function endSongDrag(e) {
  if (!songDrag || (e && e.pointerId !== songDrag.pointerId)) return;
  cancelAnimationFrame(songDrag.raf);
  window.removeEventListener("pointermove", onSongDragMove);
  window.removeEventListener("pointerup", endSongDrag);
  window.removeEventListener("pointercancel", endSongDrag);
  songDrag.li.classList.remove("dragging");
  songDrag.li.style.transform = "";
  setEls.sections.classList.remove("drag-active");
  songDrag = null;

  // Read the new order back from the DOM.
  const prog = activeProgram();
  const byId = new Map();
  for (const set of prog.sets) for (const song of set.songs) byId.set(song.id, song);
  for (const block of setEls.sections.querySelectorAll(".set-block")) {
    const set = prog.sets.find((x) => x.id === block.dataset.setId);
    if (!set) continue;
    set.songs = Array.from(block.querySelectorAll(".song"))
      .map((el) => byId.get(el.dataset.songId))
      .filter(Boolean);
  }
  saveSets();
  renderSets();
}

renderSets();
