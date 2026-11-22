// Package analysis glues the dsp and theory packages together: turning raw
// PCM (from a file or a live mic stream) into a JSON-ready Result.
package analysis

import (
	"math"
	"sort"
	"sync"

	"musichelper/internal/dsp"
	"musichelper/internal/theory"
)

const (
	similarCount = 4

	// Frame size for FFT analysis within a window. 4096 @ 44.1kHz is
	// ~93ms/frame, ~10.7Hz bin resolution - fine for chroma folding.
	frameSize = 4096
	hopSize   = 2048

	// Rolling window for the *key/scale* estimate: long enough to average
	// over several chord changes so the detected key stays stable instead
	// of chasing whatever chord is currently sounding.
	keyWindowSeconds   = 6.0
	keyMinReadySeconds = 2.5

	// Short trailing window for the *current chord* estimate: responsive
	// enough to track chord changes roughly in real time. Frames inside it
	// are recency-weighted, so a chord change takes over well before the
	// old chord has fully aged out.
	chordWindowSeconds   = 1.0
	chordMinReadySeconds = 0.6

	// Chord-path STFT hop (frame size is picked per sample rate, see
	// chordFrameSizeFor). ~46ms @44.1kHz.
	chordHopSeconds = 0.046

	// Hysteresis for the reported chord: a different chord must beat the
	// currently shown one by this score margin to take over immediately,
	// or else win two analysis ticks in a row. Stops the badge flickering
	// between near-tied candidates (e.g. C <-> Am7) on every tick.
	chordSwitchMargin = 0.08

	// Below this template correlation the window doesn't look like any
	// chord (a melody line alone, percussion, speech) - keep showing the
	// previous chord rather than jumping to a meaningless best guess.
	chordMinMatch = 0.45

	// A note counts as "detected" (notes panel) when its chroma energy is
	// at least this fraction of the strongest pitch class.
	// "Is anything actually being played?" Level alone can't tell: the
	// Android capture path auto-gains quiet room noise up to music-like
	// levels once playing stops, which left the last chord stuck on screen
	// (or drifting through junk chords). A frame counts as tonal only when
	// it has at least tonalMinPeaks spectral peaks standing tonalProminence
	// times above the local spectrum - real notes do easily, broadband
	// noise essentially never does.
	tonalMinPeaks   = 3
	tonalProminence = 5.0

	// If the best candidate stays below chordMinMatch this many analysis
	// ticks in a row (~1s at the 250ms tick), clear the shown chord: what's
	// sounding now isn't a chord any more.
	chordClearTicks = 4

	activeNoteThreshold = 0.35
	maxActiveNotes      = 6

	// Below this trailing-window RMS (samples are -1..1 floats), treat the
	// input as silence rather than running triad matching on it. Chroma
	// normalization rescales *any* input (including mic self-noise/room
	// tone) to sum to 1, and DetectChord always returns the best of 36
	// templates with no floor on correlation - so without this gate, the
	// "chord playing now" badge drifts through arbitrary chords whenever
	// nothing is actually being played.
	//
	// This is now the *upper bound* of an adaptive gate (see
	// StreamAnalyzer.silenceGate): quiet phone mics were sitting below a
	// fixed 0.02 during real playing and never showing a chord at all.
	chordSilenceRMS = 0.02
	minSilenceRMS   = 0.003

	// Sub-window length used to sample chord roots across the key window,
	// for biasing key detection toward whichever chord has been sustained
	// or repeated the most. A KS-profile correlation over an evenly-timed
	// loop of otherwise-plausible chords (e.g. i-VII-VI-V in a minor key)
	// can leave the true tonic and its V chord within a hair of each other
	// - real music almost always lingers on/returns to the tonic more than
	// this, which this sub-window vote captures directly from the played
	// chords rather than relying on profile shape alone.
	rootBiasSubWindowSeconds = 0.75

	// How much weight the sustained-chord-root bias contributes, relative
	// to the ~0..1 KS correlation scale - enough to break a close tie
	// without overriding a clearly-won profile match.
	rootBiasWeight = 0.8

	// Weight of the chord-fit key evidence (theory.ChordFitScores) relative
	// to the ~0..1 profile correlation. Chord fit is the more musical
	// signal - it's how a player names a key - so once enough chords have
	// been heard (chordFitFullSeconds) it dominates; with little or no
	// chord evidence (a melody line, a sparse intro) the note profile still
	// decides.
	chordFitWeight      = 2.0
	chordFitFullSeconds = 3.0

	// Live key tracking forgets old evidence, so the key follows what's
	// being played *now* (play E-A-B, then move to C-F-G: the key should
	// become C major) instead of averaging over the whole session.
	// Chord-fit evidence fades with chordFitHalfLife; the slower note
	// profile with profileHalfLife. Whole-file analysis never forgets.
	chordFitHalfLife = 8.0
	profileHalfLife  = 20.0

	// A pause at least this long starts a fresh "first chord" (the
	// first-chord bonus belongs to whatever is played after the pause).
	newStartSilenceSeconds = 2.0

	// The shown key only changes once a different key has ranked first for
	// this long - a single passing/borrowed chord can't flip it.
	keySwitchSeconds = 1.5

	// Key-change trigger: once chords that don't belong to the shown key
	// have kept coming for this long, treat it as a key change - most old
	// evidence is dropped and the key is re-picked from the chords since
	// the change began. A single borrowed chord (shorter than this) never
	// triggers it; waiting for slow evidence decay alone took ~10s.
	keyChangeSeconds = 3.0
	// Fraction of the old note-profile evidence kept on a key change.
	keyChangeKeep = 0.15
)

