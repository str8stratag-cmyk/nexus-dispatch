# Regression check: transcribe the fixed clip and diff against the saved baseline.
# Catches silent Whisper quality/config drift after model or code changes.
# Run from PowerShell: .\scripts\regression-check.ps1
# Re-baseline after an INTENTIONAL model/params change:
#   powershell -ExecutionPolicy Bypass -File scripts\regression-check.ps1 -UpdateBaseline
[CmdletBinding()]
param([switch]$UpdateBaseline)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$wav = Join-Path $repoRoot "test-audio.wav"
$expectedPath = Join-Path $repoRoot "test-audio.expected.txt"
if (-not (Test-Path $wav)) { throw "Missing $wav" }

$resp = curl.exe -s -m 120 -F "audio=@$wav" http://127.0.0.1:8178/transcribe | ConvertFrom-Json
$actual = $resp.text.Trim()

Write-Host "Model: $($resp.model)"

if ($UpdateBaseline) {
  Set-Content -Path $expectedPath -Value $actual -NoNewline
  Write-Host "Baseline updated: $expectedPath" -ForegroundColor Yellow
  exit 0
}

if (-not (Test-Path $expectedPath)) { throw "Missing $expectedPath (run with -UpdateBaseline once)" }
$expected = (Get-Content $expectedPath -Raw).Trim()

if ($actual -eq $expected) {
  Write-Host "PASS: transcript matches baseline" -ForegroundColor Green
  exit 0
} else {
  Write-Host "FAIL: transcript drifted from baseline" -ForegroundColor Red
  Write-Host "--- expected ---"; Write-Host $expected
  Write-Host "--- actual ---"; Write-Host $actual
  exit 1
}
