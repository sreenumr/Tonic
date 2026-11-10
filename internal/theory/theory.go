// Package theory implements key/scale detection (Krumhansl-Schmuckler) and
// diatonic chord derivation from a 12-bin chroma vector.
package theory

import (
	"math"
	"sort"
)

// Mode is a scale quality (major, natural minor, ...).
type Mode string

const (
	Major Mode = "major"
	Minor Mode = "minor" // natural minor
)

var noteNames = [12]string{"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"}

// Key is a tonic pitch class (0=C .. 11=B) plus a mode.
type Key struct {
	Tonic int // pitch class 0-11
	Mode  Mode
}

// Name returns e.g. "C Major" or "A Minor".
func (k Key) Name() string {
	title := "Major"
	if k.Mode == Minor {
		title = "Minor"
	}
	return noteNames[((k.Tonic%12)+12)%12] + " " + title
}

// Krumhansl-Schmuckler key profiles (Krumhansl & Kessler 1982), rooted at C.
var majorProfile = [12]float64{6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88}
var minorProfile = [12]float64{6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17}

// intervals (in semitones from the tonic) that make up each scale, used for
// both correlation-profile rotation reference and diatonic chord building.
var majorScaleIntervals = [7]int{0, 2, 4, 5, 7, 9, 11}
var minorScaleIntervals = [7]int{0, 2, 3, 5, 7, 8, 10}

func scaleIntervals(mode Mode) [7]int {
	if mode == Minor {
		return minorScaleIntervals
	}
	return majorScaleIntervals
}

// KeyMatch is a candidate key with its correlation confidence (0..1-ish;
// Pearson correlation, so technically -1..1 but real audio rarely goes
// negative for the winning candidates).
type KeyMatch struct {
	Key        Key
	Confidence float64
}

// CorrelateKey compares chroma against all 24 major/minor key profiles
// (rotated to every tonic) and returns them sorted best-match first.
func CorrelateKey(chroma [12]float64) []KeyMatch {
	matches := make([]KeyMatch, 0, 24)
	for tonic := 0; tonic < 12; tonic++ {
		matches = append(matches,
			KeyMatch{Key: Key{Tonic: tonic, Mode: Major}, Confidence: correlate(chroma, rotate(majorProfile, tonic))},
			KeyMatch{Key: Key{Tonic: tonic, Mode: Minor}, Confidence: correlate(chroma, rotate(minorProfile, tonic))},
		)
	}
	sort.Slice(matches, func(i, j int) bool { return matches[i].Confidence > matches[j].Confidence })
	return matches
}

// rotate shifts a C-rooted profile so index 0 aligns with the given tonic.
func rotate(profile [12]float64, tonic int) [12]float64 {
	var out [12]float64
	for i := 0; i < 12; i++ {
		out[(i+tonic)%12] = profile[i]
	}
	return out
}

// correlate computes Pearson correlation between two 12-dim vectors.
func correlate(a, b [12]float64) float64 {
	var meanA, meanB float64
	for i := 0; i < 12; i++ {
		meanA += a[i]
		meanB += b[i]
	}
	meanA /= 12
	meanB /= 12

	var num, denomA, denomB float64
	for i := 0; i < 12; i++ {
		da := a[i] - meanA
		db := b[i] - meanB
		num += da * db
		denomA += da * da
		denomB += db * db
	}
	if denomA == 0 || denomB == 0 {
		return 0
	}
	return num / math.Sqrt(denomA*denomB)
}

// ChordQuality is the triad quality (major/minor/diminished).
type ChordQuality string

const (
	ChordMajor ChordQuality = "major"
	ChordMinor ChordQuality = "minor"
	ChordDim   ChordQuality = "diminished"
)

// Chord is a diatonic triad within a key.
type Chord struct {
	Degree    int    // scale degree, 1-7
	Roman     string // e.g. "I", "ii", "vii°"
	Root      string // note name, e.g. "G"
	Quality   ChordQuality
	NoteNames [3]string
}

var majorRomanNumerals = [7]string{"I", "ii", "iii", "IV", "V", "vi", "vii°"}
var minorRomanNumerals = [7]string{"i", "ii°", "III", "iv", "v", "VI", "VII"}

// DiatonicChords builds the 7 diatonic triads for a key by stacking thirds
// on each scale degree.
func DiatonicChords(key Key) []Chord {
	intervals := scaleIntervals(key.Mode)
	romans := majorRomanNumerals
	if key.Mode == Minor {
		romans = minorRomanNumerals
	}

	chords := make([]Chord, 0, 7)
	for degree := 0; degree < 7; degree++ {
		rootPc := (key.Tonic + intervals[degree]) % 12
		thirdPc := (key.Tonic + intervals[(degree+2)%7]) % 12
		fifthPc := (key.Tonic + intervals[(degree+4)%7]) % 12

		root := noteNames[rootPc]
		third := noteNames[thirdPc]
		fifth := noteNames[fifthPc]

		quality := triadQuality(rootPc, thirdPc, fifthPc)

		chords = append(chords, Chord{
			Degree:    degree + 1,
			Roman:     romans[degree],
			Root:      root,
			Quality:   quality,
			NoteNames: [3]string{root, third, fifth},
		})
	}
	return chords
}

