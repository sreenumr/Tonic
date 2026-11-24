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
  picking: null, // id of the song whose planned chords are being picked
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
  const hasSheet = !!(song.sheet && song.sheet.text && song.sheet.text.trim());
  const sheetBtn = iconButton("sheet-btn" + (hasSheet ? " has-sheet" : ""), hasSheet ? "Open chord sheet" : "Add a chord sheet", "", () =>
    openSheet(song, set, i),
  );
  sheetBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M10 11h5M10 14.5h5M10 18h3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  top.append(title, sheetBtn);

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
    renderSongChords(chordRow, song);
  };
  select.addEventListener("change", () => setKey(readKeySelect(select)));
  const down = iconButton("", "Key down a semitone", "−", () => setKey({ pc: mod12(song.key.pc - 1), minor: song.key.minor }));
  const up = iconButton("", "Key up a semitone", "+", () => setKey({ pc: mod12(song.key.pc + 1), minor: song.key.minor }));
  keyBox.append(down, select, up);
  top.appendChild(keyBox);
  li.appendChild(top);

  renderSongChords(chordRow, song);
  li.appendChild(chordRow);
  return li;
}

/**
 * A song's planned chords are stored as scale degrees (1-7), not names, so
 * they follow the song when its key changes.
 */
function songPlan(song) {
  if (!Array.isArray(song.plan)) song.plan = [];
  return song.plan;
}

/** Plan view by default once a song has planned chords; the toggle overrides. */
function showsPlan(song) {
  return typeof song.showPlan === "boolean" ? song.showPlan : songPlan(song).length > 0;
}

function chordChip(chord, tag) {
  const li = document.createElement(tag || "li");
  li.className = "chord-chip quality-" + chord.quality;
  const roman = document.createElement("span");
  roman.className = "roman";
  roman.textContent = chord.roman;
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = chord.label;
  li.append(roman, name);
  return li;
}

/** Small button at the start/end of a chord row. */
function rowButton(cls, label, html, onClick) {
  const li = document.createElement("li");
  li.className = "row-btn-wrap";
  const b = document.createElement("button");
  b.type = "button";
  b.className = "row-btn " + cls;
  b.setAttribute("aria-label", label);
  b.innerHTML = html;
  b.addEventListener("click", onClick);
  li.appendChild(b);
  return li;
}

/**
 * The chord row under a song: either the key's scale chords (filtered by the
 * Easy/Medium/... level) or the chords planned for this song - one toggle,
 * same single row, so the card doesn't grow.
 */
/**
 * Drag a planned chord sideways to change the playing order. A short press
 * without movement stays a tap (remove the chord).
 */
