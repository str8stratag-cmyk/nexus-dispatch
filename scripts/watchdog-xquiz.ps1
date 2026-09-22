# Watchdog (Xquizit1 adaptation): keep Whisper alive, pull GitHub updates, restart apps when code changes
# Adapted from scripts/watchdog.ps1 for this machine:
#   - repo path points at this workspace (master script hardcoded C:\Users\str8s\...)
#   - node/npm/git are NOT on this box's system PATH (they live in Kimi's runtime),
#     so they are prepended here for all child processes
#   - nexus-dispatch does not exist on this box; only its comment remains
# Runs indefinitely until killed. Launch hidden from dispatch-watchdog.vbs (Startup folder)
# or manually with output redirected to logs\watchdog.log.

$dispatchMonitor = "C:\Users\XQuiz\OneDrive\Documentos\kimi\tasks\2026-09-18\13-48-46-50f944a3\dispatch-monitor"

# Make node/npm/git resolvable for child cmd/powershell processes
$nodeDir = "C:\Users\XQuiz\AppData\Local\Programs\Kimi\resources\resources\runtime"
$gitCmdDir = "C:\Users\XQuiz\AppData\Roaming\kimi-desktop\daimon-bundle\runtime\git\cmd"
$env:PATH = "$nodeDir;$gitCmdDir;$env:PATH"

$whisperRestartInterval = [TimeSpan]::FromHours(4)
$gitPullInterval = [TimeSpan]::FromHours(6)
$healthCheckInterval = [TimeSpan]::FromMinutes(1)

$lastWhisperRestart = [DateTime]::MinValue
$lastGitPull = [DateTime]::MinValue

