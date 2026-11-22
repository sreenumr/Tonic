package dsp

import (
	"math"

	"gonum.org/v1/gonum/dsp/fourier"
)

// Peak-based chroma for chord detection.
//
// The plain Chroma() above folds *every* FFT bin into a pitch class, which
// smears noise and leakage across all 12 bins and ignores everything below
// A3 - i.e. the bass note, the single most reliable cue for a chord's root.
// The chord path instead picks genuine spectral peaks (local maxima clearly
// above the local noise floor), refines each peak's frequency with
// parabolic interpolation, corrects for global tuning offset, and folds
// only those peaks into pitch classes - separately for the bass register.

const (
	ChordFMin = 55.0   // A1
	ChordFMax = 2000.0 // ~B6
	BassFMax  = 250.0  // below ~B3: the bass register used for root cues
)

// Peak is a refined spectral peak.
type Peak struct {
	Freq float64
	Mag  float64
	// Prominence is the peak magnitude over its local mean spectrum level:
	// a few x for noise flukes, tens to hundreds for real sustained tones.
	Prominence float64
}

// SpectralPeaks returns the prominent local-maximum peaks of a Hann-windowed
// FFT of samples within [lo, hi] Hz, with parabolic (log-magnitude)
// interpolation for sub-bin frequency accuracy.
func SpectralPeaks(samples []float64, sampleRate int, lo, hi float64) []Peak {
	n := len(samples)
	if n < 16 || sampleRate <= 0 {
		return nil
	}
	windowed := hannWindow(samples)
	coeffs := fourier.NewFFT(n).Coefficients(nil, windowed)

	binHz := float64(sampleRate) / float64(n)
	kLo := int(math.Max(2, math.Floor(lo/binHz)))
	kHi := int(math.Min(float64(len(coeffs)-3), math.Ceil(hi/binHz)))
	if kHi <= kLo {
		return nil
	}

	mags := make([]float64, len(coeffs))
	maxMag := 0.0
	for k := range coeffs {
		mags[k] = math.Hypot(real(coeffs[k]), imag(coeffs[k]))
		if k >= kLo && k <= kHi && mags[k] > maxMag {
			maxMag = mags[k]
		}
	}
	if maxMag == 0 {
		return nil
	}

	// Local noise floor: running mean over a ±halfWin neighborhood, via a
	// prefix sum. A peak must stand well clear of it to count.
	prefix := make([]float64, len(mags)+1)
	for k, m := range mags {
		prefix[k+1] = prefix[k] + m
	}
	halfWin := int(math.Max(8, 40/binHz)) // ~±40Hz, at least 8 bins

	var peaks []Peak
	for k := kLo; k <= kHi; k++ {
		m := mags[k]
		if m <= mags[k-1] || m < mags[k+1] {
			continue
		}
		if m < maxMag*0.003 { // ~-50dB below the strongest peak
			continue
		}
		a0, a1 := k-halfWin, k+halfWin+1
		if a0 < 0 {
			a0 = 0
		}
		if a1 > len(mags) {
			a1 = len(mags)
		}
		localMean := (prefix[a1] - prefix[a0]) / float64(a1-a0)
		if m < localMean*2.5 {
			continue
		}

		// Parabolic interpolation on log magnitude.
		la, lb, lc := math.Log(mags[k-1]+1e-12), math.Log(m+1e-12), math.Log(mags[k+1]+1e-12)
		den := la - 2*lb + lc
		p := 0.0
		if den != 0 {
			p = 0.5 * (la - lc) / den
		}
		if p > 0.5 || p < -0.5 {
			p = 0
		}
		peaks = append(peaks, Peak{
			Freq:       (float64(k) + p) * binHz,
			Mag:        math.Exp(lb - 0.25*(la-lc)*p),
			Prominence: m / localMean,
		})
	}
	return peaks
}

// TuningAccumulator estimates how far (in semitones, -0.5..0.5) the music
// sits from A440 equal temperament, as a magnitude-weighted circular mean
// of every peak's deviation from its nearest semitone. Feed it peaks over
// time; Offset() is the running estimate.
type TuningAccumulator struct {
	cos, sin, weight float64
}

// Add folds a frame's peaks into the estimate.
func (t *TuningAccumulator) Add(peaks []Peak) {
	for _, p := range peaks {
		if p.Freq <= 0 {
			continue
		}
		midi := 69 + 12*math.Log2(p.Freq/440)
		dev := midi - math.Round(midi)
		w := math.Sqrt(p.Mag)
		t.cos += w * math.Cos(2*math.Pi*dev)
		t.sin += w * math.Sin(2*math.Pi*dev)
		t.weight += w
	}
}

// Offset returns the estimated tuning offset in semitones (0 until there's
// enough consistent evidence).
func (t *TuningAccumulator) Offset() float64 {
	if t.weight == 0 {
		return 0
	}
	// Resultant length: how consistent the deviations are. Random noise
	// peaks scatter uniformly around the circle and cancel out; only adopt
	// an offset when the evidence actually agrees.
	r := math.Hypot(t.cos, t.sin) / t.weight
	if r < 0.3 {
		return 0
	}
	return math.Atan2(t.sin, t.cos) / (2 * math.Pi)
}

// PeakChroma folds peaks into a 12-bin chroma (and a bass-only chroma for
// peaks below BassFMax), after removing the tuning offset. Each peak's
// weight is compressed (sqrt) so one loud note can't drown the rest, and
// tapered by how close it lands to a semitone center so out-of-tune
// noise/partials between notes count for little. Not normalized.
//
// bass holds only the single lowest reasonably strong peak below BassFMax
// (the bass note), since everything else in that register is usually chord
// tones or the bass note's own harmonics.
func PeakChroma(peaks []Peak, tuningOffset float64) (chroma, bass [12]float64) {
	maxMag := 0.0
	for _, p := range peaks {
		if p.Mag > maxMag {
			maxMag = p.Mag
		}
	}
	bassDone := false
	for _, p := range peaks { // ascending frequency
		if p.Freq < ChordFMin || p.Freq > ChordFMax {
			continue
		}
		midi := 69 + 12*math.Log2(p.Freq/440) - tuningOffset
		nearest := math.Round(midi)
		dev := midi - nearest
		c := math.Cos(math.Pi * dev)
		w := math.Sqrt(p.Mag) * c * c
		pc := ((int(nearest) % 12) + 12) % 12
		chroma[pc] += w
		if !bassDone && p.Freq < BassFMax && p.Mag >= maxMag*0.15 {
			bass[pc] += w
			bassDone = true
		}
	}
	return chroma, bass
}