// Chord is the JSON-facing shape of a theory.Chord.
type Chord struct {
	Degree  int      `json:"degree"`
	Roman   string   `json:"roman"`
	Root    string   `json:"root"`
	Quality string   `json:"quality"`
	Notes   []string `json:"notes"`
}

// Candidate is a ranked key match, JSON-facing.
type Candidate struct {
	Name       string  `json:"name"`
	Confidence float64 `json:"confidence"`
}

// ChordLevels holds the diatonic chords for a detected key at each
// complexity tier, so the frontend can switch between them without another
// round trip.
type ChordLevels struct {
	Easy   []Chord `json:"easy"`
	Medium []Chord `json:"medium"`
	Hard   []Chord `json:"hard"`
	Full   []Chord `json:"full"`
}

// ChordCandidate is the immediately-sounding chord, detected independently
// of the key (JSON-facing form of theory.DetectedChord).
type ChordCandidate struct {
	Root       string   `json:"root"`
	Quality    string   `json:"quality"`
	Name       string   `json:"name"`            // chord symbol, e.g. "Am7"
	Notes      []string `json:"notes,omitempty"` // chord tones, root first
	Confidence float64  `json:"confidence"`
}

// NotesInfo is the "notes being detected" view: per-pitch-class strength
// (C..B, strongest = 1), the clearly-sounding notes strongest-first, and
// the bass note when one stands out.
type NotesInfo struct {
	Chroma [12]float64 `json:"chroma"`
	Active []string    `json:"active"`
	Bass   string      `json:"bass,omitempty"`
}

// Result is the full JSON-facing analysis output. TopScale/Chords/Similar
// are omitted (empty) until enough audio has been buffered to trust a key
// estimate; CurrentChord is only populated by the live stream path.
type Result struct {
	TopScale     string          `json:"topScale,omitempty"`
	Confidence   float64         `json:"confidence,omitempty"`
	Chords       ChordLevels     `json:"chords"`
	Similar      []Candidate     `json:"similar,omitempty"`
	CurrentChord *ChordCandidate `json:"currentChord,omitempty"`
	Notes        *NotesInfo      `json:"notes,omitempty"`
}

func toChordDTO(c theory.Chord) Chord {
	return Chord{
		Degree:  c.Degree,
		Roman:   c.Roman,
		Root:    c.Root,
		Quality: string(c.Quality),
		Notes:   []string{c.NoteNames[0], c.NoteNames[1], c.NoteNames[2]},
	}
}

func toChordDTOs(chords []theory.Chord) []Chord {
	out := make([]Chord, len(chords))
	for i, c := range chords {
		out[i] = toChordDTO(c)
	}
	return out
}

func toResult(r theory.Result) Result {
	similar := make([]Candidate, len(r.Similar))
	for i, m := range r.Similar {
		similar[i] = Candidate{Name: m.Key.Name(), Confidence: m.Confidence}
	}
	return Result{
		TopScale:   r.TopKey.Name(),
		Confidence: r.Confidence,
		Chords: ChordLevels{
			Easy:   toChordDTOs(theory.ChordsForLevel(r.TopKey, theory.LevelEasy)),
			Medium: toChordDTOs(theory.ChordsForLevel(r.TopKey, theory.LevelMedium)),
			Hard:   toChordDTOs(theory.ChordsForLevel(r.TopKey, theory.LevelHard)),
			Full:   toChordDTOs(theory.ChordsForLevel(r.TopKey, theory.LevelFull)),
		},
		Similar: similar,
	}
}

