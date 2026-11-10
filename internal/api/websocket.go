package api

import (
	"encoding/binary"
	"encoding/json"
	"log"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"musichelper/internal/analysis"
)

// analysisInterval is how often the rolling window is re-analyzed and a
// fresh result pushed to the client.
const analysisInterval = 500 * time.Millisecond

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     checkOrigin,
}

// checkOrigin allows same-origin requests (the app serving its own frontend)
// and non-browser clients that send no Origin header at all.
func checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	return strings.Contains(origin, r.Host)
}

// setupMessage is the first JSON text frame the client sends after
// connecting, describing the PCM format that will follow.
type setupMessage struct {
	SampleRate int `json:"sampleRate"`
}

// WebSocketHandler handles GET /ws: a live mic-capture stream. The client
// sends one JSON setup message, then a stream of binary frames containing
// little-endian float32 mono PCM samples. The server periodically analyzes
// the rolling window and pushes back JSON results.
func WebSocketHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("websocket upgrade: %v", err)
		return
	}
	defer conn.Close()

	_, setupBytes, err := conn.ReadMessage()
	if err != nil {
		log.Printf("websocket read setup message: %v", err)
		return
	}
	var setup setupMessage
	if err := json.Unmarshal(setupBytes, &setup); err != nil || setup.SampleRate <= 0 {
		conn.WriteJSON(map[string]string{"error": "invalid setup message, expected {sampleRate}"})
		return
	}

	analyzer := analysis.NewStreamAnalyzer(setup.SampleRate)
	done := make(chan struct{})
	go pushResultsLoop(conn, analyzer, done)
	defer close(done)

	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if msgType != websocket.BinaryMessage {
			continue
		}
		analyzer.Push(decodeFloat32LE(data))
	}
}

// pushResultsLoop periodically writes analysis results to conn until done
// is closed. Runs as the sole writer goroutine for this connection.
func pushResultsLoop(conn *websocket.Conn, analyzer *analysis.StreamAnalyzer, done <-chan struct{}) {
	ticker := time.NewTicker(analysisInterval)
	defer ticker.Stop()

	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			if !analyzer.Ready() {
				continue
			}
			result := analyzer.Analyze()
			if err := conn.WriteJSON(result); err != nil {
				return
			}
		}
	}
}

// decodeFloat32LE converts a little-endian float32 byte buffer (as sent by
// the browser's Web Audio API) into float64 samples.
func decodeFloat32LE(data []byte) []float64 {
	n := len(data) / 4
	samples := make([]float64, n)
	for i := 0; i < n; i++ {
		bits := binary.LittleEndian.Uint32(data[i*4 : i*4+4])
		samples[i] = float64(math.Float32frombits(bits))
	}
	return samples
}
