# Watchdog: keep Whisper alive, pull GitHub updates, restart apps when code changes
# Run from PowerShell: .\scripts\watchdog.ps1
# Runs indefinitely until you close the window.

$dispatchMonitor = "C:\Users\str8s\dispatch-monitor"
$nexusDispatch = "C:\Users\str8s\nexus-dispatch"

$whisperRestartInterval = [TimeSpan]::FromHours(4)
$gitPullInterval = [TimeSpan]::FromHours(6)
$healthCheckInterval = [TimeSpan]::FromMinutes(1)

$lastWhisperRestart = [DateTime]::MinValue
$lastGitPull = [DateTime]::MinValue

function Stop-ProcessOnPort($port) {
    $procIds = netstat -ano | Select-String ":$port\s+.*LISTENING" | ForEach-Object {
        ($_ -split '\s+')[-1]
    } | Select-Object -Unique
    foreach ($procId in $procIds) {
        if ($procId -and $procId -ne '0') {
            taskkill /PID $procId /F | Out-Null
        }
    }
}

function Stop-WhisperLauncher() {
    # Clean up stale PowerShell windows left behind by previous Whisper starts.
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object {
        $_.CommandLine -like "*start-whisper.ps1*"
    } | ForEach-Object {
        Write-Host "$(Get-Date) Killing stale Whisper launcher PID $($_.ProcessId)" -ForegroundColor DarkYellow
        taskkill /PID $_.ProcessId /F | Out-Null
    }
}

function Stop-AppLauncher($titleHint, $directory) {
    # Clean up stale cmd windows for the specific app directory.
    Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object {
        $_.CommandLine -like "*$titleHint*" -or $_.CommandLine -like "*cd /d `"$directory`"*"
    } | ForEach-Object {
        Write-Host "$(Get-Date) Killing stale $titleHint launcher PID $($_.ProcessId)" -ForegroundColor DarkYellow
        taskkill /PID $_.ProcessId /F | Out-Null
    }
}

function Test-WhisperAlive() {
    try {
        $res = Invoke-WebRequest -Uri "http://127.0.0.1:8178/health" -Method GET -TimeoutSec 30 -UseBasicParsing
        return $res.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Start-Whisper() {
    Write-Host "$(Get-Date) Starting Whisper..." -ForegroundColor Cyan
    Stop-ProcessOnPort 8178
    Stop-WhisperLauncher
    Start-Sleep -Seconds 2
    # Run hidden and without -NoExit so the window closes when Whisper exits.
    Start-Process powershell -ArgumentList "-ExecutionPolicy", "Bypass", "-File", "$dispatchMonitor\scripts\start-whisper.ps1" -WindowStyle Hidden

    # Wait for Whisper to finish loading the model before returning
    Write-Host "$(Get-Date) Waiting for Whisper to be ready (up to 5 minutes)..." -ForegroundColor Cyan
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        if (Test-WhisperAlive) {
            $ready = $true
            Write-Host "$(Get-Date) Whisper is ready." -ForegroundColor Green
            break
        }
        Start-Sleep -Seconds 5
    }
    if (-not $ready) {
        Write-Warning "Whisper did not become ready within 5 minutes. Watchdog will retry on next cycle."
    }
}

function Restart-Whisper() {
    Write-Host "$(Get-Date) Restarting Whisper (scheduled)..." -ForegroundColor Cyan
    Start-Whisper
    $script:lastWhisperRestart = Get-Date
}

function Pull-Repo($path) {
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
    Stop-AppLauncher $title $directory
    Start-Process cmd -ArgumentList "/c", "cd /d `"$directory`" && $command" -WindowStyle Hidden
}

function Start-App($title, $directory, $port, $command) {
    Write-Host "$(Get-Date) Starting $title..." -ForegroundColor Cyan
    Stop-ProcessOnPort $port
    Stop-AppLauncher $title $directory
    Start-Process cmd -ArgumentList "/c", "cd /d `"$directory`" && $command" -WindowStyle Hidden
}

# Initial start
Start-Whisper
$lastWhisperRestart = Get-Date
Start-App "Dispatch Monitor" $dispatchMonitor 5000 "npm run dev"
Start-App "Nexus Dispatch" $nexusDispatch 5001 "set PORT=5001 && npm run dev"

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
            Restart-App "Nexus Dispatch" $nexusDispatch 5001 "set PORT=5001 && npm run dev"
        }

        $lastGitPull = $now
    }
}
