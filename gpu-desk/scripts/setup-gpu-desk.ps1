# GPU desk setup (RTX 2060 6GB). Run from <dispatch-monitor>\gpu-desk\ :
#   powershell -ExecutionPolicy Bypass -File .\gpu-desk\scripts\setup-gpu-desk.ps1 [-Model medium.en] [-SkipModelDownload]
# Reuses the fleet layout: <repo>\.venv-whisper, <repo>\models (HF_HOME), <repo>\logs.
[CmdletBinding()]
param(
  [string]$RepoRoot = "",
  [ValidateSet("medium.en","small.en")][string]$Model = "medium.en",
  [switch]$SkipModelDownload
)
$ErrorActionPreference = "Stop"
$PkgRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PkgRoot }
function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }

if (-not (Test-Path (Join-Path $RepoRoot "whisper\whisper_service.py"))) {
  throw "No whisper\whisper_service.py under $RepoRoot. Clone dispatch-monitor (branch release) first and put gpu-desk\ inside it."
}

Step "GPU / driver check (nvidia-smi)"
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if (-not $smi) { $c = "$env:SystemRoot\System32\nvidia-smi.exe"; if (Test-Path $c) { $smi = Get-Item $c } }
if (-not $smi) { throw "nvidia-smi not found. Install the NVIDIA Game Ready/Studio driver (R525+ for CUDA 12) and re-run." }
$q = & $smi.Source --query-gpu=name,driver_version,memory.total --format=csv,noheader
Write-Host "  $q"
$cudaLine = (& $smi.Source) | Select-String "CUDA Version:\s*([\d\.]+)"
if ($cudaLine) {
  $cudaVer = [version]$cudaLine.Matches[0].Groups[1].Value
  Write-Host "  Driver supports CUDA $cudaVer"
  if ($cudaVer.Major -lt 12) { throw "Driver only supports CUDA $cudaVer; CTranslate2 4.x needs CUDA 12. Update the NVIDIA driver." }
}
Write-Host "  CUDA toolkit is NOT required: cuBLAS 12 + cuDNN 9 come from pip wheels into the venv."

Step "Python 3.12"
$py = @("$env:LOCALAPPDATA\Programs\Python\Python312\python.exe","$env:ProgramFiles\Python312\python.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $py) {
  winget install --id Python.Python.3.12 --exact --silent --accept-package-agreements --accept-source-agreements
  $py = @("$env:LOCALAPPDATA\Programs\Python\Python312\python.exe","$env:ProgramFiles\Python312\python.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $py) { throw "Python 3.12 not found after winget install." }

Step "venv $RepoRoot\.venv-whisper"
$venvPy = Join-Path $RepoRoot ".venv-whisper\Scripts\python.exe"
if (-not (Test-Path $venvPy)) { & $py -m venv (Join-Path $RepoRoot ".venv-whisper") }
& $venvPy -m pip install --upgrade pip
& $venvPy -m pip install -r (Join-Path $PkgRoot "config\requirements-gpu.txt")
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

Step "CUDA / cuDNN smoke test + model download ($Model)"
$env:HF_HOME = Join-Path $RepoRoot "models"
$probe = @"
import os, site, sys
from pathlib import Path
for r in site.getsitepackages():
    for b in (Path(r)/'nvidia').glob('*/bin'):
        os.add_dll_directory(str(b)); os.environ['PATH']=str(b)+os.pathsep+os.environ['PATH']
import ctranslate2
n = ctranslate2.get_cuda_device_count()
print('cuda devices:', n)
if n < 1: sys.exit(3)
print('supported compute types:', sorted(ctranslate2.get_supported_compute_types('cuda')))
if '$SkipModelDownload' != 'True':
    from faster_whisper import WhisperModel
    for ct in ('float16','int8_float16'):
        try:
            WhisperModel('$Model', device='cuda', compute_type=ct); print('model OK on', ct); break
        except Exception as e:
            print('compute_type', ct, 'failed:', e)
    else:
        sys.exit(4)
"@
$probe | & $venvPy -
if ($LASTEXITCODE -ne 0) { throw "CUDA probe failed (exit $LASTEXITCODE). See output above." }

Step "Per-desk config $PkgRoot\config\gpu-desk.local"
$local = Join-Path $PkgRoot "config\gpu-desk.local"
if (-not (Test-Path $local)) {
  (Get-Content (Join-Path $PkgRoot "config\gpu-desk.local.example")) -replace '^WHISPER_MODEL=.*$', "WHISPER_MODEL=$Model" | Set-Content -Encoding UTF8 $local
  Write-Host "  wrote $local from example (edit SOURCE_NAME!)"
} else { Write-Host "  exists, left untouched" }

# Fleet clients chunk via VITE_CHUNK_MS in the untracked .env.local; set 6000 only if the key is absent.
$envLocal = Join-Path $RepoRoot ".env.local"
if (-not ((Test-Path $envLocal) -and (Select-String -Path $envLocal -Pattern '^\s*VITE_CHUNK_MS\s*=' -Quiet))) {
  Add-Content -Path $envLocal -Value "VITE_CHUNK_MS=6000"
  Write-Host "  added VITE_CHUNK_MS=6000 to .env.local (restart the app to apply)"
}
Write-Host "`nDone. Launch: powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\gpu-watchdog.ps1`"" -ForegroundColor Green

