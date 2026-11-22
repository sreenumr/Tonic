package analysis

import (
	"math/rand"
	"strings"
	"testing"
)

// Key-from-chords harness: play a chord progression (each chord held a
// couple of seconds, like strumming along) and check the detected key.

type progChord struct {
	root  int
	minor bool
}

func renderProgression(rng *rand.Rand, chords []progChord, secondsEach float64, loops int) []float64 {
	var out []float64
	for l := 0; l < loops; l++ {
		for _, c := range chords {
			iv := []int{0, 4, 7}
			if c.minor {
				iv = []int{0, 3, 7}
			}
			out = append(out, renderChord(rng, c.root, iv, secondsEach, 0, 0.005, harmGuitar, false)...)
		}
	}
	return out
}

func liveKey(samples []float64) string {
	an := NewStreamAnalyzer(accSampleRate)
	chunk := accSampleRate / 20
	since := 0
	var last Result
	for start := 0; start+chunk <= len(samples); start += chunk {
		an.Push(samples[start : start+chunk])
		since += chunk
		if since >= accSampleRate/4 {
			since = 0
			if an.Ready() {
				last = an.Analyze()
			}
		}
	}
	return last.TopScale
}

var keyProgressions = []struct {
	label  string
	want   string
	chords []progChord
}{
	{"E A B (I IV V)", "E Major", []progChord{{4, false}, {9, false}, {11, false}}},
	{"G C D", "G Major", []progChord{{7, false}, {0, false}, {2, false}}},
	{"C F G", "C Major", []progChord{{0, false}, {5, false}, {7, false}}},
	{"D G A", "D Major", []progChord{{2, false}, {7, false}, {9, false}}},
	{"A D E", "A Major", []progChord{{9, false}, {2, false}, {4, false}}},
	{"C G Am F", "C Major", []progChord{{0, false}, {7, false}, {9, true}, {5, false}}},
	{"G D Em C", "G Major", []progChord{{7, false}, {2, false}, {4, true}, {0, false}}},
	{"D A Bm G", "D Major", []progChord{{2, false}, {9, false}, {11, true}, {7, false}}},
	{"Am F C G", "A Minor", []progChord{{9, true}, {5, false}, {0, false}, {7, false}}},
	{"Em C G D", "E Minor", []progChord{{4, true}, {0, false}, {7, false}, {2, false}}},
	{"Am Dm E Am", "A Minor", []progChord{{9, true}, {2, true}, {4, false}, {9, true}}},
	{"F Bb C", "F Major", []progChord{{5, false}, {10, false}, {0, false}}},
	// Not starting on the home chord: fit alone must still find it.
	{"A B E E (IV V I)", "E Major", []progChord{{9, false}, {11, false}, {4, false}, {4, false}}},
	{"F G C C (IV V I)", "C Major", []progChord{{5, false}, {7, false}, {0, false}, {0, false}}},
	{"Dm G C (ii V I)", "C Major", []progChord{{2, true}, {7, false}, {0, false}}},
}

func TestKeyFromProgressions(t *testing.T) {
	ok, n := 0, 0
	for _, p := range keyProgressions {
		for _, loops := range []int{1, 2} {
			rng := rand.New(rand.NewSource(11))
			got := liveKey(renderProgression(rng, p.chords, 2.0, loops))
			pass := strings.EqualFold(got, p.want)
			if pass {
				ok++
			}
			n++
			t.Logf("%-16s x%d  want %-8s got %-8s %s", p.label, loops, p.want, got, map[bool]string{true: "ok", false: "WRONG"}[pass])
		}
	}
	t.Logf("KEY TOTAL %d/%d", ok, n)
	if ok < n {
		t.Errorf("key detection wrong on %d/%d progressions", n-ok, n)
	}
}

// keyTimeline streams segments through one live analyzer and returns the
// shown key at the end of each segment, plus the time (seconds into the
// last segment) at which the last segment's final key first appeared.
func keyTimeline(segments [][]float64) ([]string, float64) {
	an := NewStreamAnalyzer(accSampleRate)
	chunk := accSampleRate / 20
	var keys []string
	switchAt := -1.0
	last := ""
	for si, seg := range segments {
		since := 0
		for start := 0; start+chunk <= len(seg); start += chunk {
			an.Push(seg[start : start+chunk])
			since += chunk
			if since >= accSampleRate/4 {
				since = 0
				if an.Ready() {
					k := an.Analyze().TopScale
					if si == len(segments)-1 && k != last && last != "" {
						switchAt = float64(start+chunk) / accSampleRate
					}
					last = k
				}
			}
		}
		keys = append(keys, last)
	}
	return keys, switchAt
}

func silence(seconds float64) []float64 {
	rng := rand.New(rand.NewSource(2))
	out := make([]float64, int(seconds*accSampleRate))
	for i := range out {
		out[i] = (rng.Float64()*2 - 1) * 0.0005
	}
	return out
}

var (
	chE  = progChord{4, false}
	chA  = progChord{9, false}
	chB  = progChord{11, false}
	chC  = progChord{0, false}
	chF  = progChord{5, false}
	chG  = progChord{7, false}
	chAm = progChord{9, true}
)

func TestKeyFollowsChanges(t *testing.T) {
	rng := rand.New(rand.NewSource(21))
	eab := renderProgression(rng, []progChord{chE, chA, chB}, 2.0, 2) // 12s in E

	cases := []struct {
		label    string
		then     []float64
		want     string
		maxDelay float64 // seconds into the new segment
	}{
		{"E A B -> C F G (new key)", renderProgression(rng, []progChord{chC, chF, chG}, 2.0, 3), "C Major", 10},
		{"E A B -> C held", renderProgression(rng, []progChord{chC}, 12.0, 1), "C Major", 10},
		{"E A B -> pause -> Am F C G", append(silence(3), renderProgression(rng, []progChord{chAm, chF, chC, chG}, 2.0, 2)...), "A Minor", 3 + 10},
		// Neighbouring key sharing two of three chords (A, E are in both).
		{"E A B -> A D E (shared)", renderProgression(rng, []progChord{chA, {2, false}, chE}, 2.0, 4), "A Major", 10},
		// A single borrowed chord must not flip the key.
		{"E A B -> C (2s) -> E A B", renderProgression(rng, []progChord{chC, chE, chA, chB}, 2.0, 1), "E Major", -1},
	}
	for _, c := range cases {
		keys, at := keyTimeline([][]float64{eab, c.then})
		pass := keys[0] == "E Major" && keys[1] == c.want && (c.maxDelay < 0 || at <= c.maxDelay)
		if c.maxDelay < 0 {
			pass = keys[0] == "E Major" && keys[1] == c.want && at < 0
		}
		t.Logf("%-28s before=%-8s after=%-8s (want %s) switched at %.2fs %s", c.label, keys[0], keys[1], c.want, at,
			map[bool]string{true: "ok", false: "WRONG"}[pass])
		if !pass {
			t.Errorf("%s: wrong key behaviour", c.label)
		}
	}
}