// AnalyzeFile aggregates chroma across an entire decoded PCM buffer (e.g. a
// whole uploaded song) and returns the detected key/chords.
//
// A whole song collapsed into one aggregate chroma vector dilutes the tonic
// across every section (intro/verse/chorus/bridge), so - same as the live
// path - it's biased toward whichever chord is actually sustained/repeated
// most (see chordRootBias): profile-shape correlation alone can leave the
// true tonic within a hair of a closely related key (relative minor,
// subdominant, ...) that happens to dominate a long stretch of the track.
func AnalyzeFile(samples []float64, sampleRate int) Result {
	// Run the file through the same streaming analyzer the live mic uses,
	// so file and live results agree - including the chord-based key
	// evidence, which needs chords recognized over time. The session-long
	// chroma and chord-root bias it accumulates are exactly the whole-file
	// aggregates this function used to compute directly.
	an := NewStreamAnalyzer(sampleRate)
	an.live = false // a file's key is the whole song's, not its last 20s
	chunk := sampleRate / 20
	tick := sampleRate / 4
	if chunk <= 0 {
		chunk = len(samples)
	}
	since := 0
	for start := 0; start < len(samples); start += chunk {
		end := start + chunk
		if end > len(samples) {
			end = len(samples)
		}
		an.Push(samples[start:end])
		since += end - start
		if since >= tick {
			since = 0
			an.Analyze()
		}
	}

	result := an.Analyze()
	if result.TopScale == "" {
		// Shorter than the live key warm-up: analyze whatever there is.
		an.mu.Lock()
		chroma := an.sessionChroma
		bias := an.keyBias()
		an.mu.Unlock()
		dsp.Normalize(&chroma)
		result = toResult(packageKeyResult(biasedKeyMatches(chroma, bias)))
	}
	result.CurrentChord = nil
	result.Notes = fileNotes(samples, sampleRate)
	return result
}

// fileNotes builds the overall note profile of a whole track from spectral
// peaks (non-overlapping frames - plenty for a whole-song average).
func fileNotes(samples []float64, sampleRate int) *NotesInfo {
	size := chordFrameSizeFor(sampleRate)
	var frames [][]dsp.Peak
	var tuning dsp.TuningAccumulator
	for start := 0; start+size <= len(samples); start += size {
		frame := samples[start : start+size]
		if rms(frame) < minSilenceRMS {
			continue
		}
		peaks := dsp.SpectralPeaks(frame, sampleRate, dsp.ChordFMin, dsp.ChordFMax)
		tuning.Add(peaks)
		frames = append(frames, peaks)
	}
	if len(frames) == 0 {
		return nil
	}
	off := tuning.Offset()
	var total [12]float64
	for _, peaks := range frames {
		c, _ := dsp.PeakChroma(peaks, off)
		dsp.Normalize(&c)
		for i := range total {
			total[i] += c[i]
		}
	}
	return notesInfo(total, [12]float64{})
}

// chordFrameSizeFor picks the chord-path FFT size: a power of two around
// ~186ms, i.e. 8192 at 44.1/48kHz - ~5.4Hz bins, which with peak
// interpolation resolves bass notes down to ~A1 (the old 4096-sample,
// 220Hz-and-up chroma discarded the bass register entirely).
func chordFrameSizeFor(sampleRate int) int {
	target := 0.186 * float64(sampleRate)
	size := 1024
	for float64(size)*1.5 < target {
		size *= 2
	}
	return size
}

// notesInfo packages a (non-normalized) chroma + bass chroma as NotesInfo.
func notesInfo(chroma, bass [12]float64) *NotesInfo {
	maxV := 0.0
	for _, v := range chroma {
		maxV = math.Max(maxV, v)
	}
	if maxV == 0 {
		return nil
	}
	info := &NotesInfo{Active: []string{}}
	order := make([]int, 0, 12)
	for pc := 0; pc < 12; pc++ {
		info.Chroma[pc] = math.Round(chroma[pc]/maxV*1000) / 1000
		if info.Chroma[pc] >= activeNoteThreshold {
			order = append(order, pc)
		}
	}
	sort.Slice(order, func(i, j int) bool { return info.Chroma[order[i]] > info.Chroma[order[j]] })
	if len(order) > maxActiveNotes {
		order = order[:maxActiveNotes]
	}
	for _, pc := range order {
		info.Active = append(info.Active, theory.NoteName(pc))
	}

	var bassSum, bassMax float64
	bassPc := -1
	for pc, v := range bass {
		bassSum += v
		if v > bassMax {
			bassMax, bassPc = v, pc
		}
	}
	if bassPc >= 0 && bassMax >= 0.5*bassSum {
		info.Bass = theory.NoteName(bassPc)
	}
	return info
}

