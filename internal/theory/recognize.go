package theory

import (
	"math"
	"sort"
)

// Extended chord qualities recognized by RecognizeChord (in addition to
// ChordMajor/ChordMinor/ChordDim used for diatonic chords).
const (
	ChordAug  ChordQuality = "augmented"
	ChordSus2 ChordQuality = "sus2"
	ChordSus4 ChordQuality = "sus4"
	ChordDom7 ChordQuality = "dominant7"
	ChordMaj7 ChordQuality = "major7"
	ChordMin7 ChordQuality = "minor7"
)

type chordType struct {
	quality   ChordQuality
	intervals []int
	// penalty is subtracted from the match score: richer/rarer chords must
	// fit clearly better than a plain triad before they're reported, since
	// a 4-note template will always fit "triad + a stray note" somewhat.
	penalty float64
}

var chordTypes = []chordType{
	{ChordMajor, []int{0, 4, 7}, 0},
	{ChordMinor, []int{0, 3, 7}, 0},
	{ChordDom7, []int{0, 4, 7, 10}, 0.025},
	{ChordMin7, []int{0, 3, 7, 10}, 0.025},
	{ChordMaj7, []int{0, 4, 7, 11}, 0.025},
	{ChordSus4, []int{0, 5, 7}, 0.04},
	{ChordSus2, []int{0, 2, 7}, 0.05},
	{ChordDim, []int{0, 3, 6}, 0.04},
	{ChordAug, []int{0, 4, 8}, 0.06},
}

// Harmonic decay used to build templates. A real note isn't a single pitch
// class: its 3rd harmonic lands on the fifth and its 5th harmonic on the
// major third. Binary templates ignore that, which is exactly why minor
// chords (whose root's own 5th harmonic adds a major-third color) and
// chords with a strong fifth were getting confused. Observed chroma is
// sqrt-compressed (see dsp.PeakChroma), so this is the compressed decay.
const templateHarmonicDecay = 0.6
const templateHarmonics = 6

// Bass cue: how much a matching bass note boosts a candidate root. Enough
// to decide between near-ties (C vs Am7, Csus2 vs Gsus4, Em vs G with a
// strong B), not enough to override a clear template match.
const bassRootWeight = 0.12

var chordTemplates = func() [][12][12]float64 {
	out := make([][12][12]float64, len(chordTypes))
	for ti, ct := range chordTypes {
		var base [12]float64
		for _, iv := range ct.intervals {
			for h := 1; h <= templateHarmonics; h++ {
				off := int(math.Round(12 * math.Log2(float64(h))))
				base[(iv+off)%12] += math.Pow(templateHarmonicDecay, float64(h-1))
			}
		}
		for root := 0; root < 12; root++ {
			out[ti][root] = rotate(base, root)
		}
	}
	return out
}()

// ChordScore is one ranked candidate from RecognizeChord.
type ChordScore struct {
	RootPitchClass int
	Quality        ChordQuality
	Score          float64 // ranking score (correlation + bass cue - penalty)
	Match          float64 // raw template correlation, -1..1
}

// Name returns e.g. "C", "Am", "G7", "Fmaj7", "Bdim".
func (c ChordScore) Name() string {
	return noteNames[c.RootPitchClass] + QualitySuffix(c.Quality)
}

// Notes returns the chord's note names, root first.
func (c ChordScore) Notes() []string {
	for _, ct := range chordTypes {
		if ct.quality == c.Quality {
			out := make([]string, len(ct.intervals))
			for i, iv := range ct.intervals {
				out[i] = noteNames[(c.RootPitchClass+iv)%12]
			}
			return out
		}
	}
	return nil
}

// QualitySuffix is the conventional chord-symbol suffix for a quality.
func QualitySuffix(q ChordQuality) string {
	switch q {
	case ChordMinor:
		return "m"
	case ChordDim:
		return "dim"
	case ChordAug:
		return "aug"
	case ChordSus2:
		return "sus2"
	case ChordSus4:
		return "sus4"
	case ChordDom7:
		return "7"
	case ChordMaj7:
		return "maj7"
	case ChordMin7:
		return "m7"
	}
	return ""
}

// RecognizeChord ranks every root x chord-type candidate against a chroma
// vector built from spectral peaks (dsp.PeakChroma), using the bass-note
// chroma as an extra root cue. Returns candidates best-first.
func RecognizeChord(chroma, bass [12]float64) []ChordScore {
	var bassSum float64
	for _, v := range bass {
		bassSum += v
	}

	scores := make([]ChordScore, 0, len(chordTypes)*12)
	for ti, ct := range chordTypes {
		for root := 0; root < 12; root++ {
			match := correlate(chroma, chordTemplates[ti][root])
			s := match - ct.penalty
			if bassSum > 0 {
				s += bassRootWeight * bass[root] / bassSum
			}
			scores = append(scores, ChordScore{RootPitchClass: root, Quality: ct.quality, Score: s, Match: match})
		}
	}
	sort.Slice(scores, func(i, j int) bool { return scores[i].Score > scores[j].Score })
	return scores
}

// NoteName returns the sharp-spelled name of a pitch class (0=C).
func NoteName(pc int) string { return noteNames[((pc%12)+12)%12] }
