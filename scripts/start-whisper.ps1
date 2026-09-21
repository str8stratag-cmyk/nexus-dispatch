[CmdletBinding()]
param(
  [string]$Model = $env:WHISPER_MODEL
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $repoRoot ".venv-whisper\Scripts\python.exe"

if (-not (Test-Path $python)) {
  throw "Whisper is not installed. Run npm run whisper:setup first."
}

if (-not $Model) {
  $configPath = Join-Path $repoRoot "whisper-model.local"
  if (Test-Path $configPath) {
    foreach ($line in Get-Content $configPath) {
      if ($line -match '^\s*WHISPER_MODEL\s*=\s*(.+?)\s*$') {
        $Model = $Matches[1]
        break
      }
    }
  }
}

if (-not $Model) {
  $Model = "medium.en"
}

$env:WHISPER_MODEL = $Model
$env:WHISPER_DEVICE = "cpu"
$env:WHISPER_COMPUTE_TYPE = "int8"
$env:HF_HOME = Join-Path $repoRoot "models"

# Launch with output redirected to log files. Inheriting a hidden console
# window intermittently wedges the process on console writes (blocked at
# startup, unkillable); a file sink avoids the console entirely. Start-Process
# (not "&") so uvicorn's stderr can't hit $ErrorActionPreference="Stop".
$logDir = Join-Path $repoRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Start-Process -FilePath $python `
  -ArgumentList '-m','uvicorn','whisper_service:app','--app-dir',(Join-Path $repoRoot 'whisper'),'--host','0.0.0.0','--port','8178' `
  -RedirectStandardOutput (Join-Path $logDir "whisper-service.log") `
  -RedirectStandardError (Join-Path $logDir "whisper-service.err.log") `
  -WindowStyle Hidden