// chordFrame is one STFT frame of the live chord path. Peaks are kept raw
// (not yet folded to chroma) so the latest tuning estimate applies to the
// whole window at analysis time.
type chordFrame struct {
	peaks []dsp.Peak
	rms   float64
	tonal bool // see tonalMinPeaks
}

// isTonal reports whether a frame's peaks look like actual notes rather
// than noise (see tonalMinPeaks).
func isTonal(peaks []dsp.Peak) bool {
	n := 0
	for _, p := range peaks {
		if p.Prominence >= tonalProminence {
			n++
			if n >= tonalMinPeaks {
				return true
			}
		}
	}
	return false
}

// StreamAnalyzer maintains a rolling window of the most recent live-mic
// audio and produces an updated Result on demand: a slow-moving key/scale
// estimate over the full window, plus a fast "current chord" estimate over
// just the last second or so. Safe for concurrent Push/Analyze calls (a
// single mic connection uses it from a read goroutine and a periodic-
// analysis ticker).
type StreamAnalyzer struct {
	mu              sync.Mutex
	sampleRate      int
	maxSamples      int
	keyMinSamples   int
	chordMinSamples int
	buf             []float64

	// sessionBias/sessionBiasWindows accumulate the sustained-chord-root
	// signal (see accumulateChordRootBias) across the *entire* listening
	// session, not just the current rolling window - a short window only
	// ever sees whichever section of a song happens to be playing right
	// now, which for real songs can itself lean toward a chord other than
	// the tonic for a while (a verse leaning on vi, say). The same
	// whole-recording signal is what makes AnalyzeFile accurate; this
	// grows it incrementally as audio streams in instead of requiring the
	// whole file up front. biasPending holds samples not yet long enough
	// to form a complete rootBiasSubWindowSeconds chunk.
	sessionBias        map[theory.Key]float64
	sessionBiasWindows float64
	biasPending        []float64

	// sessionChroma accumulates the KS-profile match input the same way:
	// a running sum of each frameSize/hopSize frame's chroma across the
	// whole session (mirroring dsp.AggregateChroma's algorithm, just fed
	// incrementally instead of over one complete buffer), normalized fresh
	// in Analyze. chromaPending holds the sliding carry of samples not yet
	// long enough to form the next overlapping frame.
	sessionChroma [12]float64
	chromaPending []float64

	// Live chord path (see pushChordFrames / analyzeChord).
	chordFrameSize int
	chordHop       int
	chordMaxFrames int
	chordPending   []float64
	chordFrames    []chordFrame
	tuning         dsp.TuningAccumulator
	noiseFloor     float64

	// Hysteresis state for the reported chord.
	shown        *theory.ChordScore
	pendingName  string
	pendingTicks int
	lowTicks     int // consecutive ticks with no convincing chord match

	// Chord-fit key evidence: how long each (triad-reduced) chord has been
	// shown this session, and the first one shown.
	triadSeconds     map[theory.Triad]float64
	firstTriad       *theory.Triad
	samplesSinceTick int

	// live enables forgetting/hysteresis (see chordFitHalfLife); false for
	// whole-file analysis.
	live          bool
	silentSeconds float64
	tickSeconds   float64 // audio elapsed since the previous Analyze

	// Key hysteresis (see keySwitchSeconds).
	shownKey      *theory.Key
	keyCandidate  theory.Key
	keyCandidateS float64

	// Key-change trigger state (see keyChangeSeconds): chords heard since
	// out-of-key chords started, and how much out-of-key time has built up.
	outStreak  []triadSpan
	outSeconds float64
}

// fitsStreakKey reports whether some key other than the shown one contains
// every out-of-key chord of the current run *and* t. Caller holds s.mu.
func (s *StreamAnalyzer) fitsStreakKey(t theory.Triad) bool {
	for tonic := 0; tonic < 12; tonic++ {
		for _, mode := range []theory.Mode{theory.Major, theory.Minor} {
			k := theory.Key{Tonic: tonic, Mode: mode}
			if k == *s.shownKey || !theory.IsDiatonic(k, t) {
				continue
			}
			all := true
			for _, sp := range s.outStreak {
				if !theory.IsDiatonic(*s.shownKey, sp.t) && !theory.IsDiatonic(k, sp.t) {
					all = false
					break
				}
			}
			if all {
				return true
			}
		}
	}
	return false
}

type triadSpan struct {
	t    theory.Triad
	secs float64
}

// halfLifeDecay is the multiplier that fades evidence over `elapsed`
// seconds with the given half-life.
func halfLifeDecay(elapsed, halfLife float64) float64 {
	return math.Pow(0.5, elapsed/halfLife)
}

