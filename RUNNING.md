# Running MusicHelper

One Go codebase, three ways to run it (see `Instructions.md` for the
architecture/why). Quick reference for each.

## 1. Web app (this PC, browser)

Build (only needed after a code change):
```
.\scripts\build-web.ps1
```

Run:
```
dist\musichelper-server.exe
```
(or `go run ./cmd/server` straight from source, no build step)

Then visit **http://localhost:8080** in any browser. Leave the terminal
window open while using it; `Ctrl+C` (or close the window) to stop.

## 2. PWA (installable icon on another phone/tablet, via that device's browser)

Requires the web app server (above) running on this PC, and the other
device on the **same WiFi**.

1. Start the server as in #1 — it must stay running the whole time you use
   the PWA.
2. On the other device's browser, visit the `https://<lan-ip>:8443` address
   the server prints at startup (e.g. `https://192.168.1.12:8443` — re-check
   the server's own log if this PC's IP has changed).
3. Accept the one-time self-signed-certificate warning
   (**Advanced → Proceed**).
4. Use the browser's **Install app / Add to Home Screen** option.

Note: only the app *shell* (UI) is cached for offline use. Actually
analyzing audio (file upload, live listening) still needs this PC's server
running and reachable — the PWA is not a standalone app the way #3 is.

## 3. Native Android app (standalone, no PC needed)

Build (only needed after a code change):
```
.\scripts\build-android.ps1
```

Install on a phone connected via USB with USB debugging enabled:
```
adb install -r dist\musichelper-debug.apk
```

Then open **MusicHelper** from the phone's app drawer like any other app.
This is the only version that works fully offline with no PC involved at
all — the server runs embedded inside the app's own process.

## Rebuilding after code changes

| You changed... | Rebuild with |
|---|---|
| `assets/web/*`, `internal/*`, or `cmd/server/*` | Both `.\scripts\build-web.ps1` and `.\scripts\build-android.ps1` |
| Only `android/*` (Kotlin/Gradle/manifest) | `.\scripts\build-android.ps1 -SkipBind` (skips the slower `gomobile bind` step) |
| `mobile/mobile.go` | `.\scripts\build-android.ps1` (no `-SkipBind`) |

After an Android rebuild, reinstall with `adb install -r
dist\musichelper-debug.apk` and relaunch the app on the phone.