function startChordDrag(e, li, row, song) {
  if (e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  let offset = 0;
  const picked = () => [...row.querySelectorAll("li.draggable")];

  const move = (ev) => {
    const dx = ev.clientX - startX;
    if (!dragging) {
      if (Math.abs(ev.clientY - startY) > 10) return end(); // vertical: let the list scroll
      if (Math.abs(dx) < 8) return;
      dragging = true;
      li.dataset.dragged = "1";
      li.classList.add("dragging");
      try {
        li.setPointerCapture(ev.pointerId);
      } catch (err) {
        /* ignore */
      }
    }
    ev.preventDefault();
    // Swap with a neighbour once the dragged chip passes its middle.
    const x = ev.clientX;
    const others = picked();
    const idx = others.indexOf(li);
    const prev = others[idx - 1];
    const next = others[idx + 1];
    if (prev && x < prev.getBoundingClientRect().left + prev.offsetWidth / 2) {
      const before = li.getBoundingClientRect().left;
      row.insertBefore(li, prev);
      offset += before - li.getBoundingClientRect().left;
    } else if (next && x > next.getBoundingClientRect().left + next.offsetWidth / 2) {
      const before = li.getBoundingClientRect().left;
      row.insertBefore(li, next.nextSibling);
      offset += before - li.getBoundingClientRect().left;
    }
    li.style.transform = "translateX(" + (dx + offset) + "px)";
  };

  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    if (!dragging) return;
    song.plan = picked().map((el) => Number(el.dataset.degree));
    saveSets();
    // Let the click that follows pointerup see the drag flag, then redraw.
    setTimeout(() => renderSongChords(row, song), 0);
  };

  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

function renderSongChords(row, song) {
  row.innerHTML = "";
  const all = keyChords(song.key);
  const plan = songPlan(song);
  const rerender = () => renderSongChords(row, song);

  // Picking: the planned chords first, in playing order (drag sideways to
  // reorder), then the key's other chords dimmed; tap to add/remove.
  if (setsUI.picking === song.id) {
    row.classList.add("picking");
    const ordered = [...plan.filter((d) => all[d - 1]).map((d) => all[d - 1]), ...all.filter((c) => !plan.includes(c.degree))];
    for (const chord of ordered) {
      const at = plan.indexOf(chord.degree);
      const chip = chordChip(chord, "button");
      chip.type = "button";
      chip.classList.toggle("picked", at >= 0);
      chip.setAttribute("aria-pressed", at >= 0 ? "true" : "false");
      if (at >= 0) chip.querySelector(".roman").textContent = String(at + 1);
      const li = document.createElement("li");
      li.className = "chip-wrap";
      li.dataset.degree = chord.degree;
      chip.addEventListener("click", () => {
        if (li.dataset.dragged) return; // the tap ended a drag
        const i = plan.indexOf(chord.degree);
        if (i >= 0) plan.splice(i, 1);
        else plan.push(chord.degree);
        saveSets();
        rerender();
      });
      if (at >= 0) {
        li.classList.add("draggable");
        li.addEventListener("pointerdown", (e) => startChordDrag(e, li, row, song));
      }
      li.appendChild(chip);
      row.appendChild(li);
    }
    row.appendChild(
      rowButton("done", "Done picking chords", "✓", () => {
        setsUI.picking = null;
        song.showPlan = true;
        saveSets();
        rerender();
      }),
    );
    return;
  }
  row.classList.remove("picking");

  const planView = showsPlan(song);
  row.appendChild(
    rowButton(
      "view" + (planView ? " plan" : ""),
      planView ? "Showing planned chords - show scale chords" : "Showing scale chords - show planned chords",
      '<span class="' + (planView ? "" : "on") + '">Scale</span><span class="' + (planView ? "on" : "") + '">Plan</span>',
      () => {
        song.showPlan = !planView;
        saveSets();
        rerender();
      },
    ),
  );

  if (!planView) {
    for (const d of LEVEL_DEGREES[setsUI.level] || LEVEL_DEGREES.full) row.appendChild(chordChip(all[d - 1]));
    return;
  }

  const pick = () => {
    setsUI.picking = song.id;
    rerender();
  };
  if (!plan.length) {
    const li = document.createElement("li");
    li.className = "plan-empty-wrap";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "plan-empty";
    b.textContent = "+ Pick the chords you'll play";
    b.addEventListener("click", pick);
    li.appendChild(b);
    row.appendChild(li);
    return;
  }
  for (const d of plan) if (all[d - 1]) row.appendChild(chordChip(all[d - 1]));
  row.appendChild(rowButton("edit", "Edit planned chords", "✎", pick));
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

// ---------- Chord sheets (lyrics + chords, transposed to the song's key) ----------
//
// The pasted text is stored as-is with the key its chords were written in
// (song.sheet = { text, key }). It's parsed every time it's shown, and each
// chord is moved by (song key - written key), so changing the song's key
// changes the sheet too.

const NOTE_PCS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const FLAT_NAMES = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];
// Out-of-key chords in C major / A minor: the names players actually use.
const NEUTRAL_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
const CHORD_RE = /^([A-G])([#b♯♭]?)([^\s/]*)(?:\/([A-G])([#b♯♭]?))?$/;
const SUFFIX_RE = /^(?:maj|min|m|M|dim|aug|sus|add|no|°|ø|\+|-|\d|\(|\)|b|#|♭|♯|,)*$/;
const BAR_TOKENS = /^(\|+|-+|\/|%|x\d+|\(?x\d+\)?|N\.?C\.?|\(|\))$/i;
const SECTION_RE = /^\s*(?:\[\s*([^\]]+?)\s*\]|((?:intro|verse|pre-?chorus|chorus|bridge|interlude|outro|hook|solo|antara|mukhda|refrain|tag|coda)\b[^:]*):?)\s*$/i;

function accidental(a) {
  return a === "#" || a === "♯" ? 1 : a === "b" || a === "♭" ? -1 : 0;
}

/** "F#m7/C#" -> { pc, quality, suffix, bass } or null if it isn't a chord. */
function parseChord(token) {
  const m = CHORD_RE.exec(token.replace(/^\(|\)$/g, ""));
  if (!m || !SUFFIX_RE.test(m[3])) return null;
  const s = m[3];
  const quality = /^(dim|°|ø|m7b5|m7♭5)/.test(s) ? "diminished" : /^(m(?!aj)|min|-)/.test(s) ? "minor" : "major";
  return {
    pc: mod12(NOTE_PCS[m[1]] + accidental(m[2])),
    quality,
    suffix: s,
    bass: m[4] ? mod12(NOTE_PCS[m[4]] + accidental(m[5])) : null,
  };
}

function isChordLine(line) {
  const tokens = line.trim().split(/\s+/).filter((t) => t && !BAR_TOKENS.test(t));
  return tokens.length > 0 && tokens.every((t) => parseChord(t));
}

/**
 * Text -> lines of segments. Handles both "chords on the line above the
 * lyrics" (what chord sites show) and inline "[G]lyrics".
 */
function parseSheet(text) {
  const raw = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  const lines = [];
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i].replace(/\s+$/, "");
    if (!line.trim()) {
      lines.push({ type: "blank" });
      continue;
    }
    const sec = SECTION_RE.exec(line);
    if (sec && !parseChord((sec[1] || "").trim())) {
      lines.push({ type: "label", text: (sec[1] || sec[2]).trim() });
      continue;
    }
    if (isChordLine(line)) {
      // Chord positions within the line.
      const chords = [];
      const re = /\S+/g;
      let m;
      while ((m = re.exec(line))) chords.push({ at: m.index, token: m[0], chord: parseChord(m[0]) });
      const next = raw[i + 1] !== undefined ? raw[i + 1].replace(/\s+$/, "") : "";
      const lyricBelow = next.trim() && !isChordLine(next) && !SECTION_RE.test(next) && !/\[[^\]]+\]/.test(next);
      if (lyricBelow) {
        // Cut the lyric line at each chord's column.
        const lyric = next.padEnd(line.length);
        const real = chords.filter((c) => c.chord);
        const segs = [];
        if (real.length && real[0].at > 0) segs.push({ chord: null, text: lyric.slice(0, real[0].at) });
        real.forEach((c, k) => {
          const end = k + 1 < real.length ? real[k + 1].at : lyric.length;
          segs.push({ chord: c.chord, text: lyric.slice(c.at, end), src: { line: i, at: c.at, len: c.token.length, inline: false } });
        });
        lines.push({ type: "lyric", segs });
        i++;
      } else {
        lines.push({
          type: "chords",
          segs: chords.map((c) =>
            c.chord ? { chord: c.chord, text: "", src: { line: i, at: c.at, len: c.token.length, inline: false } } : { chord: null, text: c.token },
          ),
        });
      }
      continue;
    }
    // Inline [G] chords (or plain lyrics).
    const segs = [];
    const parts = line.split(/\[([^\]]*)\]/);
    let pending = null; // { chord, src } of a [chord] waiting for its text
    let col = 0; // column of `part` in the line (for editing a chord in place)
    const push = (text) => {
      segs.push(pending ? { chord: pending.chord, src: pending.src, text } : { chord: null, text });
      pending = null;
    };
    parts.forEach((part, k) => {
      if (k % 2 === 1) {
        const chord = parseChord(part.trim());
        if (chord) {
          if (pending) push("");
          pending = { chord, src: { line: i, at: col, len: part.length + 2, inline: true } };
        } else {
          push("[" + part + "]");
        }
        col += part.length + 2;
      } else {
        if (part || pending) push(part);
        col += part.length;
      }
    });
    if (pending) push("");
    const onlyChords = segs.every((s) => !s.text.trim());
    lines.push({ type: onlyChords ? "chords" : "lyric", segs });
  }
  return lines;
}