// NewStreamAnalyzer creates a rolling-window analyzer for the given sample
// rate (as reported by the browser's AudioContext).
func NewStreamAnalyzer(sampleRate int) *StreamAnalyzer {
	return &StreamAnalyzer{
		sampleRate:      sampleRate,
		maxSamples:      int(keyWindowSeconds * float64(sampleRate)),
		keyMinSamples:   int(keyMinReadySeconds * float64(sampleRate)),
		chordMinSamples: int(chordMinReadySeconds * float64(sampleRate)),
		sessionBias:     make(map[theory.Key]float64),
		live:            true,
		chordFrameSize:  chordFrameSizeFor(sampleRate),
		chordHop:        int(chordHopSeconds * float64(sampleRate)),
		chordMaxFrames:  int(math.Ceil(chordWindowSeconds / chordHopSeconds)),
	}
}

// Push appends newly captured PCM samples, trimming the rolling window used
// for the KS profile match to its configured length, and folds the new
// audio into the session-long chord-root bias (see StreamAnalyzer's
// sessionBias field) before it ages out of that window.
func (s *StreamAnalyzer) Push(samples []float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.buf = append(s.buf, samples...)
	if len(s.buf) > s.maxSamples {
		s.buf = s.buf[len(s.buf)-s.maxSamples:]
	}

	s.biasPending = append(s.biasPending, samples...)
	subSamples := int(rootBiasSubWindowSeconds * float64(s.sampleRate))
	if subSamples > 0 {
		usable := (len(s.biasPending) / subSamples) * subSamples
		if usable > 0 {
			if s.live {
				d := halfLifeDecay(float64(usable)/float64(s.sampleRate), profileHalfLife)
				for k := range s.sessionBias {
					s.sessionBias[k] *= d
				}
				s.sessionBiasWindows *= d
			}
			s.sessionBiasWindows += float64(accumulateChordRootBias(s.sessionBias, s.biasPending[:usable], s.sampleRate))
			s.biasPending = s.biasPending[usable:]
		}
	}

	s.chromaPending = append(s.chromaPending, samples...)
	hopDecay := 1.0
	if s.live {
		hopDecay = halfLifeDecay(float64(hopSize)/float64(s.sampleRate), profileHalfLife)
	}
	for len(s.chromaPending) >= frameSize {
		c := dsp.Chroma(s.chromaPending[:frameSize], s.sampleRate)
		for i := 0; i < 12; i++ {
			s.sessionChroma[i] = s.sessionChroma[i]*hopDecay + c[i]
		}
		s.chromaPending = s.chromaPending[hopSize:]
	}

	s.samplesSinceTick += len(samples)
	s.pushChordFrames(samples)
}

// pushChordFrames runs the chord-path STFT over newly arrived audio: peak
// picking per frame, tuning estimation, and noise-floor tracking. Caller
// holds s.mu.
func (s *StreamAnalyzer) pushChordFrames(samples []float64) {
	if s.chordHop <= 0 {
		return
	}
	s.chordPending = append(s.chordPending, samples...)
	for len(s.chordPending) >= s.chordFrameSize {
		frame := s.chordPending[:s.chordFrameSize]
		level := rms(frame[s.chordFrameSize-s.chordHop:])

		// Noise floor: drops instantly to any quieter level, creeps back up
		// slowly (~doubles every 15s) so it re-adapts if the room gets louder.
		if s.noiseFloor == 0 || level < s.noiseFloor {
			s.noiseFloor = math.Max(level, 1e-5)
		} else {
			s.noiseFloor *= 1.003
		}

		var peaks []dsp.Peak
		tonal := false
		if level >= s.silenceGate() {
			peaks = dsp.SpectralPeaks(frame, s.sampleRate, dsp.ChordFMin, dsp.ChordFMax)
			tonal = isTonal(peaks)
			if tonal { // noise peaks would only blur the tuning estimate
				s.tuning.Add(peaks)
			}
		}
		s.chordFrames = append(s.chordFrames, chordFrame{peaks: peaks, rms: level, tonal: tonal})
		if len(s.chordFrames) > s.chordMaxFrames {
			s.chordFrames = s.chordFrames[len(s.chordFrames)-s.chordMaxFrames:]
		}
		s.chordPending = s.chordPending[s.chordHop:]
	}
}

// silenceGate is the RMS below which audio counts as silence: a few times
// the tracked noise floor, clamped to [minSilenceRMS, chordSilenceRMS].
func (s *StreamAnalyzer) silenceGate() float64 {
	return math.Min(chordSilenceRMS, math.Max(minSilenceRMS, 3*s.noiseFloor))
}

