package dsp

import (
	"math"
	"testing"
)

func sineTone(freq float64, sampleRate, n int) []float64 {
	samples := make([]float64, n)
	for i := 0; i < n; i++ {
		samples[i] = math.Sin(2 * math.Pi * freq * float64(i) / float64(sampleRate))
	}
	return samples
}

func dominantPitchClass(chroma [12]float64) int {
	best := 0
	for i := 1; i < 12; i++ {
		if chroma[i] > chroma[best] {
			best = i
		}
	}
	return best
}

func TestChroma_PureTone_A440(t *testing.T) {
	sampleRate := 44100
	samples := sineTone(440.0, sampleRate, 8192) // A
	chroma := Chroma(samples, sampleRate)
	if pc := dominantPitchClass(chroma); pc != 9 {
		t.Fatalf("expected pitch class 9 (A) to dominate, got %d: %v", pc, chroma)
	}
}

func TestChroma_PureTone_C261(t *testing.T) {
	sampleRate := 44100
	samples := sineTone(261.63, sampleRate, 8192) // C4
	chroma := Chroma(samples, sampleRate)
	if pc := dominantPitchClass(chroma); pc != 0 {
		t.Fatalf("expected pitch class 0 (C) to dominate, got %d: %v", pc, chroma)
	}
}

func TestAggregateChroma_MultiFrame(t *testing.T) {
	sampleRate := 44100
	samples := sineTone(392.0, sampleRate, 44100) // G4, 1 second
	chroma := AggregateChroma(samples, sampleRate, 8192, 4096)
	if pc := dominantPitchClass(chroma); pc != 7 {
		t.Fatalf("expected pitch class 7 (G) to dominate, got %d: %v", pc, chroma)
	}
}

func TestChroma_Empty(t *testing.T) {
	chroma := Chroma(nil, 44100)
	for _, v := range chroma {
		if v != 0 {
			t.Fatalf("expected all-zero chroma for empty input, got %v", chroma)
		}
	}
}