# Fail fast if git needs credentials — an interactive prompt in the watchdog's
# hidden console wedges the entire health-check loop.
$env:GIT_TERMINAL_PROMPT = "0"

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
    # /health can block for minutes while a transcription saturates the CPU
    # (single-worker executor). A short timeout here made the watchdog kill
    # Whisper mid-transcribe every cycle on 2026-09-21 (the "5 consecutive
    # failures" incident). Be patient, and let the main loop require several
    # consecutive failures before declaring Whisper dead.
    try {
        $res = Invoke-WebRequest -Uri "http://127.0.0.1:8178/health" -Method GET -TimeoutSec 150 -UseBasicParsing
        return $res.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Test-AppAlive($port) {
    # Hit the DB-backed route — /api/health stays 200 even when Mongo is wedged.
    try {
        $res = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/events?limit=1" -Method GET -TimeoutSec 15 -UseBasicParsing
        return $res.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Stop-StrayWhisper() {
    # Kill whisper_service python processes that don't hold the port (stale
    # duplicates wedge the service by squatting on memory while a new instance
    # serves, or by holding the port while wedged).
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object {
        $_.CommandLine -like "*uvicorn whisper_service:app*"
    } | ForEach-Object {
        Write-Host "$(Get-Date) Killing stray whisper python PID $($_.ProcessId)" -ForegroundColor DarkYellow
        taskkill /PID $_.ProcessId /F | Out-Null
    }
}

# Per-app restart throttling: minimum gap between restarts of one app
$minAppRestartGap = [TimeSpan]::FromMinutes(2)
$lastAppRestart = @{ "Dispatch Monitor" = [DateTime]::MinValue }

function Restart-AppIfDead($title, $directory, $port, $command, $log) {
    if (Test-AppAlive $port) { return }
    $elapsed = ([DateTime]::Now) - $lastAppRestart[$title]
    if ($elapsed -lt $minAppRestartGap) {
        Write-Host "$(Get-Date) $title is down but was restarted $([int]$elapsed.TotalSeconds)s ago; skipping this cycle." -ForegroundColor DarkYellow
        return
    }
    Write-Host "$(Get-Date) $title (port $port) is not responding; restarting..." -ForegroundColor Cyan
    Restart-App $title $directory $port $command $log
    $lastAppRestart[$title] = Get-Date
}

function Start-Whisper() {
    Write-Host "$(Get-Date) Starting Whisper..." -ForegroundColor Cyan
    Stop-ProcessOnPort 8178
    Stop-StrayWhisper
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
    Write-Host "$(Get-Date) Restarting Whisper (scheduled or dead)..." -ForegroundColor Cyan
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
        # A dependency change without an install leaves the app unable to boot.
        $pkgChanged = git -C $path diff --name-only $before $after | Select-String -Quiet "^package(-lock)?\.json$"
        if ($pkgChanged) {
            Write-Host "$(Get-Date) package.json changed in $path - running npm install..." -ForegroundColor Cyan
            npm --prefix $path install --no-audit --no-fund
        }
        return $true
    }
    return $false
}

# App output is redirected to a log file. Like Whisper (see
# start-whisper.ps1), apps inheriting the watchdog's hidden console
# intermittently wedge on console writes and never bind their port.
function Restart-App($title, $directory, $port, $command, $log) {
    Write-Host "$(Get-Date) Restarting $title..." -ForegroundColor Cyan
    Stop-ProcessOnPort $port
    Stop-AppLauncher $title $directory
    New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
    Start-Process cmd -ArgumentList "/c", "cd /d `"$directory`" && $command >> `"$log`" 2>&1" -WindowStyle Hidden
}

function Start-App($title, $directory, $port, $command, $log) {
    Write-Host "$(Get-Date) Starting $title..." -ForegroundColor Cyan
    Stop-ProcessOnPort $port
    Stop-AppLauncher $title $directory
    New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
    Start-Process cmd -ArgumentList "/c", "cd /d `"$directory`" && $command >> `"$log`" 2>&1" -WindowStyle Hidden
}

# Initial start
Start-Whisper
$lastWhisperRestart = Get-Date
$dmLog = Join-Path $dispatchMonitor "logs\dispatch-monitor.log"
# Nexus Dispatch is dormant fleet-wide (user, 2026-09-17) and does not exist on
# this box: no repo to pull, no app to supervise.
Start-App "Dispatch Monitor" $dispatchMonitor 5000 "npm run dev" $dmLog

Write-Host "Watchdog running. Whisper restart every $($whisperRestartInterval.TotalHours)h, git pull every $($gitPullInterval.TotalHours)h." -ForegroundColor Green

$script:whisperDeadStrikes = 0
$maxWhisperDeadStrikes = 3

while ($true) {
    Start-Sleep -Seconds $healthCheckInterval.TotalSeconds

    $now = Get-Date

    # Restart Whisper periodically or if dead. "Dead" requires several
    # consecutive failed health checks — a single slow /health during a
    # transcription must NOT trigger a kill (see Test-WhisperAlive note).
    if (($now - $lastWhisperRestart) -gt $whisperRestartInterval) {
        Restart-Whisper
        $script:whisperDeadStrikes = 0
    } elseif (-not (Test-WhisperAlive)) {
        $script:whisperDeadStrikes++
        if ($script:whisperDeadStrikes -ge $maxWhisperDeadStrikes) {
            Restart-Whisper
            $script:whisperDeadStrikes = 0
        } else {
            Write-Host "$(Get-Date) Whisper health check failed ($script:whisperDeadStrikes/$maxWhisperDeadStrikes); not restarting yet." -ForegroundColor DarkYellow
        }
    } else {
        $script:whisperDeadStrikes = 0
    }

    # Restart apps if their DB-backed endpoint stops responding
    Restart-AppIfDead "Dispatch Monitor" $dispatchMonitor 5000 "npm run dev" $dmLog

    # Pull git updates periodically
    if (($now - $lastGitPull) -gt $gitPullInterval) {
        $dmUpdated = Pull-Repo $dispatchMonitor

        if ($dmUpdated) {
            Restart-App "Dispatch Monitor" $dispatchMonitor 5000 "npm run dev" $dmLog
        }

        $lastGitPull = $now
    }
}
