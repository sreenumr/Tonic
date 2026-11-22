package analysis

import (
	"math"
	"math/rand"
	"testing"
)

// Synthetic chord-accuracy harness for the live "chord playing now" path.
// Each case renders a guitar/piano-like voicing (bass root in octave 2,
// chord tones spread across octaves 3-4, decaying harmonic series, per-note
// level jitter, broadband noise, optional detuning) and streams it through
// StreamAnalyzer the same way the websocket does.

const accSampleRate = 44100

type chordSpec struct {
	name      string
	intervals []int
	quality   string
	family    string // "major"/"minor"/"other" - the triad family used for loose scoring
}

var accChordSpecs = []chordSpec{
	{"maj", []int{0, 4, 7}, "major", "major"},
	{"min", []int{0, 3, 7}, "minor", "minor"},
	{"7", []int{0, 4, 7, 10}, "dominant7", "major"},
	{"m7", []int{0, 3, 7, 10}, "minor7", "minor"},
	{"maj7", []int{0, 4, 7, 11}, "major7", "major"},
	{"sus4", []int{0, 5, 7}, "sus4", "other"},
	{"dim", []int{0, 3, 6}, "diminished", "other"},
}

func midiFreq(m float64) float64 { return 440 * math.Pow(2, (m-69)/12) }

// renderChord renders root (pitch class) + intervals as a voiced chord.
func renderChord(rng *rand.Rand, root int, intervals []int, seconds, detuneCents, noise float64, harm []float64, melody bool) []float64 {
	n := int(seconds * accSampleRate)
	out := make([]float64, n)

	var midis []float64
	midis = append(midis, float64(36+root)) // bass root, C2..B2
	for i, iv := range intervals {
		m := float64(48 + root + iv) // octave 3
		if i%2 == 1 {
			m += 12 // spread alternate tones up an octave
		}
		midis = append(midis, m)
	}

	for _, m := range midis {
		f := midiFreq(m + detuneCents/100)
		amp := 0.6 + 0.8*rng.Float64()
		phase := rng.Float64() * 2 * math.Pi
		for h, a := range harm {
			hf := f * float64(h+1)
			if hf > accSampleRate/2-1000 {
				break
			}
			w := 2 * math.Pi * hf / accSampleRate
			ph := phase * float64(h+1)
			for i := 0; i < n; i++ {
				out[i] += amp * a * math.Sin(w*float64(i)+ph)
			}
		}
	}
	if melody {
		// A lead line over the chord: 8 notes per 2s from the major scale on
		// the root (so roughly half are non-chord passing tones), as loud as
		// a single chord tone - like a vocal/lead over strummed chords.
		scale := []int{0, 2, 4, 5, 7, 9, 11}
		noteLen := n / 8
		for k := 0; k < 8; k++ {
			f := midiFreq(float64(72+root+scale[rng.Intn(len(scale))]) + detuneCents/100)
			w := 2 * math.Pi * f / accSampleRate
			for i := k * noteLen; i < (k+1)*noteLen && i < n; i++ {
				env := math.Exp(-float64(i-k*noteLen) / float64(noteLen))
				out[i] += 1.0 * env * (math.Sin(w*float64(i)) + 0.4*math.Sin(2*w*float64(i)))
			}
		}
	}
	for i := range out {
		out[i] = out[i]*0.05 + (rng.Float64()*2-1)*noise
	}
	return out
}

var (
	harmPiano  = []float64{1.0, 0.5, 0.3, 0.15, 0.08, 0.04}
	harmGuitar = []float64{1.0, 0.8, 0.6, 0.45, 0.35, 0.25, 0.15, 0.1}
)

func runStream(an *StreamAnalyzer, samples []float64) *ChordCandidate {
	chunk := accSampleRate / 20
	var last *ChordCandidate
	since := 0
	for start := 0; start+chunk <= len(samples); start += chunk {
		an.Push(samples[start : start+chunk])
		since += chunk
		if since >= accSampleRate/4 {
			since = 0
			if an.Ready() {
				last = an.Analyze().CurrentChord
			}
		}
	}
	return last
}

var pcNames = [12]string{"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"}

func family(q string) string {
	switch q {
	case "major", "dominant7", "major7":
		return "major"
	case "minor", "minor7":
		return "minor"
	}
	return "other"
}