function sheetChords(text) {
  const out = [];
  for (const line of parseSheet(text)) for (const s of line.segs || []) if (s.chord) out.push(s.chord);
  return out;
}

/** Scale degree (1-7) of a chord in a key, or 0 if it's outside the key. */
function chordDegree(chord, key) {
  const scale = SCALES[key.minor ? "minor" : "major"];
  for (let d = 0; d < 7; d++) {
    if (mod12(key.pc + scale.steps[d]) === chord.pc && scale.qual[d] === chord.quality) return d + 1;
  }
  return 0;
}

/** Best-fitting key for a list of chords: most chords in the key, first/last chord on the tonic. */
function guessKey(chords, prefer) {
  if (!chords.length) return prefer;
  let best = prefer;
  let bestScore = -1;
  const candidates = [prefer];
  for (const minor of [false, true]) for (let pc = 0; pc < 12; pc++) candidates.push({ pc, minor });
  for (const key of candidates) {
    let score = 0;
    for (const c of chords) if (chordDegree(c, key)) score += 2;
    if (chordDegree(chords[0], key) === 1) score += 3;
    if (chordDegree(chords[chords.length - 1], key) === 1) score += 2;
    if (score > bestScore) {
      best = key;
      bestScore = score;
    }
  }
  return best;
}

