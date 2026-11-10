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
	// enough to track chord changes roughly in real time.
	chordWindowSeconds   = 1.5
	chordMinReadySeconds = 0.6

	// Below this trailing-window RMS (samples are -1..1 floats), treat the
	// input as silence rather than running triad matching on it. Chroma
	// normalization rescales *any* input (including mic self-noise/room
	// tone) to sum to 1, and DetectChord always returns the best of 36
	// templates with no floor on correlation - so without this gate, the
	// "chord playing now" badge drifts through arbitrary chords whenever
	// nothing is actually being played.
	chordSilenceRMS = 0.02

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
	Root       string  `json:"root"`
	Quality    string  `json:"quality"`
	Confidence float64 `json:"confidence"`
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
	chroma := dsp.AggregateChroma(samples, sampleRate, frameSize, hopSize)
	bias := chordRootBias(samples, sampleRate)
	matches := biasedKeyMatches(chroma, bias)

	top := matches[0]
	similar := make([]theory.KeyMatch, 0, similarCount)
	for _, m := range matches[1:] {
		similar = append(similar, m)
		if len(similar) == similarCount {
			break
		}
	}

	return toResult(theory.Result{TopKey: top.Key, Confidence: top.Confidence, Similar: similar})
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
	chordSamples    int
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
	sessionBiasWindows int
	biasPending        []float64

	// sessionChroma accumulates the KS-profile match input the same way:
	// a running sum of each frameSize/hopSize frame's chroma across the
	// whole session (mirroring dsp.AggregateChroma's algorithm, just fed
	// incrementally instead of over one complete buffer), normalized fresh
	// in Analyze. chromaPending holds the sliding carry of samples not yet
	// long enough to form the next overlapping frame.
	sessionChroma [12]float64
	chromaPending []float64
}

// NewStreamAnalyzer creates a rolling-window analyzer for the given sample
// rate (as reported by the browser's AudioContext).
func NewStreamAnalyzer(sampleRate int) *StreamAnalyzer {
	return &StreamAnalyzer{
		sampleRate:      sampleRate,
		maxSamples:      int(keyWindowSeconds * float64(sampleRate)),
		keyMinSamples:   int(keyMinReadySeconds * float64(sampleRate)),
		chordSamples:    int(chordWindowSeconds * float64(sampleRate)),
		chordMinSamples: int(chordMinReadySeconds * float64(sampleRate)),
		sessionBias:     make(map[theory.Key]float64),
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
			s.sessionBiasWindows += accumulateChordRootBias(s.sessionBias, s.biasPending[:usable], s.sampleRate)
			s.biasPending = s.biasPending[usable:]
		}
	}

	s.chromaPending = append(s.chromaPending, samples...)
	for len(s.chromaPending) >= frameSize {
		c := dsp.Chroma(s.chromaPending[:frameSize], s.sampleRate)
		for i := 0; i < 12; i++ {
			s.sessionChroma[i] += c[i]
		}
		s.chromaPending = s.chromaPending[hopSize:]
	}
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
	samples := make([]float64, len(s.buf))
	copy(samples, s.buf)
	sampleRate := s.sampleRate
	keyMinSamples := s.keyMinSamples
	chordSamples := s.chordSamples
	bias := normalizeBias(s.sessionBias, s.sessionBiasWindows)
	chroma := s.sessionChroma
	dsp.Normalize(&chroma)
	s.mu.Unlock()

	var result Result
	if len(samples) >= keyMinSamples {
		result = toResult(topKeyResult(chroma, bias))
	}

	tail := samples
	if len(tail) > chordSamples {
		tail = tail[len(tail)-chordSamples:]
	}
	if len(tail) > 0 && rms(tail) >= chordSilenceRMS {
		dc := theory.DetectChord(dsp.Chroma(tail, sampleRate))
		result.CurrentChord = &ChordCandidate{
			Root:       dc.Root,
			Quality:    string(dc.Quality),
			Confidence: dc.Confidence,
		}
	}

	return result
}

// biasedKeyMatches runs key correlation and nudges scores toward keys whose
// tonic matches a sustained/repeated chord (see chordRootBias), returning
// candidates sorted best-match first.
func biasedKeyMatches(chroma [12]float64, bias map[theory.Key]float64) []theory.KeyMatch {
	matches := theory.CorrelateKey(chroma)
	for i := range matches {
		matches[i].Confidence += bias[matches[i].Key]
	}
	sort.Slice(matches, func(i, j int) bool { return matches[i].Confidence > matches[j].Confidence })
	return matches
}

// topKeyResult runs biasedKeyMatches and packages the top key plus runner-up
// candidates. sessionChroma/sessionBias never age old evidence out (unlike
// the old rolling-window design this replaced), so the ranking only grows
// more stable as a session goes on - no separate hysteresis needed to damp
// noise the way a forgetful short window would have produced.
func topKeyResult(chroma [12]float64, bias map[theory.Key]float64) theory.Result {
	matches := biasedKeyMatches(chroma, bias)
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
func normalizeBias(bias map[theory.Key]float64, windows int) map[theory.Key]float64 {
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
	return normalizeBias(bias, windows)
}
