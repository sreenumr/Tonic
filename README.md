# Tonic

Real-time key, scale, and chord detection. Point it at live audio (your
microphone) or an uploaded track, and it tells you the key, the chords in
that key at four difficulty tiers, and — independently — whatever chord is
playing right now.

One Go codebase, three ways to run it: a web app in any browser, an
installable PWA, and a fully offline native Android app — all sharing the
same detection engine and frontend.

## Features

- **Live listening**: detects the song's key/scale in real time (a rolling
  ~6s window with hysteresis, so it reads as a stable "this is in X" rather
  than flickering with every chord change) and the current chord
  independently (a fast ~1.5s window).
- **File analysis**: drop a WAV/MP3 and get the same detection over the
  whole track.
- **Diatonic chords** for the detected key at four complexity tiers —
  Easy (I IV V) through Full (all 7 diatonic triads).
- **Similar-scale ranking**, not just a single best guess.
- **Fully offline** once installed (PWA or native Android app) — nothing is
  recorded, uploaded, or sent anywhere beyond your own machine/phone.

## Quick start

### Web (this machine, any browser)

```
go run ./cmd/server
```

Visit `http://localhost:8080`.

### PWA (installable icon on a phone/tablet, same WiFi)

Same server as above — visit the `https://<lan-ip>:8443` address it prints
at startup from another device on the same WiFi, accept the one-time
self-signed-certificate warning, then use the browser's "Install app" /
"Add to Home Screen" option.

### Native Android (fully offline, no PC needed)

```
.\scripts\build-android.ps1
adb install -r dist\musichelper-debug.apk
```

The only version that works with no PC involved at all — the server runs
embedded inside the app's own process.

See **`RUNNING.md`** for the full day-to-day run/rebuild reference, and
**`CUSTOMIZING.md`** for how to change the font, layout, or detection logic,
and how to produce release builds (web, desktop, Android, iOS).

## Tech stack

- **Go** for the backend and all DSP/music-theory analysis — no cgo or
  native audio dependencies on desktop.
- Plain **HTML/CSS/JS** frontend, no build step, no framework.
- **Krumhansl-Schmuckler** key-profile correlation over FFT-derived chroma
  vectors for key detection; direct chroma-vs-triad-template matching for
  the "chord playing now" estimate.
- **Android**: a thin Kotlin WebView shell + native `AudioRecord` capture,
  embedding the same Go server via `gomobile`.

## Project layout

See `Instructions.md` for the full architecture and design rationale, and
`CUSTOMIZING.md` for a practical "where do I change X" map.

## License

No license has been chosen yet — all rights reserved by default until one
is added.
