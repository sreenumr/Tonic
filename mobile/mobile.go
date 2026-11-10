// Package mobile is the gomobile-bindable entry point used by the Android
// app: it starts the same HTTP server the desktop build uses (same routes,
// same embedded frontend), listening on 127.0.0.1 only since this now runs
// inside one person's phone rather than being shared on a network.
package mobile

import (
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"sync"

	"musichelper/assets"
	"musichelper/internal/api"
)

var (
	startOnce sync.Once
	startErr  error
)

// Start launches the server on 127.0.0.1:port in the background. Safe to
// call more than once (e.g. from onCreate/onResume) - only the first call
// does anything; every call returns whatever error that first attempt
// produced (nil on success).
func Start(port int) error {
	startOnce.Do(func() {
		webFS, err := fs.Sub(assets.WebFS, "web")
		if err != nil {
			startErr = err
			return
		}

		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			startErr = err
			return
		}

		go func() {
			_ = http.Serve(ln, api.NewMux(webFS))
		}()
	})
	return startErr
}
