[CmdletBinding()]
param(
  [string]$Destination = (Join-Path ([Environment]::GetFolderPath("Desktop")) "Dispatch-Monitor-Whisper-medium.en")
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $repoRoot ".venv-whisper\Scripts\python.exe"
$modelCache = Join-Path $repoRoot "models"
$wheelhouse = Join-Path $repoRoot "whisper-wheelhouse"

if (-not (Test-Path $python) -or -not (Test-Path $modelCache)) {
  throw "Whisper and its local model cache must be installed before creating a bundle."
}

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
Remove-Item -Recurse -Force (Join-Path $Destination "models"), (Join-Path $Destination "whisper"), (Join-Path $Destination "whisper-wheelhouse") -ErrorAction SilentlyContinue
& $python -m pip download --dest $wheelhouse -r (Join-Path $repoRoot "whisper\requirements.txt")
if ($LASTEXITCODE -ne 0) {
  throw "Downloading offline Python packages failed."
}

Copy-Item -Recurse -Force $modelCache, $wheelhouse, (Join-Path $repoRoot "whisper") -Destination $Destination
Copy-Item -Force (Join-Path $repoRoot "scripts\setup-whisper.ps1"), (Join-Path $repoRoot "scripts\start-whisper.ps1") -Destination $Destination

@'
[CmdletBinding()]
param(
  [string]$ProjectPath = (Join-Path $HOME "dispatch-monitor")
)

$ErrorActionPreference = "Stop"
$bundleRoot = Split-Path -Parent $PSCommandPath
if (-not (Test-Path $ProjectPath)) {
  throw "Dispatch Monitor was not found at $ProjectPath. Clone or copy the repository there, then rerun this installer with -ProjectPath."
}

Copy-Item -Recurse -Force (Join-Path $bundleRoot "models"), (Join-Path $bundleRoot "whisper"), (Join-Path $bundleRoot "whisper-wheelhouse") -Destination $ProjectPath
Copy-Item -Force (Join-Path $bundleRoot "setup-whisper.ps1"), (Join-Path $bundleRoot "start-whisper.ps1") -Destination (Join-Path $ProjectPath "scripts")
& (Join-Path $ProjectPath "scripts\setup-whisper.ps1") -Model "medium.en" -Offline
if ($LASTEXITCODE -ne 0) {
  throw "Whisper installation failed."
}

Write-Host "Portable Whisper assets installed. Run npm run whisper:start from $ProjectPath."
'@ | Set-Content -Encoding ASCII (Join-Path $Destination "Install-Whisper.ps1")

@'
# Dispatch Monitor local Whisper bundle

Copy this folder to a USB drive. On a Windows capture device:

1. Clone or copy the `dispatch-monitor` repository to `C:\Users\<user>\dispatch-monitor`.
2. Install Node.js LTS if it is not already installed.
3. Run `Install-Whisper.ps1` from this folder. It installs Python and the C++ runtime if needed, copies the included `medium.en` cache and offline wheels, and installs without downloading Python packages or the Whisper model.
4. In the project folder, run `npm run whisper:start`, then run `npm run dev` in a second terminal.

The bundle is intended for Windows x64 capture devices. It contains no Supabase or Telegram credentials.
'@ | Set-Content -Encoding ASCII (Join-Path $Destination "README.txt")

Write-Host "Portable Whisper bundle created at $Destination"
