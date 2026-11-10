<#
.SYNOPSIS
  Builds the MusicHelper native Android app APK from the same Go codebase.

.DESCRIPTION
  Two steps, from the same source as the web app:
    1. gomobile bind - compiles internal/*, assets (the same web/ frontend),
       and mobile/mobile.go into android\app\libs\musichelper.aar.
    2. gradlew assembleDebug|assembleRelease - builds the APK around it.
  Output is copied to dist\musichelper-<variant>.apk.

.EXAMPLE
  .\scripts\build-android.ps1
  .\scripts\build-android.ps1 -Variant release
  .\scripts\build-android.ps1 -SkipBind   # rebuild the APK only, reusing the existing .aar
#>
param(
    [ValidateSet("debug", "release")]
    [string]$Variant = "debug",
    [string]$AndroidHome = "$env:LOCALAPPDATA\Android\Sdk",
    [string]$NdkVersion = "26.1.10909125",
    [string]$JavaHome = "C:\Program Files\Java\jdk-24",
    [switch]$SkipBind
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:Path += ";C:\Program Files\Go\bin"
$env:ANDROID_HOME = $AndroidHome
$env:ANDROID_NDK_HOME = Join-Path $AndroidHome "ndk\$NdkVersion"
$env:JAVA_HOME = $JavaHome

if (-not (Test-Path $env:ANDROID_NDK_HOME)) {
    throw "NDK not found at $env:ANDROID_NDK_HOME - install it with: sdkmanager `"ndk;$NdkVersion`""
}

$gopath = (& go env GOPATH)
$env:Path += ";$gopath\bin"

if (-not $SkipBind) {
    Write-Host "Binding Go code to Android AAR (gomobile bind)..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path "android\app\libs" | Out-Null
    # 16 KB ELF alignment for libgojni.so: the installed NDK (26.x) predates
    # NDK r28's 16KB-by-default linker behavior, so this flag is passed
    # explicitly - without it Android 15+ devices show a "16 KB page size"
    # compatibility warning on launch (app still runs, but Play Store will
    # reject uploads without this once enforcement lands).
    $env:CGO_LDFLAGS = "-Wl,-z,max-page-size=16384"
    gomobile bind -target=android -androidapi 24 -o android\app\libs\musichelper.aar ./mobile
    if ($LASTEXITCODE -ne 0) { throw "gomobile bind failed" }
} else {
    Write-Host "Skipping gomobile bind, reusing existing android\app\libs\musichelper.aar" -ForegroundColor Yellow
}

Write-Host "Building Android APK ($Variant)..." -ForegroundColor Cyan
Push-Location android
try {
    if ($Variant -eq "debug") {
        .\gradlew.bat assembleDebug
        $apk = "app\build\outputs\apk\debug\app-debug.apk"
    } else {
        .\gradlew.bat assembleRelease
        $apk = "app\build\outputs\apk\release\app-release-unsigned.apk"
    }
    if ($LASTEXITCODE -ne 0) { throw "gradlew assemble$($Variant.Substring(0,1).ToUpper() + $Variant.Substring(1)) failed" }
} finally {
    Pop-Location
}

New-Item -ItemType Directory -Force -Path "dist" | Out-Null
$dest = "dist\musichelper-$Variant.apk"
Copy-Item "android\$apk" $dest -Force

Write-Host ""
Write-Host "Built: $dest" -ForegroundColor Green
Write-Host "Install on a connected device with: adb install -r $dest"
if ($Variant -eq "release") {
    Write-Host "Note: this release build is unsigned - it must be signed before it can be installed." -ForegroundColor Yellow
}
