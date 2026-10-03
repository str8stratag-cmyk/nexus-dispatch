param([switch]$NoInitialStart)
# Watchdog: keep Whisper alive, pull released GitHub updates (origin/release), restart apps when code changes
# Run from PowerShell: .\scripts\watchdog.ps1
# Runs indefinitely until you close the window.
# -NoInitialStart: skip the initial Whisper/app start (used when the updated
# script spawns itself -- services are already running).

# Paths derive from this script's location (scripts\ under the repo root),
# so the watchdog works for any Windows user profile. Per-box overrides go in
# the untracked repo-root file watchdog.local (KEY=VALUE lines):
#   WHISPER_ROOT=C:\path\to\checkout-with-.venv-whisper   (default: this repo)
#   NEXUS_DISPATCH=C:\path\to\nexus-dispatch              (default: sibling dir)
#   DEPLOY_BRANCH=release                                  (default: release)
$dispatchMonitor = Split-Path -Parent $PSScriptRoot
$whisperRoot = $dispatchMonitor
$nexusDispatch = Join-Path (Split-Path -Parent $dispatchMonitor) "nexus-dispatch"
# The fleet deploys ONLY the release branch (2026-09-25). Commits landing on
# main -- including anything a bot pushes -- never reach the boxes until the
# owner promotes them: scripts\promote-release.ps1 (or git push origin main:release).
$deployBranch = "release"
$watchdogLocal = Join-Path $dispatchMonitor "watchdog.local"
if (Test-Path $watchdogLocal) {
    foreach ($line in Get-Content $watchdogLocal) {
        if ($line -match '^\s*(WHISPER_ROOT|NEXUS_DISPATCH|DEPLOY_BRANCH)\s*=\s*(.+?)\s*$') {
            switch ($Matches[1]) {
                "WHISPER_ROOT" { $whisperRoot = $Matches[2] }
                "NEXUS_DISPATCH" { $nexusDispatch = $Matches[2] }
                "DEPLOY_BRANCH" { $deployBranch = $Matches[2] }
            }
        }
    }
}

$whisperRestartInterval = [TimeSpan]::FromHours(4)
$gitPullInterval = [TimeSpan]::FromHours(4)
$healthCheckInterval = [TimeSpan]::FromMinutes(1)

$lastWhisperRestart = [DateTime]::MinValue
$lastGitPull = [DateTime]::MinValue