// Ready reports whether enough audio has been buffered to analyze anything
// at all (the fast chord estimate's minimum - the slower key estimate may
// still be warming up after this returns true).
func (s *StreamAnalyzer) Ready() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.buf) >= s.chordMinSamples
}

// Analyze runs key correlation over the whole session's accumulated chroma
// (see sessionChroma) and chord extraction over the recent trailing tail,
// and returns the combined result.
func (s *StreamAnalyzer) Analyze() Result {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, notes := s.analyzeChord()

	chroma := s.sessionChroma
	dsp.Normalize(&chroma)

	var result Result
	if len(s.buf) >= s.keyMinSamples {
		matches := biasedKeyMatches(chroma, s.keyBias())
		if s.live {
			matches = s.applyKeyHysteresis(matches)
		}
		result = toResult(packageKeyResult(matches))
	}
	result.CurrentChord, result.Notes = current, notes
	return result
}

// applyKeyHysteresis keeps the previously shown key on top until a
// different key has ranked first for keySwitchSeconds. Caller holds s.mu.
func (s *StreamAnalyzer) applyKeyHysteresis(matches []theory.KeyMatch) []theory.KeyMatch {
	top := matches[0].Key
	switch {
	case s.shownKey == nil || *s.shownKey == top:
		s.shownKey = &top
		s.keyCandidateS = 0
	case s.keyCandidate == top:
		s.keyCandidateS += s.tickSeconds
	default:
		s.keyCandidate, s.keyCandidateS = top, s.tickSeconds
	}
	if s.keyCandidateS >= keySwitchSeconds {
		s.shownKey = &top
		s.keyCandidateS = 0
	}
	if *s.shownKey == top {
		return matches
	}
	out := make([]theory.KeyMatch, 0, len(matches))
	for _, m := range matches {
		if m.Key == *s.shownKey {
			out = append([]theory.KeyMatch{m}, out...)
		} else {
			out = append(out, m)
		}
	}
	return out
}

// fullTriadLevel: each of a chord's triad tones must reach this fraction of
// the strongest pitch class for the chord to count as key evidence.
const fullTriadLevel = 0.3

// triadTonesPresent reports whether all three triad tones (root, third,
// fifth) of c are clearly present in chroma.
func triadTonesPresent(chroma [12]float64, c theory.ChordScore) bool {
	t, ok := theory.TriadOf(c.RootPitchClass, c.Quality)
	if !ok {
		return false
	}
	third, fifth := 4, 7
	switch t.Quality {
	case theory.ChordMinor:
		third = 3
	case theory.ChordDim:
		third, fifth = 3, 6
	}
	maxV := 0.0
	for _, v := range chroma {
		maxV = math.Max(maxV, v)
	}
	if maxV == 0 {
		return false
	}
	for _, iv := range []int{0, third, fifth} {
		if chroma[(t.Root+iv)%12] < fullTriadLevel*maxV {
			return false
		}
	}
	return true
}

// keyBias combines the per-key nudges added to the profile correlation:
// the sustained-chord-root bias plus the chord-fit evidence. Caller holds
// s.mu.
func (s *StreamAnalyzer) keyBias() map[theory.Key]float64 {
	bias := normalizeBias(s.sessionBias, s.sessionBiasWindows)
	var total float64
	for _, d := range s.triadSeconds {
		total += d
	}
	fit := theory.ChordFitScores(s.triadSeconds, s.firstTriad)
	if fit == nil {
		return bias
	}
	conf := math.Min(1, total/chordFitFullSeconds)
	for k, v := range fit {
		bias[k] += chordFitWeight * conf * v
	}
	return bias
}

// recordShownChord credits the audio elapsed since the last analysis tick
// to the currently shown chord, for chord-fit key evidence. Caller holds
// s.mu.
//
// credit is false when the window doesn't clearly contain the chord's full
// triad - e.g. a single melody note, whose own overtones (fifth, major
// third) loosely resemble a major chord. Feeding those into the key
// evidence turned plain scale runs into bogus "chord progressions".
func (s *StreamAnalyzer) recordShownChord(credit bool) {
	elapsed := s.tickSeconds
	if s.live {
		d := halfLifeDecay(elapsed, chordFitHalfLife)
		for t := range s.triadSeconds {
			s.triadSeconds[t] *= d
		}
	}
	if s.shown == nil || !credit {
		return
	}
	t, ok := theory.TriadOf(s.shown.RootPitchClass, s.shown.Quality)
	if !ok {
		return
	}
	if s.triadSeconds == nil {
		s.triadSeconds = make(map[theory.Triad]float64)
	}
	s.triadSeconds[t] += elapsed
	if s.firstTriad == nil {
		s.firstTriad = &t
	}
	if s.live {
		s.trackKeyChange(t, elapsed)
	}
}

