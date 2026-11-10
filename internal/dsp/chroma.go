// Package dsp turns raw PCM samples into a 12-bin chroma (pitch-class)
// vector suitable for key detection.
package dsp

import (
	"math"

	"gonum.org/v1/gonum/dsp/fourier"
)

// Musically relevant frequency range for chroma folding: below fMin the FFT
// resolution for typical window sizes is too coarse to trust, above fMax
// we're mostly picking up harmonics/noise rather than fundamental pitch.
//
// fMin must stay above the frequency where a bin (sampleRate/frameSize)
// exceeds a semitone's width (freq*(2^(1/12)-1)), or adjacent pitch classes
// alias into each other. At the 4096-sample frames used for analysis
// (internal/analysis.frameSize) that threshold is ~181Hz @ 44.1kHz / ~197Hz
// @ 48kHz - below A3 (220Hz), every semitone in that band was landing in the
// wrong (or an arbitrarily rounded) pitch-class bin, which showed up as a
// consistent structural bias toward the same one or two detected keys
// whenever the real tonal signal was weak relative to that noise.
const (
	fMin = 220.0  // A3
	fMax = 1760.0 // A6
)

// hannWindow applies a Hann window in place to reduce spectral leakage.
func hannWindow(samples []float64) []float64 {
	n := len(samples)
	out := make([]float64, n)
	if n == 1 {
		out[0] = samples[0]
		return out
	}
	for i, s := range samples {
		w := 0.5 * (1 - math.Cos(2*math.Pi*float64(i)/float64(n-1)))
		out[i] = s * w
	}
	return out
}

// Chroma computes a single 12-bin normalized chroma vector from one buffer
// of samples via windowed FFT, folding all bins in [fMin, fMax] into their
// pitch class weighted by magnitude.
func Chroma(samples []float64, sampleRate int) [12]float64 {
	var chroma [12]float64
	n := len(samples)
	if n == 0 || sampleRate <= 0 {
		return chroma
	}

	windowed := hannWindow(samples)
	fft := fourier.NewFFT(n)
	coeffs := fft.Coefficients(nil, windowed)

	// Bins are spaced linearly in Hz but pitch classes are spaced
	// logarithmically, so any given semitone near the top of an octave
	// spans more Hz - and thus catches more bins - than one near the
	// bottom. Since octaves in [fMin, fMax] all start on the same pitch
	// class, that unevenness stacks on the same pitch classes every call.
	// Averaging (dividing by how many bins fed each pitch class) rather
	// than summing cancels that bin-count bias out; real tonal energy is
	// concentrated enough in its bin(s) to still dominate the average.
	var binCount [12]int
	for k, c := range coeffs {
		freq := float64(k) * float64(sampleRate) / float64(n)
		if freq < fMin || freq > fMax {
			continue
		}
		mag := math.Hypot(real(c), imag(c))
		pc := pitchClass(freq)
		chroma[pc] += mag
		binCount[pc]++
	}
	for pc, count := range binCount {
		if count > 0 {
			chroma[pc] /= float64(count)
		}
	}

	Normalize(&chroma)
	return chroma
}

// AggregateChroma frames samples into overlapping windows (windowSize/hopSize
// in samples) and sums their chroma vectors, then normalizes once at the
// end. Used for whole-file analysis and for the live rolling buffer.
func AggregateChroma(samples []float64, sampleRate, windowSize, hopSize int) [12]float64 {
	var total [12]float64
	if windowSize <= 0 || hopSize <= 0 || len(samples) < windowSize {
		if len(samples) > 0 {
			return Chroma(samples, sampleRate)
		}
		return total
	}

	frames := 0
	for start := 0; start+windowSize <= len(samples); start += hopSize {
		frame := samples[start : start+windowSize]
		c := Chroma(frame, sampleRate)
		for i := 0; i < 12; i++ {
			total[i] += c[i]
		}
		frames++
	}
	if frames == 0 {
		return total
	}
	Normalize(&total)
	return total
}

// pitchClass maps a frequency in Hz to a pitch class 0-11 (0=C), using A4 =
// 440Hz as reference (MIDI note 69).
func pitchClass(freq float64) int {
	midi := 69 + 12*math.Log2(freq/440.0)
	pc := int(math.Round(midi)) % 12
	if pc < 0 {
		pc += 12
	}
	return pc
}

// Normalize scales chroma in place so its 12 bins sum to 1 (a no-op on an
// all-zero vector). Exported so callers accumulating chroma incrementally
// across multiple calls (e.g. a live analyzer summing per-frame vectors as
// audio streams in) can apply the same final normalization AggregateChroma
// does over a complete buffer.
func Normalize(chroma *[12]float64) {
	var sum float64
	for _, v := range chroma {
		sum += v
	}
	if sum == 0 {
		return
	}
	for i := range chroma {
		chroma[i] /= sum
	}
}