/** How a pitch is spelled in a key: its scale letter if it's in the key, otherwise by key signature. */
function spellPc(pc, key) {
  const scale = SCALES[key.minor ? "minor" : "major"];
  const d = scale.steps.findIndex((st) => mod12(key.pc + st) === pc);
  if (d >= 0) return keyChords(key)[d].label.replace(/(m|°)$/, "");
  // Out of key: name it by its place from the tonic the way players do -
  // ♭2, ♭3, ♯4, ♭6, ♭7 (B♭ in G, not A♯) - e.g. B♭ = the ♭7 of C.
  const tonic = (key.minor ? MINOR_TONICS : MAJOR_TONICS)[mod12(key.pc)];
  const interval = mod12(pc - key.pc);
  const letterStep = [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6][interval];
  const letterIdx = (LETTERS.indexOf(tonic[0]) + letterStep) % 7;
  const diff = mod12(pc - LETTER_PCS[letterIdx]);
  if (diff === 0 || diff === 1 || diff === 11) {
    const name = LETTERS[letterIdx] + (diff === 1 ? "♯" : diff === 11 ? "♭" : "");
    return FRIENDLY[name] || name;
  }
  const major = key.minor ? mod12(key.pc + 3) : key.pc;
  if (major === 0) return NEUTRAL_NAMES[pc];
  return [5, 10, 3, 8, 1].includes(major) ? FLAT_NAMES[pc] : SHARP_NAMES[pc];
}

function transposeChord(chord, shift) {
  return { ...chord, pc: mod12(chord.pc + shift), bass: chord.bass === null ? null : mod12(chord.bass + shift) };
}

