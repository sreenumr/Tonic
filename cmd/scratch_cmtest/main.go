package main

import (
	"fmt"
	"math"
	"math/rand"

	"musichelper/internal/analysis"
)

const sampleRate = 44100

func synthAt(freqs []float64, startT, seconds float64) []float64 {
	n := int(seconds * sampleRate)
	out := make([]float64, n)
	for i := 0; i < n; i++ {
		t := startT + float64(i)/sampleRate
		var s float64
		for _, f := range freqs {
			s += math.Sin(2*math.Pi*f*t) * 0.25
		}
		out[i] = s
	}
	return out
}

func run(label string, chords [][]float64, durations []float64, total float64) {
	an := analysis.NewStreamAnalyzer(sampleRate)
	elapsed := 0.0
	idx := 0
	nextSwitch := durations[0]
	fmt.Printf("--- %s ---\n", label)
	for elapsed < total {
		chunk := synthAt(chords[idx%len(chords)], elapsed, 0.1)
		an.Push(chunk)
		elapsed += 0.1
		if elapsed >= nextSwitch {
			idx++
			nextSwitch += durations[idx%len(durations)]
		}
		if an.Ready() && int(elapsed*10)%5 == 0 {
			r := an.Analyze()
			fmt.Printf("t=%5.1fs  topScale=%-10s conf=%.4f\n", elapsed, r.TopScale, r.Confidence)
		}
	}
	fmt.Println()
}

func main() {
	Cm := []float64{261.63, 311.13, 392.00}
	BbMaj := []float64{233.08, 293.66, 349.23}
	AbMaj := []float64{207.65, 261.63, 311.13}
	GMaj := []float64{196.00, 246.94, 293.66}
	prog := [][]float64{Cm, BbMaj, AbMaj, GMaj}

	// 1) Exact equal-duration loop (the genuinely ambiguous synthetic worst case)
	run("Equal 1.5s per chord (perfectly tied - worst case)", prog, []float64{1.5}, 20.0)

	// 2) Realistic human timing: tonic held a bit longer + small jitter,
	// like natural playing would produce (never perfectly identical durations).
	rand.Seed(1)
	durs := make([]float64, 0)
	for i := 0; i < 20; i++ {
		base := 1.5
		if i%4 == 0 { // Cm slot gets held slightly longer, as real playing often does
			base = 1.7
		}
		durs = append(durs, base+(rand.Float64()-0.5)*0.2)
	}
	run("Realistic timing (tonic held slightly longer + jitter)", prog, durs, 20.0)

	regressionMain()
}
