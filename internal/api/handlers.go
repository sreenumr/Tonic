// Package api exposes the HTTP + WebSocket endpoints: file upload analysis
// and the live-mic streaming pipeline.
package api

import (
	"encoding/json"
	"io/fs"
	"log"
	"net/http"

	"musichelper/internal/analysis"
	"musichelper/internal/audio"
)

const maxUploadBytes = 50 << 20 // 50MB

// NewMux builds the full application handler: the file-upload and live-mic
// endpoints, plus the frontend served from webFS. webFS is an fs.FS so the
// same code works whether the assets come from disk (desktop) or an
// embed.FS baked into the binary (mobile) - see the assets package.
func NewMux(webFS fs.FS) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/analyze", AnalyzeHandler)
	mux.HandleFunc("/ws", WebSocketHandler)
	mux.Handle("/", http.FileServer(http.FS(webFS)))
	return mux
}

// AnalyzeHandler handles POST /api/analyze: a multipart file upload
// ("audio" field) is decoded and analyzed in one shot.
func AnalyzeHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		writeJSONError(w, http.StatusBadRequest, "could not parse upload: "+err.Error())
		return
	}

	file, header, err := r.FormFile("audio")
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "missing \"audio\" file field: "+err.Error())
		return
	}
	defer file.Close()

	decoded, err := audio.Decode(file, header.Filename)
	if err != nil {
		writeJSONError(w, http.StatusUnprocessableEntity, "could not decode audio: "+err.Error())
		return
	}
	if len(decoded.Samples) == 0 {
		writeJSONError(w, http.StatusUnprocessableEntity, "decoded audio contained no samples")
		return
	}

	result := analysis.AnalyzeFile(decoded.Samples, decoded.SampleRate)
	writeJSON(w, http.StatusOK, result)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("write json response: %v", err)
	}
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