# Fail fast if git needs credentials -- an interactive prompt in the watchdog's
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
    try {
        # 60s (not 30s): under CPU contention a live process can take 45-50s
        # to answer a trivial GET /health (measured 2026-09-22). A shorter
        # timeout here kills a working process mid-response, forcing a full
        # model reload that adds even more CPU load -- self-reinforcing
        # restart loop, never actually recovers.
        $res = Invoke-WebRequest -Uri "http://127.0.0.1:8178/health" -Method GET -TimeoutSec 60 -UseBasicParsing
        return $res.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Test-AppAlive($port) {
    # Hit the DB-backed route -- /api/health stays 200 even when Mongo is wedged.
    try {
        $res = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/events?limit=1" -Method GET -TimeoutSec 15 -UseBasicParsing
        return $res.StatusCode -eq 200
    } catch {
        return $false
    }
}

# Raise a service's OS scheduling priority so Windows favors it over
# everyday desktop load (browser tabs, etc.) when cores are contended --
# this box isn't a dedicated capture box, so it runs Whisper/the app
# alongside normal desktop use. Without this, /health under load measured
# 17-48s and transcribes measured up to 58s for a 4s clip; after setting
# Whisper to High and the app to AboveNormal, health dropped to ~6s with
# the same Chrome load still running (2026-09-22, done manually first,
# then folded in here so it survives every restart, not just this session).
function Set-ServicePriority($port, $priority, $label) {
    $procId = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    if (-not $procId) { return }
    try {
        (Get-Process -Id $procId -ErrorAction Stop).PriorityClass = $priority
        Write-Host "$(Get-Date) Set $label (PID $procId) to $priority priority" -ForegroundColor DarkCyan
    } catch {
        Write-Host "$(Get-Date) Could not set priority for $label (PID $procId): $_" -ForegroundColor DarkYellow
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
$lastAppRestart = @{ "Dispatch Monitor" = [DateTime]::MinValue; "Nexus Dispatch" = [DateTime]::MinValue }

function Restart-AppIfDead($title, $directory, $port, $command, $log) {
    if (Test-AppAlive $port) { return }
    # NOTE: parenthesize Get-Date -- "Get-Date - $x" parses '-' as a parameter
    # token, $elapsed becomes $null, and the throttle below silently blocks
    # every restart (this watchdog never recovered a dead app until 2026-09-17).
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
    Start-Process powershell -ArgumentList "-ExecutionPolicy", "Bypass", "-File", (Join-Path $whisperRoot "scripts\start-whisper.ps1") -WindowStyle Hidden

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
    } else {
        Set-ServicePriority 8178 'High' 'Whisper'
    }
}

function Restart-Whisper() {
    Write-Host "$(Get-Date) Restarting Whisper (scheduled)..." -ForegroundColor Cyan
    Start-Whisper
    $script:lastWhisperRestart = Get-Date
}

function Pull-Repo($path, $branch) {
    if (-not (Test-Path (Join-Path $path ".git"))) { return $false }
    Write-Host "$(Get-Date) Pulling origin/$branch for $path..." -ForegroundColor Cyan
    # Missing branch = do nothing. Never fall back to another branch: that
    # fallback is exactly how unreviewed code would reach the fleet.
    git -C $path ls-remote --exit-code --heads origin $branch 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "$(Get-Date) origin/$branch not found for $path; skipping pull."
        return $false
    }
    $before = git -C $path rev-parse HEAD
    git -C $path pull --no-edit origin $branch 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        # Conflict with local box edits: leave the tree exactly as it was.
        Write-Warning "$(Get-Date) Pull of origin/$branch failed for $path (local changes?); left unchanged."
        git -C $path merge --abort 2>&1 | Out-Null
        return $false
    }
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
# The app log is opened in append mode (>>) and never rotated by anything
# else, so it grows forever across restarts -- hit 4.25GB on 2026-09-22.
# Cap it here, at the one place new appends begin.
$maxLogBytes = 50MB
function Limit-LogSize($log) {
    if ((Test-Path $log) -and (Get-Item $log).Length -gt $maxLogBytes) {
        $archived = "$log.previous"
        Move-Item -Force $log $archived -ErrorAction SilentlyContinue
    }
}

# Poll until something binds $port (up to $timeoutSec) so the priority
# bump below lands on the real process instead of racing its startup.
function Wait-ForPort($port, $timeoutSec = 30) {
    for ($i = 0; $i -lt $timeoutSec; $i++) {
        if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Restart-App($title, $directory, $port, $command, $log) {
    Write-Host "$(Get-Date) Restarting $title..." -ForegroundColor Cyan
    Stop-ProcessOnPort $port
    Stop-AppLauncher $title $directory
    New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
    Limit-LogSize $log
    Start-Process cmd -ArgumentList "/c", "cd /d `"$directory`" && $command >> `"$log`" 2>&1" -WindowStyle Hidden
    if (Wait-ForPort $port) { Set-ServicePriority $port 'AboveNormal' $title }
}

function Start-App($title, $directory, $port, $command, $log) {
    Write-Host "$(Get-Date) Starting $title..." -ForegroundColor Cyan
    Stop-ProcessOnPort $port
    Stop-AppLauncher $title $directory
    New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
    Limit-LogSize $log
    Start-Process cmd -ArgumentList "/c", "cd /d `"$directory`" && $command >> `"$log`" 2>&1" -WindowStyle Hidden
    if (Wait-ForPort $port) { Set-ServicePriority $port 'AboveNormal' $title }
}

# The capture UI's auto-start (audio-panel.tsx) only runs once a page is
# actually loaded -- after an unattended overnight reboot there's nobody here
# to open Chrome and navigate to it. Open it in the default browser once the
# app is confirmed listening, in the user's interactive desktop session (the
# Startup .vbs that launches this script runs at logon, not as a service, so
# a GUI window here is visible on the real desktop, same as a manual open).
function Start-Browser($url) {
    Write-Host "$(Get-Date) Opening $url in the default browser..." -ForegroundColor Cyan
    try {
        Start-Process $url
    } catch {
        Write-Warning "Could not open browser: $_"
    }
}

# Capture-page liveness (2026-10-03). The capture tab POSTs a heartbeat to the
# app every 60s and restarts its own capture after reloads/updates (see
# audio-panel.tsx). This only covers the case the page cannot fix itself: NO
# heartbeat at all for 15 min while the app has been up 15+ min (tab closed,
# renderer crashed, stuck blank). Then open the capture page again, at most
# once every 2h. localhost (not 127.0.0.1) because Chrome's mic permission is
# per origin and the desks granted it on http://localhost:5000. Any doubt --
# app down, old server without the endpoint, request error -- means "leave it".
$captureSilentLimit = [TimeSpan]::FromMinutes(15)
$captureReopenGap = [TimeSpan]::FromHours(2)
$lastCaptureReopen = [DateTime]::MinValue
$captureUrl = "http://localhost:5000"

function Test-CapturePageSilent($port) {
    try {
        $status = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/capture/status" -Method GET -TimeoutSec 15
    } catch {
        return $false
    }
    $limitMs = $captureSilentLimit.TotalMilliseconds
    if ($null -eq $status.uptimeMs -or [double]$status.uptimeMs -lt $limitMs) { return $false }
    if ($null -eq $status.lastHeartbeatAgoMs) { return $true }
    return ([double]$status.lastHeartbeatAgoMs -gt $limitMs)
}

# Always log to a file, including the -NoInitialStart self-update path: the
# watchdog runs in a hidden window, so console-only output was lost. The
# transcript captures Write-Host/Write-Warning output. Size-capped like the
# app log. Failure to open it (e.g. a launcher already redirecting into the
# same file) must never stop the watchdog.
$watchdogLog = Join-Path $dispatchMonitor "logs\watchdog-stdout.log"
New-Item -ItemType Directory -Force -Path (Split-Path $watchdogLog) | Out-Null
Limit-LogSize $watchdogLog
try {
    Start-Transcript -Path $watchdogLog -Append -Force | Out-Null
} catch {
    Write-Warning "Could not open watchdog log ${watchdogLog}: $_"
}
Write-Host "$(Get-Date) Watchdog starting (repo: $dispatchMonitor, whisper: $whisperRoot, NoInitialStart: $NoInitialStart)" -ForegroundColor Green

# Initial start
if (-not $NoInitialStart) {
    Start-Whisper
    $dmLog = Join-Path $dispatchMonitor "logs\dispatch-monitor.log"
    # Nexus Dispatch is dormant fleet-wide (user, 2026-09-17): repo keeps
    # pulling below so it stays current, but the app is not started/supervised.
    Start-App "Dispatch Monitor" $dispatchMonitor 5000 "npm run dev" $dmLog
    if (Wait-ForPort 5000 30) {
        Start-Sleep -Seconds 3
        Start-Browser "http://127.0.0.1:5000"
    }
} else {
    # Services are already running (self-update path) -- stamp the timers so
    # the loop does not immediately restart Whisper for looking "overdue".
    $lastWhisperRestart = Get-Date
}
$dmLog = Join-Path $dispatchMonitor "logs\dispatch-monitor.log"

Write-Host "Watchdog running. Whisper restart every $($whisperRestartInterval.TotalHours)h, git pull of origin/$deployBranch every $($gitPullInterval.TotalHours)h." -ForegroundColor Green

# Consecutive-failure debounce (2026-09-22): a single slow/timed-out health
# check under CPU contention is not "dead" -- restarting on one miss forces a
# model reload that adds more load, causing the next check to miss too.
# Require 2 consecutive misses (~2 health-check cycles) before restarting.
$whisperFailStreak = 0

while ($true) {
    Start-Sleep -Seconds $healthCheckInterval.TotalSeconds

    $now = Get-Date

    $whisperScheduled = ($now - $lastWhisperRestart) -gt $whisperRestartInterval
    $whisperAlive = Test-WhisperAlive
    if ($whisperAlive) { $whisperFailStreak = 0 } else { $whisperFailStreak++ }

    # Restart Whisper periodically or if confirmed dead (2+ consecutive misses)
    if ($whisperScheduled -or $whisperFailStreak -ge 2) {
        if (-not $whisperScheduled) {
            Write-Host "$(Get-Date) Whisper failed $whisperFailStreak consecutive health checks; restarting..." -ForegroundColor Yellow
        }
        $whisperFailStreak = 0
        Restart-Whisper
    }

    # Restart apps if their DB-backed endpoint stops responding
    Restart-AppIfDead "Dispatch Monitor" $dispatchMonitor 5000 "npm run dev" $dmLog

    # Reopen the capture page if no tab has heartbeated for a long time.
    if (Test-CapturePageSilent 5000) {
        $sinceReopen = ([DateTime]::Now) - $lastCaptureReopen
        if ($sinceReopen -gt $captureReopenGap) {
            Write-Host "$(Get-Date) No capture-page heartbeat for $($captureSilentLimit.TotalMinutes) min; reopening $captureUrl" -ForegroundColor Yellow
            Start-Browser $captureUrl
            $lastCaptureReopen = Get-Date
        }
    }

    # Pull git updates periodically
    if (($now - $lastGitPull) -gt $gitPullInterval) {
        $dmUpdated = Pull-Repo $dispatchMonitor $deployBranch
        # nexus-dispatch is dormant on the fleet (never started), so it keeps
        # tracking main; switch it to $deployBranch before re-enabling it.
        $ndUpdated = Pull-Repo $nexusDispatch "main"

        if ($dmUpdated) {
            # LOCAL CHANGE (2026-09-04, keep when pushing upstream): npm
            # install BEFORE restarting the app on pull -- prevents the
            # missing-dependency crash (e.g. express-rate-limit) on
            # post-pull restarts. Pull-Repo only installs when package.json
            # changed; this catches everything else.
            Write-Host "$(Get-Date) npm install (dispatch-monitor)..." -ForegroundColor Cyan
            cmd /c "cd /d `"$dispatchMonitor`" && npm install" | Out-Null
            Restart-App "Dispatch Monitor" $dispatchMonitor 5000 "npm run dev" $dmLog
        }

        # Self-update: pulling a new watchdog.ps1 does NOT fix the running
        # loop -- it keeps executing the old in-memory script until something
        # restarts it (2026-09-18: DISP-1 silently ran a pre-fix watchdog and
        # stayed dead for 16h). If the on-disk script differs from the one we
        # are running, spawn the updated script (skipping initial starts) and
        # exit. Brief overlap is safe: both loops health-check and restarts
        # are port- and throttle-guarded.
        $newWd = Join-Path $dispatchMonitor "scripts\watchdog.ps1"
        if (Test-Path $newWd) {
            $oldHash = (Get-FileHash $MyInvocation.MyCommand.Path -Algorithm SHA256).Hash
            $newHash = (Get-FileHash $newWd -Algorithm SHA256).Hash
            if ($oldHash -ne $newHash) {
                Write-Host "$(Get-Date) Watchdog script updated on disk; spawning new instance and exiting." -ForegroundColor Cyan
                # Release the log file so the new instance can append to it.
                try { Stop-Transcript | Out-Null } catch { }
                Start-Process powershell -ArgumentList "-ExecutionPolicy", "Bypass", "-File", $newWd, "-NoInitialStart" -WindowStyle Hidden
                Start-Sleep -Seconds 5
                exit
            }
        }

        $lastGitPull = $now
    }
}