// trackKeyChange watches for a sustained run of chords outside the shown
// key and, past keyChangeSeconds, resets the key evidence to that run.
// In-key chords during a run wind the counter back down at half speed, so
// a new key that shares a chord or two with the old one still triggers.
// Caller holds s.mu.
func (s *StreamAnalyzer) trackKeyChange(t theory.Triad, elapsed float64) {
	if s.shownKey == nil {
		return
	}
	if theory.IsDiatonic(*s.shownKey, t) {
		if s.outSeconds == 0 {
			return
		}
		// A chord shared with a key the run is heading toward (A or E while
		// moving from E major to A major) is neutral; one that only fits the
		// old key pulls back toward it.
		if !s.fitsStreakKey(t) {
			s.outSeconds = math.Max(0, s.outSeconds-elapsed/2)
			if s.outSeconds == 0 {
				s.outStreak = nil
				return
			}
		}
	} else {
		s.outSeconds += elapsed
	}
	if n := len(s.outStreak); n > 0 && s.outStreak[n-1].t == t {
		s.outStreak[n-1].secs += elapsed
	} else {
		s.outStreak = append(s.outStreak, triadSpan{t, elapsed})
	}
	if s.outSeconds < keyChangeSeconds {
		return
	}

	// Key change: re-base the evidence on the run of new chords.
	s.triadSeconds = make(map[theory.Triad]float64)
	for _, sp := range s.outStreak {
		s.triadSeconds[sp.t] += sp.secs
	}
	first := s.outStreak[0].t
	s.firstTriad = &first
	for i := range s.sessionChroma {
		s.sessionChroma[i] *= keyChangeKeep
	}
	for k := range s.sessionBias {
		s.sessionBias[k] *= keyChangeKeep
	}
	s.sessionBiasWindows *= keyChangeKeep
	s.shownKey = nil // show the new best key right away
	s.outStreak, s.outSeconds = nil, 0
}

// analyzeChord folds the recent chord-path frames into a recency-weighted
// chroma, ranks chord candidates, and applies hysteresis. Caller holds s.mu.
func (s *StreamAnalyzer) analyzeChord() (*ChordCandidate, *NotesInfo) {
	s.tickSeconds = float64(s.samplesSinceTick) / float64(s.sampleRate)
	s.samplesSinceTick = 0
	gate := s.silenceGate()
	off := s.tuning.Offset()
	var chroma, bass [12]float64
	active := 0
	n := len(s.chordFrames)
	for i, f := range s.chordFrames {
		if f.rms < gate || !f.tonal {
			continue
		}
		c, b := dsp.PeakChroma(f.peaks, off)
		dsp.Normalize(&c)
		dsp.Normalize(&b)
		w := 0.3 + 0.7*float64(i+1)/float64(n)
		for pc := 0; pc < 12; pc++ {
			chroma[pc] += w * c[pc]
			bass[pc] += w * b[pc]
		}
		active++
	}

	// Mostly silent (or noise-only) window: clear the badge.
	if n == 0 || active*2 < n {
		s.shown, s.pendingName, s.pendingTicks, s.lowTicks = nil, "", 0, 0
		s.silentSeconds += s.tickSeconds
		if s.live && s.silentSeconds >= newStartSilenceSeconds {
			s.firstTriad = nil // whatever comes next is a fresh start
		}
		s.recordShownChord(false) // still fade old evidence while silent
		return nil, nil
	}
	s.silentSeconds = 0
	notes := notesInfo(chroma, bass)

	ranked := theory.RecognizeChord(chroma, bass)
	best := ranked[0]

	if best.Match < chordMinMatch {
		s.lowTicks++
		if s.lowTicks >= chordClearTicks {
			s.shown, s.pendingName, s.pendingTicks = nil, "", 0
		}
	} else {
		s.lowTicks = 0
	}

	switch {
	case s.shown == nil:
		if best.Match >= chordMinMatch {
			s.shown = &best
		}
	case best.Name() == s.shown.Name():
		s.shown = &best
		s.pendingName, s.pendingTicks = "", 0
	case best.Match >= chordMinMatch:
		shownNow := math.Inf(-1)
		for _, c := range ranked {
			if c.Name() == s.shown.Name() {
				shownNow = c.Score
				break
			}
		}
		if best.Name() == s.pendingName {
			s.pendingTicks++
		} else {
			s.pendingName, s.pendingTicks = best.Name(), 1
		}
		if best.Score-shownNow >= chordSwitchMargin || s.pendingTicks >= 2 {
			s.shown = &best
			s.pendingName, s.pendingTicks = "", 0
		}
	}

	s.recordShownChord(s.shown != nil && triadTonesPresent(chroma, *s.shown))
	if s.shown == nil {
		return nil, notes
	}
	return &ChordCandidate{
		Root:       theory.NoteName(s.shown.RootPitchClass),
		Quality:    string(s.shown.Quality),
		Name:       s.shown.Name(),
		Notes:      s.shown.Notes(),
		Confidence: math.Max(0, s.shown.Match),
	}, notes
}

