# Build a distributable zip of the Rapid Reporter extension.
# Usage:  powershell -ExecutionPolicy Bypass -File build.ps1

$ErrorActionPreference = "Stop"

$version = (Get-Content manifest.json -Raw | ConvertFrom-Json).version
$out = "rapid-reporter-$version.zip"

# Only the files Chrome needs to run the extension.
$files = @(
  "manifest.json",
  "background.js",
  "capture.js",
  "popup.js",
  "options.html",
  "options.js",
  "sidepanel.html",
  "styles.css",
  "icons",
  "LICENSE"
)

if (Test-Path $out) { Remove-Item $out }
Compress-Archive -Path $files -DestinationPath $out
Write-Host "Built $out"
