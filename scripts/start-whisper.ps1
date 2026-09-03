[CmdletBinding()]
param(
  [string]$Model = $env:WHISPER_MODEL
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

# Nexus-dispatch can share the dispatch-monitor virtual environment.
$python = Join-Path $repoRoot ".venv-whisper\Scripts\python.exe"
if (-not (Test-Path $python)) {
  $dispatchMonitor = "C:\Users\str8s\dispatch-monitor"
  $python = Join-Path $dispatchMonitor ".venv-whisper\Scripts\python.exe"
  if (-not (Test-Path $python)) {
    throw "Whisper is not installed. Run npm run whisper:setup in dispatch-monitor first."
  }
}

if (-not $Model) {
  $Model = "medium.en"
}

$port = if ($env:WHISPER_PORT) { $env:WHISPER_PORT } else { "8178" }

$env:WHISPER_MODEL = $Model
$env:WHISPER_DEVICE = "cpu"
$env:WHISPER_COMPUTE_TYPE = "int8"
$env:HF_HOME = Join-Path $repoRoot "models"
& $python -m uvicorn whisper_service:app --app-dir (Join-Path $repoRoot "whisper") --host 0.0.0.0 --port $port
