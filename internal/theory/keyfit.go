package theory

// Key-from-chords: the way a musician names a key. Playing E, A and B
// means E major (I-IV-V) - E major is the only major key containing all
// three triads - yet a note-profile correlation alone tends to land on the
// V chord's key, because the V chord's notes plus the I chord's notes look
// a lot like the V key's scale. So in addition to the profile, every key
// is scored by how well the chords actually heard fit it as diatonic
// harmony (weighted by how long each was held), with a nudge toward the
// key whose tonic chord was played first.

// Triad is a chord reduced to its triad (root + major/minor/diminished) for
// diatonic-fit purposes: G7 -> G major, Am7 -> A minor.
type Triad struct {
	Root    int
	Quality ChordQuality // ChordMajor, ChordMinor or ChordDim
}

// TriadOf reduces a recognized chord to its triad. ok is false for chords
// with no clear triad function here (sus, augmented).
func TriadOf(root int, q ChordQuality) (Triad, bool) {
	switch q {
	case ChordMajor, ChordDom7, ChordMaj7:
		return Triad{root % 12, ChordMajor}, true
	case ChordMinor, ChordMin7:
		return Triad{root % 12, ChordMinor}, true
	case ChordDim:
		return Triad{root % 12, ChordDim}, true
	}
	return Triad{}, false
}

type chordRole struct {
	interval int // root, semitones above the tonic
	quality  ChordQuality
	weight   float64
}

// How strongly each diatonic chord points to the key: the tonic most, then
// the primary chords (IV, V), then the rest. Minor keys also accept a
// major V (harmonic minor - Am Dm E Am is clearly A minor).
var majorKeyRoles = []chordRole{
	{0, ChordMajor, 1.0}, {5, ChordMajor, 0.85}, {7, ChordMajor, 0.85},
	{2, ChordMinor, 0.6}, {9, ChordMinor, 0.6}, {4, ChordMinor, 0.5},
	{11, ChordDim, 0.5},
}
var minorKeyRoles = []chordRole{
	{0, ChordMinor, 1.0}, {5, ChordMinor, 0.85}, {7, ChordMajor, 0.85},
	{7, ChordMinor, 0.6}, {3, ChordMajor, 0.6}, {8, ChordMajor, 0.6},
	{10, ChordMajor, 0.6}, {2, ChordDim, 0.5},
}

// nonDiatonicPenalty: a chord that doesn't belong to the key at all is
// strong evidence against it (A major rules out B major).
const nonDiatonicPenalty = -0.6

// FirstChordBonus is added to the key whose tonic chord was heard first:
// songs and practice runs overwhelmingly start on the home chord.
const FirstChordBonus = 0.2

func roleWeight(key Key, t Triad) float64 {
	roles := majorKeyRoles
	if key.Mode == Minor {
		roles = minorKeyRoles
	}
	iv := ((t.Root-key.Tonic)%12 + 12) % 12
	for _, r := range roles {
		if r.interval == iv && r.quality == t.Quality {
			return r.weight
		}
	}
	return nonDiatonicPenalty
}

// ChordFitScores scores all 24 keys by duration-weighted diatonic fit of
// the heard chords (each in about -0.6..1), plus FirstChordBonus for the
// key whose tonic triad is `first` (nil if unknown). Returns nil when there
// is no chord evidence.
func ChordFitScores(durations map[Triad]float64, first *Triad) map[Key]float64 {
	var total float64
	for _, d := range durations {
		total += d
	}
	if total <= 0 {
		return nil
	}
	out := make(map[Key]float64, 24)
	for tonic := 0; tonic < 12; tonic++ {
		for _, mode := range []Mode{Major, Minor} {
			key := Key{Tonic: tonic, Mode: mode}
			var s float64
			for t, d := range durations {
				s += d * roleWeight(key, t)
			}
			s /= total
			if first != nil {
				tonicQ := ChordMajor
				if mode == Minor {
					tonicQ = ChordMinor
				}
				if first.Root == tonic && first.Quality == tonicQ {
					s += FirstChordBonus
				}
			}
			out[key] = s
		}
	}
	return out
}

// IsDiatonic reports whether triad t belongs to key (including a minor
// key's major V).
func IsDiatonic(key Key, t Triad) bool {
	return roleWeight(key, t) > 0
}