function chordText(chord, key) {
  const suffix = chord.suffix.replace(/#/g, "♯").replace(/(\d)b/g, "$1♭");
  return spellPc(chord.pc, key) + suffix + (chord.bass === null ? "" : "/" + spellPc(chord.bass, key));
}

const sheetEls = {
  root: document.getElementById("sheet"),
  back: document.getElementById("sheet-back"),
  title: document.getElementById("sheet-title"),
  sub: document.getElementById("sheet-sub"),
  key: document.getElementById("sheet-key"),
  body: document.getElementById("sheet-body"),
  foot: document.getElementById("sheet-foot"),
  edit: document.getElementById("sheet-edit"),
  editor: document.getElementById("sheet-editor"),
  text: document.getElementById("sheet-text"),
  written: document.getElementById("sheet-written"),
  cancel: document.getElementById("sheet-cancel"),
};
const sheetUI = { song: null, set: null, index: 0, editing: false, writtenTouched: false };

function chordBadge(chord, key, plan) {
  const span = document.createElement("span");
  const deg = chordDegree(chord, key);
  span.className = "sc quality-" + chord.quality + (deg ? "" : " outside");
  span.textContent = chordText(chord, key);
  const at = deg ? plan.indexOf(deg) : -1;
  if (at >= 0) {
    span.classList.add("planned");
    const n = document.createElement("sup");
    n.textContent = at + 1;
    span.appendChild(n);
  }
  if (!deg) span.title = "Not in " + keyName(key);
  return span;
}

function renderSheetBody() {
  const song = sheetUI.song;
  const sheet = song.sheet;
  const key = song.key;
  const shift = mod12(key.pc - sheet.key.pc);
  const plan = songPlan(song);
  sheetEls.sub.textContent =
    (shift ? "Written in " + keyName(sheet.key).replace(" major", "").replace(" minor", "m") + " · " : "") + sheetUI.set.name + " · #" + (sheetUI.index + 1);
  sheetEls.body.innerHTML = "";
  for (const line of parseSheet(sheet.text)) {
    const div = document.createElement("div");
    if (line.type === "blank") {
      div.className = "sheet-blank";
    } else if (line.type === "label") {
      div.className = "sheet-label";
      div.textContent = line.text;
    } else {
      div.className = "sheet-line" + (line.type === "chords" ? " chords-only" : "") + (line.segs.some((s) => s.chord) ? " has-chords" : "");
      for (const seg of line.segs) {
        if (!seg.chord) {
          div.appendChild(document.createTextNode(seg.text));
          continue;
        }
        // The chord sits above the first word after it; the rest of the
        // text flows (and wraps) normally.
        const m = /^(\S*)([\s\S]*)$/.exec(seg.text);
        const anchor = document.createElement("span");
        anchor.className = "sheet-seg";
        const shown = transposeChord(seg.chord, shift);
        const badge = chordBadge(shown, key, plan);
        badge.setAttribute("role", "button");
        badge.tabIndex = 0;
        badge.addEventListener("click", () => openChordEdit(seg.src, shown));
        anchor.appendChild(badge);
        const word = document.createElement("span");
        word.className = "sheet-word";
        word.textContent = m[1] || " ";
        anchor.appendChild(word);
        div.appendChild(anchor);
        if (m[2]) div.appendChild(document.createTextNode(m[2]));
      }
    }
    sheetEls.body.appendChild(div);
  }
  applySheetFit();
}

function renderSheetKey() {
  const song = sheetUI.song;
  sheetEls.key.innerHTML = "";
  const select = document.createElement("select");
  select.className = "key-select";
  select.setAttribute("aria-label", "Key for " + song.title);
  fillKeySelect(select, song.key);
  const setKey = (key) => {
    song.key = key;
    setsUI.lastKey = key;
    saveSets();
    select.value = key.pc + ":" + (key.minor ? 1 : 0);
    if (!sheetUI.editing) renderSheetBody();
  };
  select.addEventListener("change", () => setKey(readKeySelect(select)));
  sheetEls.key.append(
    iconButton("", "Key down a semitone", "−", () => setKey({ pc: mod12(song.key.pc - 1), minor: song.key.minor })),
    select,
    iconButton("", "Key up a semitone", "+", () => setKey({ pc: mod12(song.key.pc + 1), minor: song.key.minor })),
  );
}

function showSheetMode(editing) {
  closeChordEdit();
  sheetUI.editing = editing;
  sheetEls.editor.hidden = !editing;
  sheetEls.body.hidden = editing;
  sheetEls.foot.hidden = editing;
  sheetEls.key.hidden = editing;
  if (editing) {
    const sheet = sheetUI.song.sheet;
    sheetEls.text.value = sheet ? sheet.text : "";
    sheetUI.writtenTouched = !!sheet;
    fillKeySelect(sheetEls.written, sheet ? sheet.key : sheetUI.song.key);
  } else {
    renderSheetBody();
  }
}

function openSheet(song, set, index, opts = {}) {
  sheetUI.song = song;
  sheetUI.set = set;
  sheetUI.index = index;
  sheetEls.title.textContent = song.title;
  sheetEls.sub.textContent = set.name + " · #" + (index + 1);
  renderSheetKey();
  sheetEls.root.hidden = false;
  sheetEls.body.scrollTop = 0;
  showSheetMode(typeof opts.text === "string" || !(song.sheet && song.sheet.text && song.sheet.text.trim()));
  if (typeof opts.text === "string") {
    // Shared in: prefill, and let "written in" follow the shared chords.
    sheetEls.text.value = opts.text;
    sheetUI.writtenTouched = false;
    fillKeySelect(sheetEls.written, guessKey(sheetChords(opts.text), song.key));
    sheetEls.text.scrollTop = 0;
  }
  // So the phone's back button closes the sheet instead of leaving the app.
  try {
    if (opts.replace) history.replaceState({ sheet: true }, "");
    else history.pushState({ sheet: true }, "");
  } catch (e) {
    /* ignore */
  }
}

function closeSheet(fromHistory) {
  if (sheetEls.root.hidden) return;
  closeChordEdit();
  sheetEls.root.hidden = true;
  sheetUI.song = null;
  if (!fromHistory && history.state && history.state.sheet) history.back();
  renderSets(); // key may have changed; sheet icon may have appeared
}

sheetEls.back.addEventListener("click", () => closeSheet(false));
window.addEventListener("popstate", () => closeSheet(true));
sheetEls.edit.addEventListener("click", () => showSheetMode(true));
sheetEls.cancel.addEventListener("click", () => {
  if (sheetUI.song.sheet && sheetUI.song.sheet.text.trim()) showSheetMode(false);
  else closeSheet(false);
});
sheetEls.written.addEventListener("change", () => (sheetUI.writtenTouched = true));
// Until you pick it yourself, "written in" follows the chords you paste.
sheetEls.text.addEventListener("input", () => {
  if (sheetUI.writtenTouched) return;
  fillKeySelect(sheetEls.written, guessKey(sheetChords(sheetEls.text.value), sheetUI.song.key));
});
sheetEls.editor.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = sheetEls.text.value.replace(/\s+$/, "");
  const song = sheetUI.song;
  if (!text.trim()) {
    delete song.sheet;
    saveSets();
    closeSheet(false);
    return;
  }
  song.sheet = { text, key: readKeySelect(sheetEls.written), fit: !!(song.sheet && song.sheet.fit) };
  saveSets();
  showSheetMode(false);
});

