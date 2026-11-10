# Customizing & Building Tonic

A practical "where do I change X" reference — for tweaking the look, the
detection logic, or producing a release build, without needing an AI
session to find the right file each time. For the *why* behind the
architecture, see `Instructions.md`; for day-to-day run commands, see
`RUNNING.md`. This file is the "how do I change/ship something" reference.

## Where things live (quick map)

```
assets/web/index.html      Page structure/markup
assets/web/style.css       ALL visual styling: colors, fonts, spacing, motion
assets/web/app.js          Frontend behavior: rendering results, mic/file panels
assets/web/manifest.json   PWA name/icons/theme color
assets/web/sw.js           Offline caching (service worker)

internal/theory/theory.go    Music theory: key profiles, diatonic chords, tiers
internal/dsp/chroma.go       FFT -> 12-bin chroma vector extraction
internal/analysis/analysis.go  Glues dsp+theory together; rolling-window tuning
internal/audio/decode.go     WAV/MP3 file decoding
internal/api/*.go            HTTP + WebSocket endpoints

cmd/server/main.go   Desktop/web entry point (HTTP :8080 + HTTPS :8443)
mobile/mobile.go     Android-embedded entry point (127.0.0.1 only)
android/             Kotlin WebView shell - the only genuinely platform-
                     specific code (mic capture, permissions, app label/theme)
```

**Important:** `assets/web/` is the *same* frontend for the web app, the
PWA, and the Android app — it's baked into both binaries via `go:embed`
(`assets/assets.go`). Editing it once updates all three; you don't edit
anything per-platform for UI changes.

## Changing the font

Edit `assets/web/style.css`, the `body` rule's `font-family`:

```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
```

Two options:

1. **Swap the system-font stack** (zero extra files, still fully offline).
   E.g. for a rounder feel: `font-family: ui-rounded, -apple-system, "Segoe UI", sans-serif;`
