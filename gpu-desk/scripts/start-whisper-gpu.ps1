# GPU twin of scripts\start-whisper.ps1: same port (8178), venv, HF_HOME, log files,
# hidden Start-Process with file sinks. Differences: cuda + float16/int8_float16 fallback,
# medium.en default (this desk only), beam 2 default.
[CmdletBinding()]
param([string]$RepoRoot = "", [string]$Port = "8178")
$ErrorActionPreference = "Stop"
$PkgRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PkgRoot }
$python = Join-Path $RepoRoot ".venv-whisper\Scripts\python.exe"
if (-not (Test-Path $python)) { throw "Whisper venv missing. Run gpu-desk\scripts\setup-gpu-desk.ps1 first." }

$cfg = @{ WHISPER_MODEL = "medium.en"; WHISPER_BEAM_SIZE = "5"; WHISPER_BEST_OF = "5"; WHISPER_COMPUTE_TYPES = "float16,int8_float16" }
$local = Join-Path $PkgRoot "config\gpu-desk.local"
# Same whitelist as fleet start-whisper.ps1, plus the GPU keys. Env already set wins.
$allowed = @("WHISPER_MODEL","WHISPER_BEAM_SIZE","WHISPER_BEST_OF","WHISPER_COMPUTE_TYPES","WHISPER_SAVE_AUDIO","WHISPER_SAVE_MAX",
             "WHISPER_NSP_THRESHOLD","WHISPER_CR_THRESHOLD","WHISPER_TRANSCRIBE_TIMEOUT","WHISPER_HOTWORDS","WHISPER_EXTRA_FIXES","WHISPER_BLOCKLIST")
if (Test-Path $local) {
  foreach ($line in Get-Content $local) {
    if ($line -match '^\s*([A-Z_]+)\s*=\s*(.+?)\s*$' -and ($allowed -contains $Matches[1])) {
      $v = $Matches[2]
      if ($Matches[1] -eq "WHISPER_SAVE_AUDIO" -and -not [IO.Path]::IsPathRooted($v)) { $v = Join-Path $RepoRoot $v }
      $cfg[$Matches[1]] = $v
    }
  }
}
foreach ($k in $cfg.Keys) {
  if ($k -eq "WHISPER_COMPUTE_TYPES") { continue }
  if (-not [Environment]::GetEnvironmentVariable($k)) { Set-Item "Env:$k" $cfg[$k] }
}
if (@("medium.en","small.en") -notcontains $env:WHISPER_MODEL.ToLower()) {
  Write-Warning "Model '$env:WHISPER_MODEL' not allowed on GPU desk; using medium.en."; $env:WHISPER_MODEL = "medium.en"
}
$env:WHISPER_DEVICE = "cuda"
$env:HF_HOME = Join-Path $RepoRoot "models"

$logDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Start-Process -FilePath $python `
  -ArgumentList (Join-Path $PkgRoot "service\gpu_whisper_launch.py"),'--app-dir',(Join-Path $RepoRoot 'whisper'),'--host','0.0.0.0','--port',$Port,'--compute-types',$cfg.WHISPER_COMPUTE_TYPES `
  -WorkingDirectory $RepoRoot `
  -RedirectStandardOutput (Join-Path $logDir "whisper-service.log") `
  -RedirectStandardError (Join-Path $logDir "whisper-service.err.log") `
  -WindowStyle Hidden
Write-Host "Whisper GPU starting: $env:WHISPER_MODEL cuda beam=$env:WHISPER_BEAM_SIZE port=$Port  (logs\whisper-service*.log)"