// ---------- Find chords + Share -> Tonic ----------

/** Opens a page in the phone's browser (Android) or a new tab (desktop). */
function openExternal(url) {
  if (window.AndroidAudio && typeof window.AndroidAudio.openUrl === "function") window.AndroidAudio.openUrl(url);
  else window.open(url, "_blank", "noopener");
}

document.getElementById("sheet-find").addEventListener("click", () => {
  if (!sheetUI.song) return;
  openExternal("https://www.google.com/search?q=" + encodeURIComponent(sheetUI.song.title + " chords"));
});

const shareEls = {
  root: document.getElementById("share-pick"),
  back: document.getElementById("share-back"),
  sub: document.getElementById("share-sub"),
  preview: document.getElementById("share-preview"),
  program: document.getElementById("share-program"),
  list: document.getElementById("share-list"),
  form: document.getElementById("share-new"),
  title: document.getElementById("share-new-title"),
};
let sharedText = "";

const URL_LINE = /^\s*https?:\/\/\S+\s*$/i;

/**
 * Browsers share a selection as `"the text"` plus a link to it on the next
 * line - keep just the text.
 */
function cleanShared(raw) {
  let lines = raw.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && (URL_LINE.test(lines[lines.length - 1]) || !lines[lines.length - 1].trim())) lines.pop();
  while (lines.length && !lines[0].trim()) lines.shift();
  let text = lines.join("\n");
  const q = /^\s*["“]([\s\S]*)["”]\s*$/.exec(text);
  if (q) text = q[1];
  return text;
}

function receiveShare(raw) {
  if (!raw) return;
  const text = cleanShared(raw);
  switchView("sets");
  if (!text.trim()) {
    setStatus("sets", "That was just a link — select the chords and lyrics on the page, then share the selection", true);
    return;
  }
  sharedText = text;
  openSharePicker();
}

function renderSharePicker() {
  const prog = activeProgram();
  shareEls.program.innerHTML = "";
  for (const p of [...progData.programs].sort((a, b) => b.createdAt - a.createdAt)) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name || "Untitled program";
    shareEls.program.appendChild(opt);
  }
  shareEls.program.value = prog.id;

  const chords = sheetChords(sharedText);
  shareEls.sub.textContent = chords.length
    ? plural(chords.length, "chord") + " · looks like " + keyName(guessKey(chords, setsUI.lastKey))
    : "No chords found — you can still save it";

  shareEls.list.innerHTML = "";
  for (const set of prog.sets) {
    if (!set.songs.length) continue;
    const head = document.createElement("p");
    head.className = "share-set";
    head.textContent = set.name;
    shareEls.list.appendChild(head);
    set.songs.forEach((song, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "share-song";
      const t = document.createElement("span");
      t.className = "share-song-title";
      t.textContent = i + 1 + ". " + song.title;
      const meta = document.createElement("span");
      meta.className = "share-song-meta";
      const has = song.sheet && song.sheet.text && song.sheet.text.trim();
      meta.textContent = keyName(song.key).replace(" major", "").replace(" minor", "m") + (has ? " · replaces its sheet" : "");
      b.append(t, meta);
      b.addEventListener("click", () => useSharedFor(song, set, i));
      shareEls.list.appendChild(b);
    });
  }
  if (!shareEls.list.children.length) {
    const p = document.createElement("p");
    p.className = "program-empty";
    p.textContent = "No songs in this program yet — add one below";
    shareEls.list.appendChild(p);
  }
}

function openSharePicker() {
  closeSheet(true);
  shareEls.preview.textContent = sharedText.split("\n").slice(0, 6).join("\n");
  shareEls.title.value = "";
  renderSharePicker();
  shareEls.root.hidden = false;
  shareEls.list.scrollTop = 0;
  try {
    history.pushState({ share: true }, "");
  } catch (e) {
    /* ignore */
  }
}

function closeSharePicker(fromHistory) {
  if (shareEls.root.hidden) return;
  shareEls.root.hidden = true;
  if (!fromHistory && history.state && history.state.share) history.back();
}

/** Opens the song's sheet editor with the shared text in it (Save to keep). */
function useSharedFor(song, set, index) {
  shareEls.root.hidden = true;
  const text = sharedText;
  sharedText = "";
  openSheet(song, set, index, { text, replace: true });
}