2. **Bundle a custom font file** (e.g. Inter, Space Grotesk):
   - Download the `.woff2` file(s) and put them under `assets/web/fonts/`.
   - Add an `@font-face` block near the top of `style.css`:
     ```css
     @font-face {
       font-family: "YourFont";
       src: url("/fonts/yourfont.woff2") format("woff2");
       font-weight: 400 700; /* if it's a variable font */
       font-display: swap;
     }
     ```
   - Reference `"YourFont"` first in the `body` rule's stack.
   - **Self-host it** (don't link to Google Fonts or any CDN) — the native
     Android app and the offline-installed PWA have no guaranteed internet
     access at runtime, and a CDN link would silently fall back to the
     system font (or fail entirely) offline. Because it lives under
     `assets/web/`, a locally-hosted file ships automatically in both
     build targets, same as any other asset.

## Changing layout / alignment

- Structure: `assets/web/index.html`.
- Positioning/spacing: `assets/web/style.css` — search for the class name
  shown in your browser's dev tools inspector. Key ones:
  - `.panels` — the responsive 1/2-column card layout.
  - `.card-head` — the icon + title + status-dot row on each card.
  - `.chord-grid` / `.chord-chip` — the chord tile grid.
  - `.level-tabs` — the Easy/Medium/Hard/Full pill selector.
- Plain CSS Grid/Flexbox, no framework, no build step — edit and reload.

## Changing colors/theme

All colors are CSS custom properties at the top of `assets/web/style.css`:
`:root { ... }` for light mode, `@media (prefers-color-scheme: dark) { :root { ... } }`
for dark mode. Change `--series-blue`, `--page`, `--text-primary`, etc.
there rather than hunting through individual rules — everything references
these variables.

## Changing business logic (the actual detection)

- **Which chords a key offers at each difficulty**: `internal/theory/theory.go`,
  the `levelDegrees` map (`LevelEasy` = `{1,4,5}`, etc.).
- **How quickly the detected key "changes its mind"**: `internal/analysis/analysis.go`,
  the constants block at the top — `keyWindowSeconds`, `keySwitchMargin`,
  `chordSilenceRMS`, `rootBiasWeight`, all commented inline with what they
  trade off.
- **Adding a new scale/mode** (e.g. Dorian, Mixolydian): add a new `Mode`
  constant + interval table + Krumhansl-Schmuckler profile in
  `internal/theory/theory.go`, following the existing `Major`/`Minor`
  pattern. `CorrelateKey` and `DiatonicChords` already iterate over
  whatever modes exist — no other file needs to change.
- **Changing upload limits / adding an endpoint**: `internal/api/handlers.go`
  (`maxUploadBytes`, `NewMux`).

## Rebuilding after ANY change

| You changed... | Rebuild with |
|---|---|
| `assets/web/*`, `internal/*`, or `cmd/server/*` | **Both** `.\scripts\build-web.ps1` **and** `.\scripts\build-android.ps1` |
| Only `android/*` (Kotlin/Gradle/manifest/theme/strings) | `.\scripts\build-android.ps1 -SkipBind` (skips the slow `gomobile bind` step) |
| `mobile/mobile.go` | `.\scripts\build-android.ps1` (no `-SkipBind`) |

Then:
- **Web**: relaunch `dist\musichelper-server.exe`, refresh the browser.
- **Android**: `adb install -r dist\musichelper-debug.apk`, relaunch the app.
  If a change doesn't seem to show up in the app, the service worker may be
  serving a stale cached shell — bump `CACHE_NAME` in `assets/web/sw.js`
  (e.g. `"tonic-shell-v1"` -> `"tonic-shell-v2"`) to force it to invalidate,
  then rebuild/reinstall again.

## Fixing the "Android app compatibility" / 16 KB page size warning

Opening the app on a newer Android device (15+) can show a popup:
`This app isn't 16 KB-compatible. ELF alignment check failed... lib/arm64-v8a/libgojni.so: LOAD segment not aligned.`
The app still runs fine - it's a compatibility warning, not a crash - but
Google Play will eventually reject app updates that don't fix it.

**Cause**: `libgojni.so` is the native library `gomobile bind` compiles from
the Go code. Android 15+ devices can use 16 KB memory pages instead of the
old 4 KB default, which requires every bundled native library's ELF LOAD
segments to be aligned to 16 KB. NDK r28+ makes that the default, but this
project pins NDK 26.1.10909125 (see `build-android.ps1`'s `$NdkVersion`),
which predates that default.

**Fix (already applied)**: `scripts/build-android.ps1` sets
`CGO_LDFLAGS = "-Wl,-z,max-page-size=16384"` before invoking `gomobile bind`,
which tells the linker to align to 16 KB regardless of NDK version - no NDK
upgrade required. This only takes effect on an actual rebind, so after
pulling this change: `.\scripts\build-android.ps1` (not `-SkipBind` - the
flag only matters when `gomobile bind` actually runs), then
`adb install -r dist\musichelper-debug.apk`.

To verify a built `.aar`/`.apk` is actually aligned without waiting to see
the warning on-device, check the `.so`'s LOAD segment alignment directly
with the NDK's `readelf` (look for `Align` on `LOAD` lines - `0x4000` =
16 KB aligned/fixed, `0x1000` = 4 KB/still broken):

```powershell
& "$env:LOCALAPPDATA\Android\Sdk\ndk\26.1.10909125\toolchains\llvm\prebuilt\windows-x86_64\bin\llvm-readelf.exe" `
    -l "android\app\libs\musichelper.aar"   # or extract libgojni.so from the .aar/.apk zip first
```

An alternative (not used here) is upgrading `$NdkVersion` to r28+
(e.g. `28.1.13356709`, installed via
`sdkmanager "ndk;28.1.13356709"`), which 16KB-aligns by default without
needing the explicit linker flag - but that's a bigger toolchain change than
necessary just to fix this warning.

## Production builds

### Web (the exe you already build day-to-day)

`.\scripts\build-web.ps1` already produces a real, self-contained release
binary — there's no separate "dev vs. prod mode"; the frontend is embedded,
there's no hot-reload/dev server involved. For deploying it somewhere
beyond your own LAN:

- Put a real reverse proxy (Caddy, nginx) or a real (non-self-signed)
  certificate in front of it if it needs to be reachable from the public
  internet rather than just your WiFi.
- `PORT` / `TLS_PORT` env vars control the listen ports (default `8080`/`8443`).

### Desktop, other OSes (Mac/Linux)

There's no separate "desktop app" wrapper — the web server binary *is* the
desktop app. Cross-compile from this Windows machine using Go's built-in
cross-compilation (no cgo/native deps to worry about — even the TLS cert
generation is pure Go):

```powershell
$env:GOOS="darwin"; $env:GOARCH="arm64"; go build -o dist/tonic-server-mac ./cmd/server
$env:GOOS="linux";  $env:GOARCH="amd64"; go build -o dist/tonic-server-linux ./cmd/server
# reset afterward so plain `go build`/the build scripts target Windows again:
Remove-Item Env:GOOS, Env:GOARCH
```

Not yet verified on real Mac/Linux hardware — should work given there are
no native dependencies, but hasn't been tested outside this Windows machine.

### Android production (signed release APK)

`.\scripts\build-android.ps1 -Variant release` produces
`dist\musichelper-release.apk`, but it's **unsigned** — Android refuses to
install an unsigned release build, and no signing keystore exists in this
repo yet. To actually ship one:

1. Generate a signing keystore once, and keep it somewhere safe forever —
   losing it means you can never update the app again under the same
   identity:
   ```
   keytool -genkeypair -v -keystore tonic-release.keystore -alias tonic -keyalg RSA -keysize 2048 -validity 10000
   ```
2. Add a `signingConfigs { release { ... } }` block to
   `android/app/build.gradle.kts`, referenced from `buildTypes.release` —
   not currently set up (no keystore existed to configure it against).
3. Rebuild: `.\scripts\build-android.ps1 -Variant release`.
4. For Play Store distribution: bump `versionCode`/`versionName` in
   `android/app/build.gradle.kts` each release, and review
   `isMinifyEnabled`/ProGuard rules if you turn on shrinking later (currently
   off).

### iOS (not yet built)

There is **no iOS app in this repo yet** — `android/` is currently the only
native shell. The Go side needs no changes to support it:
`gomobile bind -target=ios -o Tonic.xcframework ./mobile` produces an
`.xcframework` from the exact same `mobile/mobile.go` Android already uses.

What's still missing is the iOS-side host app: an Xcode project with a
`WKWebView` that calls the bound `Mobile.start(port)` and then loads
`http://127.0.0.1:<port>/`, equivalent to what
`android/.../MainActivity.kt` does in Kotlin — plus:

- `NSMicrophoneUsageDescription` in `Info.plist` for mic permission.
- Likely native `AVAudioEngine` capture rather than relying on
  `WKWebView`'s own `getUserMedia`, by analogy with the WebView/Chromium mic
  bug hit on Android (see `Instructions.md`'s progress log) — untested
  whether iOS's WKWebView has the same issue, but worth assuming until
  proven otherwise.

This requires a Mac with Xcode to build and cannot be done from this
Windows machine. Rough shape of the steps once on one:

```
gomobile bind -target=ios -o Tonic.xcframework ./mobile
# then create a new Xcode project, add Tonic.xcframework, and write a
# SwiftUI/UIKit host analogous to MainActivity.kt
```