func triadQuality(root, third, fifth int) ChordQuality {
	minorThird := semitoneDist(root, third) == 3
	majorThird := semitoneDist(root, third) == 4
	perfectFifth := semitoneDist(root, fifth) == 7
	diminishedFifth := semitoneDist(root, fifth) == 6

	switch {
	case majorThird && perfectFifth:
		return ChordMajor
	case minorThird && perfectFifth:
		return ChordMinor
	case minorThird && diminishedFifth:
		return ChordDim
	default:
		return ChordMajor
	}
}

func semitoneDist(a, b int) int {
	d := ((b-a)%12 + 12) % 12
	return d
}

// Level is a chord-progression complexity tier: how many of the 7 diatonic
// chords to offer, biased toward the ones real songs actually use most.
type Level string

const (
	LevelEasy   Level = "easy"   // I IV V           - the "three-chord trick"
	LevelMedium Level = "medium" // + vi             - the four-chord pop progression
	LevelHard   Level = "hard"   // + ii             - common pre-dominant
	LevelFull   Level = "full"   // all 7 diatonic triads
)

// AllLevels lists every tier, easiest first.
var AllLevels = []Level{LevelEasy, LevelMedium, LevelHard, LevelFull}

var levelDegrees = map[Level][]int{
	LevelEasy:   {1, 4, 5},
	LevelMedium: {1, 4, 5, 6},
	LevelHard:   {1, 2, 4, 5, 6},
	LevelFull:   {1, 2, 3, 4, 5, 6, 7},
}

// ChordsForLevel returns the diatonic chords for key, filtered to the given
// complexity tier (in scale-degree order, not difficulty-add order).
func ChordsForLevel(key Key, level Level) []Chord {
	all := DiatonicChords(key)
	degrees, ok := levelDegrees[level]
	if !ok {
		degrees = levelDegrees[LevelFull]
	}
	chords := make([]Chord, 0, len(degrees))
	for _, d := range degrees {
		chords = append(chords, all[d-1])
	}
	return chords
}

// Result is the full key-detection output for a chroma vector: top match
// and the next-best "similar" candidates.
type Result struct {
	TopKey     Key
	Confidence float64
	Similar    []KeyMatch // runner-up candidates, does not include TopKey
}

// Analyze runs key correlation on a chroma vector and packages the result,
// keeping the top `similarCount` runner-ups.
func Analyze(chroma [12]float64, similarCount int) Result {
	matches := CorrelateKey(chroma)
	top := matches[0]
	similar := matches[1:]
	if len(similar) > similarCount {
		similar = similar[:similarCount]
	}
	return Result{
		TopKey:     top.Key,
		Confidence: top.Confidence,
		Similar:    similar,
	}
}

// DetectedChord is a single triad matched directly against a chroma vector,
// independent of any key context - useful for "what chord is playing right
// now" over a short window, as opposed to the slower-moving detected key.
type DetectedChord struct {
	Root           string
	RootPitchClass int // 0=C .. 11=B, same encoding as Key.Tonic
	Quality        ChordQuality
	Confidence     float64
}

// Chord-quality templates rooted at C: 1 at the root/third/fifth pitch
// classes, 0 elsewhere. Rotated per candidate root and correlated against
// the input chroma, same mechanism as key detection.
var majorTriadTemplate = [12]float64{1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0}
var minorTriadTemplate = [12]float64{1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0}
var dimTriadTemplate = [12]float64{1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0}

// DetectChord finds the single triad (root + quality, all 12 roots x
// major/minor/diminished = 36 candidates) that best matches chroma.
func DetectChord(chroma [12]float64) DetectedChord {
	templates := []struct {
		quality  ChordQuality
		template [12]float64
	}{
		{ChordMajor, majorTriadTemplate},
		{ChordMinor, minorTriadTemplate},
		{ChordDim, dimTriadTemplate},
	}

	best := DetectedChord{Confidence: math.Inf(-1)}
	for root := 0; root < 12; root++ {
		for _, tpl := range templates {
			score := correlate(chroma, rotate(tpl.template, root))
			if score > best.Confidence {
				best = DetectedChord{Root: noteNames[root], RootPitchClass: root, Quality: tpl.quality, Confidence: score}
			}
		}
	}
	return best
}