shareEls.program.addEventListener("change", () => {
  progData.activeId = shareEls.program.value;
  saveSets();
  renderSharePicker();
  renderSets();
});
shareEls.back.addEventListener("click", () => closeSharePicker(false));
shareEls.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const title = shareEls.title.value.trim();
  if (!title) {
    shareEls.title.focus();
    return;
  }
  const prog = activeProgram();
  const set = prog.sets[prog.sets.length - 1];
  // A new song starts in the key its chords are written in.
  const key = guessKey(sheetChords(sharedText), setsUI.lastKey);
  const song = { id: newId(), title, key };
  set.songs.push(song);
  saveSets();
  renderSets();
  useSharedFor(song, set, set.songs.length - 1);
});
window.addEventListener("popstate", () => closeSharePicker(true));

window.__onShare = () => {
  if (window.AndroidAudio && typeof window.AndroidAudio.takeSharedText === "function") receiveShare(window.AndroidAudio.takeSharedText());
};
window.__onShare(); // shared while the app was closed

// ---------- Change a chord by tapping it on the sheet ----------

const chordEditEls = {
  root: document.getElementById("chord-edit"),
  title: document.getElementById("chord-edit-title"),
  close: document.getElementById("chord-edit-close"),
  chips: document.getElementById("chord-edit-chips"),
  form: document.getElementById("chord-edit-form"),
  input: document.getElementById("chord-edit-input"),
  remove: document.getElementById("chord-edit-remove"),
};
let chordEditSrc = null;

function normalizeSheetText(text) {
  return text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
}

/**
 * Writes a chord back into the sheet text at `src` (its place in the text).
 * `chord` is in the key shown on screen; the text keeps its written-in key,
 * so it's moved back before being written. null removes the chord.
 */
function writeChord(src, chord) {
  const song = sheetUI.song;
  const sheet = song.sheet;
  const lines = normalizeSheetText(sheet.text).split("\n");
  let line = lines[src.line];
  if (line === undefined) return;
  const token = chord ? chordText(transposeChord(chord, -mod12(song.key.pc - sheet.key.pc)), sheet.key) : "";
  if (src.inline) {
    line = line.slice(0, src.at) + (token ? "[" + token + "]" : "") + line.slice(src.at + src.len);
  } else {
    // Chord line above lyrics: keep the other chords in their columns.
    let end = src.at + src.len;
    let repl = token.padEnd(src.len);
    if (token.length > src.len) {
      let spaces = 0;
      while (line[end + spaces] === " ") spaces++;
      const atEnd = end + spaces >= line.length;
      const extra = token.length - src.len;
      end += atEnd ? Math.min(extra, spaces) : Math.min(extra, Math.max(0, spaces - 1));
      repl = token;
    }
    line = line.slice(0, src.at) + repl + line.slice(end);
  }
  if (!line.trim() && !src.inline) lines.splice(src.line, 1); // last chord on a chord line
  else lines[src.line] = line.replace(/\s+$/, "");
  sheet.text = lines.join("\n");
  saveSets();
  renderSheetBody();
}

function openChordEdit(src, shown) {
  if (!src) return;
  chordEditSrc = src;
  const key = sheetUI.song.key;
  chordEditEls.title.textContent = "Change " + chordText(shown, key);
  chordEditEls.chips.innerHTML = "";
  const scale = SCALES[key.minor ? "minor" : "major"];
  for (const c of keyChords(key)) {
    const chord = {
      pc: mod12(key.pc + scale.steps[c.degree - 1]),
      quality: c.quality,
      suffix: c.quality === "minor" ? "m" : c.quality === "diminished" ? "dim" : "",
      bass: null,
    };
    const chip = chordChip(c, "button");
    chip.type = "button";
    const current = chord.pc === shown.pc && chord.quality === shown.quality;
    chip.classList.toggle("picked", current);
    chip.addEventListener("click", () => {
      closeChordEdit();
      writeChord(src, chord);
    });
    const li = document.createElement("li");
    li.className = "chip-wrap";
    li.appendChild(chip);
    chordEditEls.chips.appendChild(li);
  }
  chordEditEls.input.value = "";
  chordEditEls.input.placeholder = "Other chord, e.g. " + chordText(shown, key) + "7 or " + spellPc(key.pc, key) + "sus4";
  chordEditEls.input.classList.remove("invalid");
  chordEditEls.root.hidden = false;
}

function closeChordEdit() {
  chordEditEls.root.hidden = true;
  chordEditSrc = null;
}

