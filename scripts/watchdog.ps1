# Watchdog: keep Whisper alive, pull GitHub updates, restart apps when code changes
# Run from PowerShell: .\scripts\watchdog.ps1
# Runs indefinitely until you close the window.

$ErrorActionPreference = "SilentlyContinue"

$dispatchMonitor = Join-Path $env:USERPROFILE "dispatch-monitor"
$nexusDispatch = Join-Path $env:USERPROFILE "nexus-dispatch"

if (-not (Test-Path $dispatchMonitor)) {
    Write-Host "dispatch-monitor repo not found at $dispatchMonitor" -ForegroundColor Red
    exit 1
}

$whisperRestartInterval = [TimeSpan]::FromHours(4)
$gitPullInterval = [TimeSpan]::FromHours(6)
$healthCheckInterval = [TimeSpan]::FromMinutes(1)

$lastWhisperRestart = [DateTime]::MinValue
$lastGitPull = [DateTime]::MinValue

function Stop-ProcessOnPort($port) {
    $pids = netstat -ano | Select-String ":$port\s+.*LISTENING" | ForEach-Object {
        ($_ -split '\s+')[-1]
    } | Select-Object -Unique
    foreach ($pid in $pids) {
        if ($pid -and $pid -ne '0') {
            taskkill /PID $pid /F | Out-Null
        }
    }
}

function Test-WhisperAlive() {
    try {
        $res = Invoke-WebRequest -Uri "http://127.0.0.1:8178" -Method POST -Body '{}' -TimeoutSec 5
        return $res.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Start-Whisper() {
    Write-Host "$(Get-Date) Starting Whisper..." -ForegroundColor Cyan
    Stop-ProcessOnPort 8178
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$dispatchMonitor'; npm run whisper:start" -WindowStyle Minimized
}

function Restart-Whisper() {
    Write-Host "$(Get-Date) Restarting Whisper (scheduled)..." -ForegroundColor Cyan
    Start-Whisper
    $script:lastWhisperRestart = Get-Date
}

function Pull-Repo($path) {
    if (-not (Test-Path $path)) { return $false }
    Write-Host "$(Get-Date) Pulling updates for $path..." -ForegroundColor Cyan
    $before = git -C $path rev-parse HEAD
    git -C $path pull origin main | Out-Null
    $after = git -C $path rev-parse HEAD
    if ($before -ne $after) {
        Write-Host "$(Get-Date) Updated $path" -ForegroundColor Green
        return $true
    }
    return $false
}

function Restart-App($title, $directory, $port, $command) {
    Write-Host "$(Get-Date) Restarting $title..." -ForegroundColor Cyan
    Stop-ProcessOnPort $port
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$directory'; $command" -WindowStyle Minimized
}

# Initial start
Start-Whisper
$lastWhisperRestart = Get-Date

Write-Host "Watchdog running. Whisper restart every $($whisperRestartInterval.TotalHours)h, git pull every $($gitPullInterval.TotalHours)h." -ForegroundColor Green

while ($true) {
    Start-Sleep -Seconds $healthCheckInterval.TotalSeconds

    $now = Get-Date

    # Restart Whisper periodically or if dead
    if (($now - $lastWhisperRestart) -gt $whisperRestartInterval -or -not (Test-WhisperAlive)) {
        Restart-Whisper
    }

    # Pull git updates periodically
    if (($now - $lastGitPull) -gt $gitPullInterval) {
        $dmUpdated = Pull-Repo $dispatchMonitor
        $ndUpdated = Pull-Repo $nexusDispatch

        if ($dmUpdated) {
            Restart-App "Dispatch Monitor" $dispatchMonitor 5000 "npm run dev"
        }
        if ($ndUpdated) {
            Restart-App "Nexus Dispatch" $nexusDispatch 5001 "$env:PORT=5001; npm run dev"
        }

        $lastGitPull = $now
    }
}
