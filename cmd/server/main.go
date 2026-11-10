// Command server runs the Tonic web app: serves the frontend and
// exposes the file-upload and live-mic analysis endpoints. Serves both
// plain HTTP (simple localhost use) and self-signed HTTPS (needed for the
// PWA - manifest install + service worker - to work from another device on
// the LAN, since browsers require a secure origin for that outside of
// "localhost" itself).
package main

import (
	"io/fs"
	"log"
	"net/http"
	"os"

	"musichelper/assets"
	"musichelper/internal/api"
	"musichelper/internal/tlscert"
)

func main() {
	addr := ":8080"
	if p := os.Getenv("PORT"); p != "" {
		addr = ":" + p
	}
	tlsAddr := ":8443"
	if p := os.Getenv("TLS_PORT"); p != "" {
		tlsAddr = ":" + p
	}

	webFS, err := fs.Sub(assets.WebFS, "web")
	if err != nil {
		log.Fatal(err)
	}
	handler := api.NewMux(webFS)

	if certFile, keyFile, err := tlscert.EnsureCert("certs"); err != nil {
		log.Printf("could not set up HTTPS, continuing with HTTP only: %v", err)
	} else {
		go func() {
			log.Printf("Tonic (HTTPS) listening on https://localhost%s", tlsAddr)
			for _, ip := range tlscert.LANAddresses() {
				log.Printf("  -> from your phone (same WiFi, for PWA install): https://%s%s", ip, tlsAddr)
			}
			log.Printf("  (self-signed certificate: your browser will warn once - proceed anyway)")
			if err := http.ListenAndServeTLS(tlsAddr, certFile, keyFile, handler); err != nil {
				log.Printf("HTTPS server stopped: %v", err)
			}
		}()
	}

	log.Printf("Tonic listening on http://localhost%s", addr)
	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatal(err)
	}
}
