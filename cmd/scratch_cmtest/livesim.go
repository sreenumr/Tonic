package main

import (
	"fmt"
	"os"

	"musichelper/internal/analysis"
	"musichelper/internal/audio"
)

// liveSimMain simulates a real live-listening session by feeding the actual
// decoded song through StreamAnalyzer in small chunks (like websocket frames
// arriving over time), to see whether the session-wide chord-root bias
// converges toward the song's real key the longer the "session" runs -
// mirroring how a user would actually use the live-listening feature.
func liveSimMain(path string) {
	f, err := os.Open(path)
	if err != nil {
		fmt.Println("open error:", err)
		return
	}
	defer f.Close()

	decoded, err := audio.Decode(f, path)
	if err != nil {
		fmt.Println("decode error:", err)
		return
	}

	an := analysis.NewStreamAnalyzer(decoded.SampleRate)
	chunk := decoded.SampleRate / 20 // ~50ms chunks, like the real capture path
	analyzeEvery := decoded.SampleRate / 2 // ~500ms, matching analysisInterval

	sinceAnalyze := 0
	for start := 0; start+chunk <= len(decoded.Samples); start += chunk {
		an.Push(decoded.Samples[start : start+chunk])
		sinceAnalyze += chunk
		if sinceAnalyze >= analyzeEvery {
			sinceAnalyze = 0
			if an.Ready() {
				r := an.Analyze()
				t := start / decoded.SampleRate
				if t%10 == 0 {
					fmt.Printf("t=%4ds topScale=%-10s conf=%.4f\n", t, r.TopScale, r.Confidence)
				}
			}
		}
	}
}
