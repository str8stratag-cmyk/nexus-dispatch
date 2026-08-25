[CmdletBinding()]
param(
  [string]$Model = "medium.en",
  [switch]$Offline
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$venvPath = Join-Path $repoRoot ".venv-whisper"
$env:HF_HOME = Join-Path $repoRoot "models"
$pythonCandidates = @(@(
  "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
  "$env:ProgramFiles\Python312\python.exe"
) | Where-Object { $_ -and (Test-Path $_) })

if (-not $pythonCandidates) {
  Write-Host "Installing Python 3.12..."
  winget install --id Python.Python.3.12 --exact --silent --accept-package-agreements --accept-source-agreements
  $pythonCandidates = @(@(
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    "$env:ProgramFiles\Python312\python.exe"
  ) | Where-Object { Test-Path $_ })
}

if (-not $pythonCandidates) {
  throw "Python 3.12 was not found after installation. Restart PowerShell and run this script again."
}

$python = $pythonCandidates[0]
if (-not (Test-Path "$env:SystemRoot\System32\vcruntime140_1.dll")) {
  Write-Host "Installing the Microsoft Visual C++ runtime..."
  winget install --id Microsoft.VCRedist.2015+.x64 --exact --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "Microsoft Visual C++ runtime installation failed."
  }
}

if (-not (Test-Path (Join-Path $venvPath "Scripts\python.exe"))) {
  & $python -m venv $venvPath
  if ($LASTEXITCODE -ne 0) {
    throw "Python virtual environment creation failed."
  }
}

$venvPython = Join-Path $venvPath "Scripts\python.exe"
New-Item -ItemType Directory -Force -Path $env:HF_HOME | Out-Null
& $venvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) {
  throw "Pip upgrade failed."
}
if ($Offline) {
  $wheelhouse = Join-Path $repoRoot "whisper-wheelhouse"
  if (-not (Test-Path $wheelhouse)) {
    throw "Offline installation requires the whisper-wheelhouse directory from the portable bundle."
  }
  & $venvPython -m pip install --no-index --find-links $wheelhouse -r (Join-Path $repoRoot "whisper\requirements.txt")
} else {
  & $venvPython -m pip install -r (Join-Path $repoRoot "whisper\requirements.txt")
}
if ($LASTEXITCODE -ne 0) {
  throw "Whisper dependency installation failed."
}

Write-Host "Downloading and warming the $Model model..."
$env:WHISPER_MODEL = $Model
& $venvPython -c "from faster_whisper import WhisperModel; WhisperModel('$Model', device='cpu', compute_type='int8'); print('Whisper model is ready.')"
if ($LASTEXITCODE -ne 0) {
  throw "Whisper model download or initialization failed."
}

Write-Host "Setup complete. Start the service with: npm run whisper:start"
