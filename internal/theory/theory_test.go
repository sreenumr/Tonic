package theory

import "testing"

func TestCorrelateKey_CMajorChroma(t *testing.T) {
	// Strong C major chroma: tonic/third/fifth (C,E,G) weighted heavily,
	// remaining diatonic notes present, non-diatonic notes near zero.
	chroma := [12]float64{
		1.0, // C
		0.05,
		0.4, // D
		0.05,
		0.8, // E
		0.4, // F
		0.05,
		0.9, // G
		0.05,
		0.4, // A
		0.05,
		0.3, // B
	}
	matches := CorrelateKey(chroma)
	if len(matches) != 24 {
		t.Fatalf("expected 24 candidates, got %d", len(matches))
	}
	top := matches[0]
	if top.Key.Tonic != 0 || top.Key.Mode != Major {
		t.Fatalf("expected C Major top match, got %s (confidence %.3f)", top.Key.Name(), top.Confidence)
	}
}

func TestCorrelateKey_AMinorChroma(t *testing.T) {
	// A natural minor: A,B,C,D,E,F,G weighted like C major's relative minor,
	// with A/C/E (i triad) emphasized.
	chroma := [12]float64{
		0.4, // C
		0.05,
		0.3, // D
		0.05,
		0.4, // E
		0.3, // F
		0.05,
		0.3, // G
		0.05,
		1.0, // A
		0.05,
		0.5, // B
	}
	matches := CorrelateKey(chroma)
	top := matches[0]
	if top.Key.Tonic != 9 || top.Key.Mode != Minor {
		t.Fatalf("expected A Minor top match, got %s (confidence %.3f)", top.Key.Name(), top.Confidence)
	}
}

func TestDiatonicChords_CMajor(t *testing.T) {
	chords := DiatonicChords(Key{Tonic: 0, Mode: Major})
	if len(chords) != 7 {
		t.Fatalf("expected 7 chords, got %d", len(chords))
	}
	want := []struct {
		roman   string
		root    string
		quality ChordQuality
	}{
		{"I", "C", ChordMajor},
		{"ii", "D", ChordMinor},
		{"iii", "E", ChordMinor},
		{"IV", "F", ChordMajor},
		{"V", "G", ChordMajor},
		{"vi", "A", ChordMinor},
		{"vii°", "B", ChordDim},
	}
	for i, w := range want {
		c := chords[i]
		if c.Roman != w.roman || c.Root != w.root || c.Quality != w.quality {
			t.Errorf("degree %d: got %+v, want roman=%s root=%s quality=%s", i+1, c, w.roman, w.root, w.quality)
		}
	}
}

func TestDiatonicChords_AMinor(t *testing.T) {
	chords := DiatonicChords(Key{Tonic: 9, Mode: Minor})
	want := []struct {
		roman   string
		root    string
		quality ChordQuality
	}{
		{"i", "A", ChordMinor},
		{"ii°", "B", ChordDim},
		{"III", "C", ChordMajor},
		{"iv", "D", ChordMinor},
		{"v", "E", ChordMinor},
		{"VI", "F", ChordMajor},
		{"VII", "G", ChordMajor},
	}
	for i, w := range want {
		c := chords[i]
		if c.Roman != w.roman || c.Root != w.root || c.Quality != w.quality {
			t.Errorf("degree %d: got %+v, want roman=%s root=%s quality=%s", i+1, c, w.roman, w.root, w.quality)
		}
	}
}

func TestKeyName(t *testing.T) {
	if got := (Key{Tonic: 7, Mode: Major}).Name(); got != "G Major" {
		t.Errorf("got %s, want G Major", got)
	}
	if got := (Key{Tonic: 10, Mode: Minor}).Name(); got != "A# Minor" {
		t.Errorf("got %s, want A# Minor", got)
	}
}

func TestChordsForLevel_CMajor(t *testing.T) {
	key := Key{Tonic: 0, Mode: Major}

	cases := []struct {
		level Level
		roman []string
	}{
		{LevelEasy, []string{"I", "IV", "V"}},
		{LevelMedium, []string{"I", "IV", "V", "vi"}},
		{LevelHard, []string{"I", "ii", "IV", "V", "vi"}},
		{LevelFull, []string{"I", "ii", "iii", "IV", "V", "vi", "vii°"}},
	}
	for _, c := range cases {
		chords := ChordsForLevel(key, c.level)
		if len(chords) != len(c.roman) {
			t.Fatalf("%s: expected %d chords, got %d (%+v)", c.level, len(c.roman), len(chords), chords)
		}
		for i, want := range c.roman {
			if chords[i].Roman != want {
				t.Errorf("%s degree %d: got %s, want %s", c.level, i, chords[i].Roman, want)
			}
		}
	}
}

func TestDetectChord_CMajorTriad(t *testing.T) {
	// C E G weighted strongly, everything else near zero.
	chroma := [12]float64{1, 0.01, 0.02, 0.01, 0.9, 0.02, 0.01, 0.85, 0.02, 0.01, 0.01, 0.02}
	dc := DetectChord(chroma)
	if dc.Root != "C" || dc.Quality != ChordMajor {
		t.Fatalf("expected C major, got %s %s (confidence %.3f)", dc.Root, dc.Quality, dc.Confidence)
	}
}

func TestDetectChord_AMinorTriad(t *testing.T) {
	// A C E weighted strongly.
	chroma := [12]float64{0.9, 0.02, 0.01, 0.02, 0.85, 0.01, 0.02, 0.01, 0.02, 1, 0.01, 0.02}
	dc := DetectChord(chroma)
	if dc.Root != "A" || dc.Quality != ChordMinor {
		t.Fatalf("expected A minor, got %s %s (confidence %.3f)", dc.Root, dc.Quality, dc.Confidence)
	}
}

func TestDetectChord_BDiminishedTriad(t *testing.T) {
	// B D F weighted strongly.
	chroma := [12]float64{0.02, 0.01, 0.9, 0.01, 0.02, 0.85, 0.01, 0.02, 0.01, 0.02, 0.01, 1}
	dc := DetectChord(chroma)
	if dc.Root != "B" || dc.Quality != ChordDim {
		t.Fatalf("expected B diminished, got %s %s (confidence %.3f)", dc.Root, dc.Quality, dc.Confidence)
	}
}
