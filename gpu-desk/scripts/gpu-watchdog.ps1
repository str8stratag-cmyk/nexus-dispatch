# GPU desk Whisper watchdog. Keeps :8178 alive; restarts on crash, /health stall, or
# a wedged transcribe loop; optionally supervises loopback_capture.py.
# Launch: powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File <repo>\gpu-desk\scripts\gpu-watchdog.ps1
[CmdletBinding()]
param(
  [string]$RepoRoot = "",
  [int]$Port = 8178,
  [int]$CheckSec = 60,
  [int]$HealthTimeoutSec = 30,     # GPU answers /health fast; fleet CPU uses 60
  [int]$FailsBeforeRestart = 3,
  [int]$BootGraceSec = 240,        # first medium.en load / download
  [double]$RestartEveryHours = 0   # 0 = no timed restart (2026-10-23: 4h restart caused ~30s fleet outage); crash/stall restarts still active. Override via RESTART_EVERY_HOURS in config\gpu-desk.local
)
$ErrorActionPreference = "Continue"
$PkgRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PkgRoot }
$logDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$wdLog = Join-Path $logDir "gpu-watchdog.log"
function Log($m) { $l = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; Add-Content -Path $wdLog -Value $l; Write-Host $l }
function Limit-Log($p) { if ((Test-Path $p) -and (Get-Item $p).Length -gt 50MB) { Move-Item $p "$p.1" -Force } }

$cfg = @{ SOURCE_NAME = "WHISP-1"; LOOPBACK_CAPTURE = "off"; LOOPBACK_DEVICE = ""; CHUNK_SEC = "6"; CPU_FALLBACK = "on"; CPU_FALLBACK_AFTER = "3" }
$local = Join-Path $PkgRoot "config\gpu-desk.local"
if (Test-Path $local) { foreach ($line in Get-Content $local) { if ($line -match '^\s*(SOURCE_NAME|LOOPBACK_CAPTURE|LOOPBACK_DEVICE|CHUNK_SEC|CPU_FALLBACK|CPU_FALLBACK_AFTER|RESTART_EVERY_HOURS)\s*=\s*(.*?)\s*$') { $cfg[$Matches[1]] = $Matches[2] } } }
if ($cfg.RESTART_EVERY_HOURS) { $RestartEveryHours = [double]$cfg.RESTART_EVERY_HOURS }
$loopbackOn = $cfg.LOOPBACK_CAPTURE -match '^(on|1|true|yes)$'
$python = Join-Path $RepoRoot ".venv-whisper\Scripts\python.exe"
$transcripts = Join-Path $logDir ("transcripts-{0}.jsonl" -f $cfg.SOURCE_NAME)

function Stop-Port($p) {
  netstat -ano | Select-String ":$p\s+.*LISTENING" | ForEach-Object { ($_ -split '\s+')[-1] } | Select-Object -Unique |
    Where-Object { $_ -and $_ -ne '0' } | ForEach-Object { taskkill /PID $_ /F | Out-Null }
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like "*gpu_whisper_launch.py*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
$gpuStartFails = 0; $mode = "gpu"
function Test-Health {
  try {
    $r = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec $HealthTimeoutSec
    if ($r.ok -ne "true") { return $false }
    if ($r.device -eq "cuda") { $script:gpuStartFails = 0 }
    return $true
  } catch { return $false }
}
function Start-Whisper {
  Limit-Log (Join-Path $logDir "whisper-service.log"); Limit-Log (Join-Path $logDir "whisper-service.err.log")
  Stop-Port $Port; Start-Sleep 3
  $script:gpuStartFails++
  $cpuOk = ($cfg.CPU_FALLBACK -match '^(on|1|true|yes)$') -and (Test-Path (Join-Path $RepoRoot "scripts\start-whisper.ps1"))
  if ($cpuOk -and $script:gpuStartFails -gt [int]$cfg.CPU_FALLBACK_AFTER) {
    Log "GPU failed $($script:gpuStartFails - 1) starts in a row; FALLBACK to fleet CPU Whisper (scripts\start-whisper.ps1, small.en int8)"
    $script:mode = "cpu"
    Start-Process powershell -ArgumentList "-ExecutionPolicy","Bypass","-File",(Join-Path $RepoRoot "scripts\start-whisper.ps1") -WindowStyle Hidden
  } else {
    $script:mode = "gpu"
    & (Join-Path $PSScriptRoot "start-whisper-gpu.ps1") -RepoRoot $RepoRoot -Port "$Port"
  }
  $script:lastStart = Get-Date
}
$capProc = $null
function Ensure-Capture {
  if (-not $loopbackOn) { return }
  $hb = "$transcripts.heartbeat"
  $stale = (Test-Path $hb) -and (((Get-Date) - (Get-Item $hb).LastWriteTime).TotalSeconds -gt 120)
  if ($script:capProc -and -not $script:capProc.HasExited -and -not $stale) { return }
  if ($script:capProc -and -not $script:capProc.HasExited) { Log "capture heartbeat stale; killing PID $($script:capProc.Id)"; Stop-Process -Id $script:capProc.Id -Force }
  $a = @((Join-Path $PkgRoot "service\loopback_capture.py"), "--source", $cfg.SOURCE_NAME, "--chunk-sec", $cfg.CHUNK_SEC, "--out", $transcripts)
  if ($cfg.LOOPBACK_DEVICE) { $a += @("--device", $cfg.LOOPBACK_DEVICE) }
  $script:capProc = Start-Process -FilePath $python -ArgumentList $a -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logDir "loopback-capture.log") -RedirectStandardError (Join-Path $logDir "loopback-capture.err.log")
  Log "loopback capture started PID $($script:capProc.Id) source=$($cfg.SOURCE_NAME) -> $transcripts"
}

Limit-Log $wdLog
Log "gpu-watchdog start restartEveryHours=$RestartEveryHours repo=$RepoRoot port=$Port source=$($cfg.SOURCE_NAME) loopback=$loopbackOn"
if ($cfg.SOURCE_NAME -eq "WHISP-1") { Log "WARNING: SOURCE_NAME is the WHISP-1 placeholder - confirm the fleet name" }
$lastStart = [DateTime]::MinValue; $fails = 0
if (-not (Test-Health)) { Log "Whisper not healthy at boot; starting"; Start-Whisper }

while ($true) {
  Start-Sleep $CheckSec
  $inGrace = ((Get-Date) - $lastStart).TotalSeconds -lt $BootGraceSec
  if (Test-Health) {
    if ($fails) { Log "health recovered after $fails fail(s)" }; $fails = 0
  } elseif (-not $inGrace) {
    $fails++; Log "health check failed ($fails/$FailsBeforeRestart)"
    $listening = netstat -ano | Select-String ":$Port\s+.*LISTENING"
    if (-not $listening) { Log "nothing listening on $Port (crash/exit); restarting now"; Start-Whisper; $fails = 0 }
    elseif ($fails -ge $FailsBeforeRestart) { Log "stall: port open but /health dead; restarting"; Start-Whisper; $fails = 0 }
  }
  if ($RestartEveryHours -gt 0 -and $lastStart -ne [DateTime]::MinValue -and ((Get-Date) - $lastStart).TotalHours -ge $RestartEveryHours) { Log "scheduled ${RestartEveryHours}h restart (mode=$mode)"; if ($mode -eq "cpu") { $script:gpuStartFails = 0 }; Start-Whisper }
  elseif ($lastStart -eq [DateTime]::MinValue) { $lastStart = Get-Date }
  Ensure-Capture
}