chordEditEls.close.addEventListener("click", closeChordEdit);
chordEditEls.root.addEventListener("click", (e) => {
  if (e.target === chordEditEls.root) closeChordEdit(); // tap outside the panel
});
chordEditEls.remove.addEventListener("click", () => {
  const src = chordEditSrc;
  closeChordEdit();
  writeChord(src, null);
});
chordEditEls.input.addEventListener("input", () => chordEditEls.input.classList.remove("invalid"));
chordEditEls.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const chord = parseChord(chordEditEls.input.value.trim());
  if (!chord) {
    chordEditEls.input.classList.add("invalid");
    return;
  }
  const src = chordEditSrc;
  closeChordEdit();
  writeChord(src, chord);
});

// ---------- Less scrolling: tap to turn pages, fit to screen ----------

const sheetPageEl = document.getElementById("sheet-page");
const sheetFitBtn = document.getElementById("sheet-fit");
const SHEET_FONT = 16; // px, the normal size (style.css .sheet-body)
const SHEET_FONT_MIN = 12; // never shrink below this - it has to stay readable on a stand

/** Lines kept from the previous screen when turning a page, so you don't lose your place. */
function sheetOverlap() {
  return Math.round(parseFloat(getComputedStyle(sheetEls.body).fontSize) * 1.45 * 2);
}

function updateSheetPage() {
  const b = sheetEls.body;
  const step = Math.max(1, b.clientHeight - sheetOverlap());
  const pages = b.scrollHeight <= b.clientHeight + 2 ? 1 : 1 + Math.ceil((b.scrollHeight - b.clientHeight) / step);
  const page = b.scrollTop + b.clientHeight >= b.scrollHeight - 2 ? pages : 1 + Math.round(b.scrollTop / step);
  sheetPageEl.textContent = pages > 1 ? page + " / " + pages : "";
}

/** Shrinks the text (down to SHEET_FONT_MIN) until the whole sheet fits without scrolling. */
function applySheetFit() {
  const song = sheetUI.song;
  const b = sheetEls.body;
  const fit = !!(song && song.sheet && song.sheet.fit);
  sheetFitBtn.setAttribute("aria-pressed", fit ? "true" : "false");
  sheetFitBtn.classList.toggle("on", fit);
  b.style.fontSize = "";
  if (fit && b.clientHeight && b.scrollHeight > b.clientHeight) {
    let lo = SHEET_FONT_MIN;
    let hi = SHEET_FONT;
    for (let k = 0; k < 7; k++) {
      const mid = (lo + hi) / 2;
      b.style.fontSize = mid + "px";
      if (b.scrollHeight > b.clientHeight) hi = mid;
      else lo = mid;
    }
    b.style.fontSize = lo + "px";
  }
  updateSheetPage();
}

function turnSheetPage(dir) {
  const b = sheetEls.body;
  if (b.scrollHeight <= b.clientHeight + 2) return;
  b.scrollBy({ top: dir * (b.clientHeight - sheetOverlap()), behavior: "smooth" });
  // A brief glow on the edge you're moving toward, so the tap visibly registered.
  sheetEls.root.classList.remove("turn-next", "turn-prev");
  void sheetEls.root.offsetWidth;
  sheetEls.root.classList.add(dir > 0 ? "turn-next" : "turn-prev");
}

sheetEls.body.addEventListener("click", (e) => {
  if (e.target.closest(".sc")) return; // tapping a chord edits it
  const r = sheetEls.body.getBoundingClientRect();
  turnSheetPage(e.clientY > r.top + r.height / 2 ? 1 : -1);
});
sheetEls.body.addEventListener("scroll", () => requestAnimationFrame(updateSheetPage), { passive: true });
sheetEls.root.addEventListener("animationend", () => sheetEls.root.classList.remove("turn-next", "turn-prev"));

// Bluetooth page-turner pedals act as keyboards (PageDown / arrows / space).
document.addEventListener("keydown", (e) => {
  if (sheetEls.root.hidden || sheetUI.editing || !chordEditEls.root.hidden) return;
  if (e.target.closest && e.target.closest("input, textarea, select, button")) return;
  const next = ["PageDown", "ArrowDown", "ArrowRight", " "];
  const prev = ["PageUp", "ArrowUp", "ArrowLeft"];
  if (next.includes(e.key)) turnSheetPage(1);
  else if (prev.includes(e.key)) turnSheetPage(-1);
  else return;
  e.preventDefault();
});

sheetFitBtn.addEventListener("click", () => {
  const sheet = sheetUI.song && sheetUI.song.sheet;
  if (!sheet) return;
  sheet.fit = !sheet.fit;
  saveSets();
  applySheetFit();
});
window.addEventListener("resize", () => {
  if (!sheetEls.root.hidden && !sheetUI.editing) applySheetFit();
});