// biasedKeyMatches runs key correlation and nudges scores toward keys whose
// tonic matches a sustained/repeated chord (see chordRootBias), returning
// candidates sorted best-match first.
func biasedKeyMatches(chroma [12]float64, bias map[theory.Key]float64) []theory.KeyMatch {
	matches := theory.CorrelateKey(chroma)
	sort.SliceStable(matches, func(i, j int) bool {
		return matches[i].Confidence+bias[matches[i].Key] > matches[j].Confidence+bias[matches[j].Key]
	})
	// Confidence stays the plain profile correlation (0..1-ish, what the
	// meter shows); the bias only decides the ranking.
	return matches
}

// topKeyResult runs biasedKeyMatches and packages the top key plus runner-up
// candidates. sessionChroma/sessionBias never age old evidence out (unlike
// the old rolling-window design this replaced), so the ranking only grows
// more stable as a session goes on - no separate hysteresis needed to damp
// noise the way a forgetful short window would have produced.
func packageKeyResult(matches []theory.KeyMatch) theory.Result {
	top := matches[0]

	similar := make([]theory.KeyMatch, 0, similarCount)
	for _, m := range matches[1:] {
		similar = append(similar, m)
		if len(similar) == similarCount {
			break
		}
	}

	return theory.Result{TopKey: top.Key, Confidence: top.Confidence, Similar: similar}
}

// rms computes the root-mean-square level of a PCM buffer (samples in
// -1..1), used as a cheap silence gate ahead of triad/key matching.
func rms(samples []float64) float64 {
	var sum float64
	for _, s := range samples {
		sum += s * s
	}
	return math.Sqrt(sum / float64(len(samples)))
}

// accumulateChordRootBias slices samples into rootBiasSubWindowSeconds
// chunks, runs chord-triad matching on each (skipping silence), and adds
// raw confidence per (root, mode) key into dst - only for major/minor
// triads, since a diminished chord is never itself a tonic. Returns the
// number of non-silent sub-windows processed, so a caller accumulating
// across multiple calls (see StreamAnalyzer.Push) can track a running
// window count alongside dst and normalize the combined total later.
func accumulateChordRootBias(dst map[theory.Key]float64, samples []float64, sampleRate int) int {
	subSamples := int(rootBiasSubWindowSeconds * float64(sampleRate))
	if subSamples <= 0 || len(samples) < subSamples {
		return 0
	}

	windows := 0
	for start := 0; start+subSamples <= len(samples); start += subSamples {
		sub := samples[start : start+subSamples]
		if rms(sub) < chordSilenceRMS {
			continue
		}
		windows++

		dc := theory.DetectChord(dsp.Chroma(sub, sampleRate))
		if dc.Confidence <= 0 {
			continue
		}
		var mode theory.Mode
		switch dc.Quality {
		case theory.ChordMajor:
			mode = theory.Major
		case theory.ChordMinor:
			mode = theory.Minor
		default:
			continue
		}
		dst[theory.Key{Tonic: dc.RootPitchClass, Mode: mode}] += dc.Confidence
	}
	return windows
}

// normalizeBias scales raw accumulated confidence totals (see
// accumulateChordRootBias) into the small per-key bonus biasedKeyMatches
// adds before ranking key candidates: whichever key's tonic matches the
// chord that was actually sustained/repeated most gets a nudge, on top of
// (not instead of) the KS profile correlation.
func normalizeBias(bias map[theory.Key]float64, windows float64) map[theory.Key]float64 {
	out := make(map[theory.Key]float64, len(bias))
	if windows == 0 {
		return out
	}
	for k, v := range bias {
		out[k] = (v / float64(windows)) * rootBiasWeight
	}
	return out
}

// chordRootBias computes the sustained-chord-root bias (see
// accumulateChordRootBias/normalizeBias) over a single, complete buffer -
// used for one-shot whole-file analysis. StreamAnalyzer accumulates the same
// signal incrementally across a live session instead of recomputing it from
// scratch on the current window every tick.
func chordRootBias(samples []float64, sampleRate int) map[theory.Key]float64 {
	bias := make(map[theory.Key]float64)
	windows := accumulateChordRootBias(bias, samples, sampleRate)
	return normalizeBias(bias, float64(windows))
}
