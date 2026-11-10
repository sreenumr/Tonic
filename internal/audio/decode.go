// Package audio decodes uploaded WAV/MP3 files into mono float64 PCM
// samples (range roughly -1..1) for the DSP pipeline.
package audio

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"strings"

	"github.com/go-audio/wav"
	"github.com/hajimehoshi/go-mp3"
)

// Decoded holds mono PCM samples and their sample rate.
type Decoded struct {
	Samples    []float64
	SampleRate int
}

// Decode reads a WAV or MP3 file and returns mono PCM samples. Format is
// picked by filename extension when unambiguous, falling back to sniffing
// the WAV "RIFF" magic header.
func Decode(r io.Reader, filename string) (Decoded, error) {
	br := bufio.NewReader(r)
	ext := strings.ToLower(filename)

	switch {
	case strings.HasSuffix(ext, ".wav"):
		return decodeWAV(br)
	case strings.HasSuffix(ext, ".mp3"):
		return decodeMP3(br)
	}

	header, err := br.Peek(4)
	if err == nil && bytes.Equal(header, []byte("RIFF")) {
		return decodeWAV(br)
	}
	return decodeMP3(br)
}

func decodeWAV(r io.Reader) (Decoded, error) {
	raw, err := io.ReadAll(r)
	if err != nil {
		return Decoded{}, fmt.Errorf("read wav: %w", err)
	}
	rs := bytes.NewReader(raw)

	dec := wav.NewDecoder(rs)
	if !dec.IsValidFile() {
		return Decoded{}, fmt.Errorf("not a valid WAV file")
	}
	buf, err := dec.FullPCMBuffer()
	if err != nil {
		return Decoded{}, fmt.Errorf("decode wav: %w", err)
	}

	channels := buf.Format.NumChannels
	if channels < 1 {
		channels = 1
	}
	maxVal := float64(int64(1) << (uint(buf.SourceBitDepth) - 1))
	if buf.SourceBitDepth == 0 {
		maxVal = 32768
	}

	frames := len(buf.Data) / channels
	samples := make([]float64, frames)
	for i := 0; i < frames; i++ {
		var sum float64
		for c := 0; c < channels; c++ {
			sum += float64(buf.Data[i*channels+c])
		}
		samples[i] = (sum / float64(channels)) / maxVal
	}

	return Decoded{Samples: samples, SampleRate: buf.Format.SampleRate}, nil
}

func decodeMP3(r io.Reader) (Decoded, error) {
	dec, err := mp3.NewDecoder(r)
	if err != nil {
		if strings.Contains(err.Error(), "MPEG version 2.5") {
			return Decoded{}, fmt.Errorf("this MP3 uses MPEG version 2.5, an unsupported low-bitrate encoding (typically from voice recorders or very low-quality rips) - try re-exporting it as a standard MP3 or WAV")
		}
		return Decoded{}, fmt.Errorf("decode mp3: %w", err)
	}

	raw, err := io.ReadAll(dec)
	if err != nil {
		return Decoded{}, fmt.Errorf("read mp3 pcm: %w", err)
	}

	// go-mp3 always outputs 16-bit little-endian stereo interleaved PCM.
	const bytesPerFrame = 4 // 2 channels * 2 bytes
	frames := len(raw) / bytesPerFrame
	samples := make([]float64, frames)
	for i := 0; i < frames; i++ {
		l := int16(binary.LittleEndian.Uint16(raw[i*4 : i*4+2]))
		rr := int16(binary.LittleEndian.Uint16(raw[i*4+2 : i*4+4]))
		samples[i] = (float64(l) + float64(rr)) / 2 / 32768.0
	}

	return Decoded{Samples: samples, SampleRate: dec.SampleRate()}, nil
}
