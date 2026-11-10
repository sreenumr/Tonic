<#
.SYNOPSIS
  Builds the MusicHelper web app as a single self-contained executable.

.DESCRIPTION
  Produces dist\musichelper-server.exe - the frontend (assets\web) is baked
  in via go:embed, so this one file is the entire deployable web app; no
  other files need to travel with it.

.EXAMPLE
  .\scripts\build-web.ps1
  .\scripts\build-web.ps1 -Output dist\musichelper.exe
#>
param(
    [string]$Output = "dist\musichelper-server.exe"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:Path += ";C:\Program Files\Go\bin"

$outDir = Split-Path -Parent $Output
if ($outDir -and -not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}

Write-Host "Building web app..." -ForegroundColor Cyan
go build -o $Output ./cmd/server
if ($LASTEXITCODE -ne 0) { throw "go build failed" }

Write-Host ""
Write-Host "Built: $Output" -ForegroundColor Green
Write-Host "Run it with: $Output   (listens on :8080; set `$env:PORT to change)"
