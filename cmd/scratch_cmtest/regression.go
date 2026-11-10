package main

import (
	"fmt"
	"math"
	"math/rand"

	"musichelper/internal/analysis"
)

func harmonicToneR(freq float64, seconds float64) []float64 {
	n := int(seconds * sampleRate)
	out := make([]float64, n)
	amps := []float64{1.0, 0.5, 0.3, 0.15, 0.08, 0.04}
	for i := 0; i < n; i++ {
		t := float64(i) / sampleRate
		var s float64
		for h, a := range amps {
			s += math.Sin(2*math.Pi*freq*float64(h+1)*t) * a
		}
		out[i] = s * 0.15
	}
	return out
}

func melodicPhraseR(notes []float64, noteSeconds float64) []float64 {
	var out []float64
	for _, f := range notes {
		out = append(out, harmonicToneR(f, noteSeconds)...)
	}
	return out
}

func regressionMain() {
	scales := map[string][]float64{
		"C major":  {261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 493.88, 523.25},
		"D major":  {293.66, 329.63, 369.99, 392.00, 440.00, 493.88, 554.37, 587.33},
		"E minor":  {329.63, 369.99, 392.00, 440.00, 493.88, 523.25, 587.33, 659.25},
		"F major":  {349.23, 392.00, 440.00, 466.16, 523.25, 587.33, 659.25, 698.46},
		"G major":  {392.00, 440.00, 493.88, 523.25, 587.33, 659.25, 739.99, 783.99},
		"A minor":  {220.00, 246.94, 261.63, 293.66, 329.63, 349.23, 392.00, 440.00},
		"B minor":  {246.94, 277.18, 293.66, 329.63, 369.99, 392.00, 440.00, 493.88},
		"Ab major": {207.65, 233.08, 261.63, 277.18, 311.13, 349.23, 392.00, 415.30},
	}
	fmt.Println("=== Melodic scale-run regression (whole-file) ===")
	correct := 0
	for label, notes := range scales {
		samples := melodicPhraseR(notes, 0.4)
		r := analysis.AnalyzeFile(samples, sampleRate)
		ok := len(r.TopScale) > 0 && (r.TopScale[:2] == label[:2] || r.TopScale == "G# Major" && label == "Ab major")
		if ok {
			correct++
		}
		fmt.Printf("  %-10s -> %-10s conf=%.3f %s\n", label, r.TopScale, r.Confidence, map[bool]string{true: "OK", false: "WRONG"}[ok])
	}
	fmt.Printf("  === %d/%d correct ===\n\n", correct, len(scales))

	fmt.Println("=== Noise robustness (live-session simulation, broadband noise mixed in) ===")
	for _, noiseAmp := range []float64{0.0, 0.05, 0.1} {
		rng := rand.New(rand.NewSource(99))
		nCorrect := 0
		for label, notes := range scales {
			var samples []float64
			for _, f := range notes {
				n := int(0.4 * sampleRate)
				amps := []float64{1.0, 0.5, 0.3, 0.15, 0.08, 0.04}
				for i := 0; i < n; i++ {
					t := float64(i) / sampleRate
					var s float64
					for h, a := range amps {
						s += math.Sin(2*math.Pi*f*float64(h+1)*t) * a
					}
					s *= 0.15
					s += (rng.Float64()*2 - 1) * noiseAmp
					samples = append(samples, s)
				}
			}
			r := analysis.AnalyzeFile(samples, sampleRate)
			ok := len(r.TopScale) > 0 && (r.TopScale[:2] == label[:2] || r.TopScale == "G# Major" && label == "Ab major")
			if ok {
				nCorrect++
			}
		}
		fmt.Printf("  noise=%.2f: %d/%d correct\n", noiseAmp, nCorrect, len(scales))
	}
}