func TestChordAccuracy(t *testing.T) {
	if testing.Short() {
		t.Skip("slow synthetic accuracy sweep")
	}
	type cond struct {
		label  string
		harm   []float64
		detune float64
		noise  float64
		melody bool
	}
	conds := []cond{
		{"piano clean", harmPiano, 0, 0.002, false},
		{"guitar clean", harmGuitar, 0, 0.002, false},
		{"guitar noisy", harmGuitar, 0, 0.02, false},
		{"piano detuned +30c", harmPiano, 30, 0.005, false},
		{"guitar detuned -35c", harmGuitar, -35, 0.005, false},
		{"guitar + melody", harmGuitar, 0, 0.005, true},
		{"piano + melody noisy", harmPiano, 15, 0.02, true},
	}

	totalExact, totalLoose, total := 0, 0, 0
	for _, c := range conds {
		rng := rand.New(rand.NewSource(7))
		exact, loose, triadOK, triadN, n := 0, 0, 0, 0, 0
		for _, spec := range accChordSpecs {
			for root := 0; root < 12; root++ {
				an := NewStreamAnalyzer(accSampleRate)
				got := runStream(an, renderChord(rng, root, spec.intervals, 2.0, c.detune, c.noise, c.harm, c.melody))
				n++
				if got == nil {
					continue
				}
				if got.Root == pcNames[root] {
					if got.Quality == spec.quality {
						exact++
					}
					if family(got.Quality) == spec.family {
						loose++
					}
					if (spec.name == "maj" || spec.name == "min") && got.Quality == spec.quality {
						triadOK++
					}
				}
				if spec.name == "maj" || spec.name == "min" {
					triadN++
				}
			}
		}
		t.Logf("%-22s exact %3d/%d  root+family %3d/%d  plain maj/min %2d/%d", c.label, exact, n, loose, n, triadOK, triadN)
		totalExact += exact
		totalLoose += loose
		total += n
	}
	t.Logf("TOTAL exact %d/%d (%.0f%%)  root+family %d/%d (%.0f%%)",
		totalExact, total, 100*float64(totalExact)/float64(total),
		totalLoose, total, 100*float64(totalLoose)/float64(total))
}

// TestChordTransitionLatency: hold one chord, switch, and measure how long
// until the reported chord follows.
func TestChordTransitionLatency(t *testing.T) {
	rng := rand.New(rand.NewSource(3))
	pairs := [][2]int{{0, 7}, {9, 5}, {2, 7}, {4, 9}, {7, 0}}
	quals := [][2]int{{0, 0}, {1, 0}, {0, 0}, {1, 1}, {0, 0}}
	var lat []float64
	for i, p := range pairs {
		a := renderChord(rng, p[0], accChordSpecs[quals[i][0]].intervals, 2.0, 0, 0.005, harmGuitar, true)
		b := renderChord(rng, p[1], accChordSpecs[quals[i][1]].intervals, 2.0, 0, 0.005, harmGuitar, true)
		an := NewStreamAnalyzer(accSampleRate)
		runStream(an, a)
		chunk := accSampleRate / 20
		since := 0
		found := -1.0
		for start := 0; start+chunk <= len(b); start += chunk {
			an.Push(b[start : start+chunk])
			since += chunk
			if since >= accSampleRate/4 {
				since = 0
				cc := an.Analyze().CurrentChord
				if cc != nil && cc.Root == pcNames[p[1]] {
					found = float64(start+chunk) / accSampleRate
					break
				}
			}
		}
		lat = append(lat, found)
	}
	t.Logf("switch latency (s, -1 = never): %v", lat)
}

// TestSilenceGivesNoChord: low-level room noise must not produce a chord.
func TestSilenceGivesNoChord(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	an := NewStreamAnalyzer(accSampleRate)
	noise := make([]float64, 3*accSampleRate)
	for i := range noise {
		noise[i] = (rng.Float64()*2 - 1) * 0.004
	}
	if got := runStream(an, noise); got != nil {
		t.Errorf("expected no chord on near-silence, got %s %s (%.2f)", got.Root, got.Quality, got.Confidence)
	}
}

// agcNoise mimics what the Android capture path sends once the music stops:
// its auto-gain lifts room noise (plus mains hum) up to a music-like level.
func agcNoise(rng *rand.Rand, seconds, level float64, hum bool) []float64 {
	n := int(seconds * accSampleRate)
	out := make([]float64, n)
	for i := range out {
		s := (rng.Float64()*2 - 1) * level
		if hum {
			t := float64(i) / accSampleRate
			s += level * 0.3 * (math.Sin(2*math.Pi*100*t) + 0.5*math.Sin(2*math.Pi*150*t))
		}
		out[i] = s
	}
	return out
}

// TestChordClearsAfterPlayingStops: play a chord, then stop. Whether the
// "silence" that follows is real silence or gain-boosted room noise, the
// badge must clear instead of sticking on the last chord.
func TestChordClearsAfterPlayingStops(t *testing.T) {
	cases := []struct {
		label string
		after func(rng *rand.Rand) []float64
	}{
		{"true silence", func(rng *rand.Rand) []float64 { return agcNoise(rng, 3, 0.0005, false) }},
		{"agc noise", func(rng *rand.Rand) []float64 { return agcNoise(rng, 3, 0.15, false) }},
		{"agc noise + hum", func(rng *rand.Rand) []float64 { return agcNoise(rng, 3, 0.15, true) }},
	}
	for _, c := range cases {
		rng := rand.New(rand.NewSource(5))
		an := NewStreamAnalyzer(accSampleRate)
		if got := runStream(an, renderChord(rng, 9, []int{0, 3, 7}, 2.0, 0, 0.005, harmGuitar, false)); got == nil || got.Name != "Am" {
			t.Fatalf("%s: setup chord not detected, got %+v", c.label, got)
		}
		if got := runStream(an, c.after(rng)); got != nil {
			t.Errorf("%s: chord stuck after playing stopped: %s", c.label, got.Name)
		}
	}
}
