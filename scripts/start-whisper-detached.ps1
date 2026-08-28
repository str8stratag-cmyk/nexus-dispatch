[CmdletBinding()]
param(
  [string]$Model = "turbo",
  [string]$Port = "8178"
)

$ErrorActionPreference = "Stop"
$repoRoot = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { Get-Location }
$python = Join-Path $repoRoot ".venv-whisper\Scripts\python.exe"

if (-not (Test-Path $python)) {
  throw "Whisper is not installed. Run npm run whisper:setup first."
}

$env:WHISPER_MODEL = $Model
$env:WHISPER_DEVICE = "cpu"
$env:WHISPER_COMPUTE_TYPE = "int8"
$env:HF_HOME = Join-Path $repoRoot "models"

$outLog = Join-Path $repoRoot "whisper-$Model-out.log"
$errLog = Join-Path $repoRoot "whisper-$Model-err.log"
$appDir = Join-Path $repoRoot "whisper"

Start-Process `
  -FilePath $python `
  -ArgumentList "-m", "uvicorn", "whisper_service:app", "--app-dir", $appDir, "--host", "127.0.0.1", "--port", $Port `
  -WorkingDirectory $repoRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog

Write-Host "Whisper service started in background. Model: $Model, Port: $Port"
Write-Host "Stdout log: $outLog"
Write-Host "Stderr log: $errLog"
Write-Host "Health check: curl http://127.0.0.1:$Port/health"
