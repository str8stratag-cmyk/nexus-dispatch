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

# Optional per-box Whisper tuning from the same untracked whisper-model.local
# (KEY=VALUE lines). Only whitelisted keys are honored, and a value already set
# in the environment wins. Relative WHISPER_SAVE_AUDIO paths resolve against
# the repo root. Example (debug-audio capture on one box):
#   WHISPER_SAVE_AUDIO=whisper\debug-audio
#   WHISPER_SAVE_MAX=400
#   WHISPER_BEAM_SIZE=2          (default 5)
#   WHISPER_BEST_OF=2            (default 5)
#   WHISPER_NSP_THRESHOLD=0.7    (default 0.5)
#   WHISPER_EXTRA_FIXES=1        (default off; see whisper\text_fixes.py)
#   WHISPER_BLOCKLIST=1          (default off; whole-chunk hallucination drop)
#   WHISPER_HOTWORDS=Signal 4, Henry, ...   (default off; audit for echo)
$allowedLocalKeys = @(
  "WHISPER_SAVE_AUDIO",
  "WHISPER_SAVE_MAX",
  "WHISPER_NSP_THRESHOLD",
  "WHISPER_CR_THRESHOLD",
  "WHISPER_TRANSCRIBE_TIMEOUT",
  # 2026-09-25 per-box tuning (defaults in whisper_service.py = old behavior):
  "WHISPER_BEAM_SIZE",
  "WHISPER_BEST_OF",
  "WHISPER_HOTWORDS",
  "WHISPER_EXTRA_FIXES",
  "WHISPER_BLOCKLIST"
)
$localConfigPath = Join-Path $repoRoot "whisper-model.local"
if (Test-Path $localConfigPath) {
  foreach ($line in Get-Content $localConfigPath) {
    if ($line -match '^\s*([A-Z_]+)\s*=\s*(.+?)\s*$') {
      $key = $Matches[1]
      $value = $Matches[2]
      if (($allowedLocalKeys -notcontains $key) -or [Environment]::GetEnvironmentVariable($key)) { continue }
      if ($key -eq "WHISPER_SAVE_AUDIO" -and -not [System.IO.Path]::IsPathRooted($value)) {
        $value = Join-Path $repoRoot $value
      }
      Set-Item -Path "Env:$key" -Value $value
    }
  }
}

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
