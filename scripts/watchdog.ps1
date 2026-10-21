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
#   APP_BOOT_WAIT_SEC=300                                  (default: 300; see boot grace below)
#   CAPTURE_NO_CHUNK_MIN=5                                 (default: 5; see capture outage below)
#   CAPTURE_INACTIVE_MIN=5     no REAL audio (sent>0 or level>0) this long = outage (default: CAPTURE_NO_CHUNK_MIN)
#   CAPTURE_RELAUNCH_CHROME=on recover didn't help: close Chrome and reopen ONE capture tab (on|off, default on)
#   CHROME_CAPTURE_POLICY=on   write HKCU Chrome policy allowing mic/autoplay on the capture origins (on|off, default on)
$dispatchMonitor = Split-Path -Parent $PSScriptRoot
$whisperRoot = $dispatchMonitor
$nexusDispatch = Join-Path (Split-Path -Parent $dispatchMonitor) "nexus-dispatch"
# The fleet deploys ONLY the release branch (2026-09-25). Commits landing on
# main -- including anything a bot pushes -- never reach the boxes until the
# owner promotes them: scripts\promote-release.ps1 (or git push origin main:release).
$deployBranch = "release"
$appBootWaitSec = 300
$captureNoChunkMin = 5
$captureInactiveMin = 0
$captureRelaunchChrome = $true
$chromeCapturePolicy = $true
$watchdogLocal = Join-Path $dispatchMonitor "watchdog.local"
if (Test-Path $watchdogLocal) {
    foreach ($line in Get-Content $watchdogLocal) {
        if ($line -match '^\s*(WHISPER_ROOT|NEXUS_DISPATCH|DEPLOY_BRANCH|APP_BOOT_WAIT_SEC|CAPTURE_NO_CHUNK_MIN|CAPTURE_INACTIVE_MIN|CAPTURE_RELAUNCH_CHROME|CHROME_CAPTURE_POLICY)\s*=\s*(.+?)\s*$') {
            switch ($Matches[1]) {
                "WHISPER_ROOT" { $whisperRoot = $Matches[2] }
                "NEXUS_DISPATCH" { $nexusDispatch = $Matches[2] }
                "DEPLOY_BRANCH" { $deployBranch = $Matches[2] }
                "APP_BOOT_WAIT_SEC" {
                    # Ignore junk / tiny values rather than break the boot wait.
                    $parsedWait = 0
                    if ([int]::TryParse($Matches[2], [ref]$parsedWait) -and $parsedWait -ge 30) { $appBootWaitSec = $parsedWait }
                }
                "CAPTURE_NO_CHUNK_MIN" {
                    $parsedMin = 0
                    if ([int]::TryParse($Matches[2], [ref]$parsedMin) -and $parsedMin -ge 2) { $captureNoChunkMin = $parsedMin }
                }
                "CAPTURE_INACTIVE_MIN" {
                    $parsedMin = 0
                    if ([int]::TryParse($Matches[2], [ref]$parsedMin) -and $parsedMin -ge 2) { $captureInactiveMin = $parsedMin }
                }
                "CAPTURE_RELAUNCH_CHROME" { $captureRelaunchChrome = ($Matches[2] -notmatch '^(off|0|false|no)$') }
                "CHROME_CAPTURE_POLICY" { $chromeCapturePolicy = ($Matches[2] -notmatch '^(off|0|false|no)$') }
            }
        }
    }
}

$whisperRestartInterval = [TimeSpan]::FromHours(4)
$gitPullInterval = [TimeSpan]::FromHours(4)
$healthCheckInterval = [TimeSpan]::FromMinutes(1)
if ($captureInactiveMin -lt 2) { $captureInactiveMin = $captureNoChunkMin }

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
# Restart back-off (2026-10-21): during the fleet-wide connection drop the
# DB-backed health check failed on every desk and the watchdog restarted the
# app every ~2.5 min (DISP-1: 11:35, 11:38, 11:40), minting a new capture tab
# id each time. Restarting cannot fix a network/Mongo outage. Now: while the
# network or the Mongo DNS is down, a listening app is NOT restarted; and
# consecutive restarts back off 2 -> 4 -> 8 -> 15 min until the app stays up
# for 10 min.
$maxAppRestartGap = [TimeSpan]::FromMinutes(15)
$appRestartStreak = @{ "Dispatch Monitor" = 0; "Nexus Dispatch" = 0 }
$appStableResetAfter = [TimeSpan]::FromMinutes(10)

function Get-AppRestartGap($streak) {
    $min = [Math]::Min($maxAppRestartGap.TotalMinutes, $minAppRestartGap.TotalMinutes * [Math]::Pow(2, [Math]::Max(0, $streak - 1)))
    return [TimeSpan]::FromMinutes($min)
}

# $true when DNS + outbound connectivity look healthy. Checks the public Atlas
# domain (not this desk's cluster host, so nothing from .env is read here).
function Test-NetworkUp() {
    try {
        $null = Resolve-DnsName -Name "mongodb.net" -Type A -DnsOnly -QuickTimeout -ErrorAction Stop
    } catch {
        return $false
    }
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $t = $c.ConnectAsync("cloud.mongodb.com", 443)
        $ok = $t.Wait(5000) -and $c.Connected
        $c.Close()
        return $ok
    } catch {
        return $false
    }
}
$lastAppRestart = @{ "Dispatch Monitor" = [DateTime]::MinValue; "Nexus Dispatch" = [DateTime]::MinValue }

function Restart-AppIfDead($title, $directory, $port, $command, $log) {
    if (Test-AppAlive $port) {
        if ($appRestartStreak[$title] -gt 0 -and (([DateTime]::Now) - $lastAppRestart[$title]) -gt $appStableResetAfter) { $appRestartStreak[$title] = 0 }
        return
    }
    # Process up and listening but the DB-backed check fails while the network
    # is down: a restart can't help and only churns capture tabs.
    if (-not (Test-AppProcessDead $title $port) -and -not (Test-NetworkUp)) {
        Write-Host "$(Get-Date) $title is not answering but the network/Mongo DNS is down; not restarting (back-off)." -ForegroundColor DarkYellow
        return
    }
    # NOTE: parenthesize Get-Date -- "Get-Date - $x" parses '-' as a parameter
    # token, $elapsed becomes $null, and the throttle below silently blocks
    # every restart (this watchdog never recovered a dead app until 2026-09-17).
    $elapsed = ([DateTime]::Now) - $lastAppRestart[$title]
    $gap = Get-AppRestartGap $appRestartStreak[$title]
    if ($elapsed -lt $gap) {
        Write-Host "$(Get-Date) $title is down but was restarted $([int]$elapsed.TotalSeconds)s ago; skipping this cycle." -ForegroundColor DarkYellow
        return
    }
    Write-Host "$(Get-Date) $title (port $port) is not responding; restarting..." -ForegroundColor Cyan
    Restart-App $title $directory $port $command $log
    $lastAppRestart[$title] = Get-Date
    $appRestartStreak[$title]++
    if ($appRestartStreak[$title] -gt 1) {
        Write-Host "$(Get-Date) $title restart #$($appRestartStreak[$title]) in a row; next restart no sooner than $([int](Get-AppRestartGap $appRestartStreak[$title]).TotalMinutes) min." -ForegroundColor DarkYellow
    }
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

# The cmd.exe launcher started for each app (Start-Process -PassThru). It
# lives exactly as long as "npm run dev" does, so an exited launcher with
# nothing on the port means the app process really died -- as opposed to
# still starting up slowly, which is normal for minutes after a reboot.
$appLauncher = @{}

function Test-AppProcessDead($title, $port) {
    $launcher = $appLauncher[$title]
    if ($null -eq $launcher) { return $false }   # unknown -> assume still starting
    $launcher.Refresh()
    if (-not $launcher.HasExited) { return $false }
    return -not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Restart-App($title, $directory, $port, $command, $log) {
    Write-Host "$(Get-Date) Restarting $title..." -ForegroundColor Cyan
    Stop-ProcessOnPort $port
    Stop-AppLauncher $title $directory
    New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
    Limit-LogSize $log
    $appLauncher[$title] = Start-Process cmd -ArgumentList "/c", "cd /d `"$directory`" && $command >> `"$log`" 2>&1" -WindowStyle Hidden -PassThru
    if (Wait-ForPort $port) { Set-ServicePriority $port 'AboveNormal' $title }
}

function Start-App($title, $directory, $port, $command, $log) {
    Write-Host "$(Get-Date) Starting $title..." -ForegroundColor Cyan
    Stop-ProcessOnPort $port
    Stop-AppLauncher $title $directory
    New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
    Limit-LogSize $log
    $appLauncher[$title] = Start-Process cmd -ArgumentList "/c", "cd /d `"$directory`" && $command >> `"$log`" 2>&1" -WindowStyle Hidden -PassThru
    if (Wait-ForPort $port) { Set-ServicePriority $port 'AboveNormal' $title }
}

# The capture UI's auto-start (audio-panel.tsx) only runs once a page is
# actually loaded -- after an unattended overnight reboot there's nobody here
# to open Chrome and navigate to it. Open it in the default browser once the
# app is confirmed listening, in the user's interactive desktop session (the
# Startup .vbs that launches this script runs at logon, not as a service, so
# a GUI window here is visible on the real desktop, same as a manual open).
#
# 2026-10-21: a tab opened by the watchdog has no user gesture, so Chrome may
# keep its AudioContext suspended / block getUserMedia until someone clicks
# Start (DISP-1 after the 11:40 restart). Watchdog Chrome launches now pass
# --autoplay-policy=no-user-gesture-required and --use-fake-ui-for-media-stream
# (auto-accepts the mic prompt). Flags only apply when this launch starts the
# Chrome process; if Chrome is already running the URL opens in it and the
# flags are ignored, which is why the HKCU policy below is also written.
$chromeCaptureFlags = @("--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream")
$captureOrigins = @("http://localhost:5000", "http://127.0.0.1:5000")

function Get-ChromePath() {
    foreach ($p in @(
        (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
        (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
    )) {
        if ($p -and (Test-Path $p)) { return $p }
    }
    return $null
}

# Per-user Chrome policy (no admin): allow mic capture and autoplay on the two
# capture origins without a prompt or gesture. Chrome re-reads policy while
# running (or chrome://policy -> Reload). Idempotent; CHROME_CAPTURE_POLICY=off skips.
function Set-ChromeCapturePolicy() {
    if (-not $chromeCapturePolicy) { return }
    try {
        $base = "HKCU:\Software\Policies\Google\Chrome"
        foreach ($name in @("AudioCaptureAllowedUrls", "AutoplayAllowlist")) {
            $key = Join-Path $base $name
            New-Item -Path $key -Force | Out-Null
            $i = 1
            foreach ($o in $captureOrigins) {
                New-ItemProperty -Path $key -Name "$i" -Value $o -PropertyType String -Force | Out-Null
                $i++
            }
        }
    } catch {
        Write-Warning "$(Get-Date) Could not write Chrome capture policy: $_"
    }
}

function Start-Browser($url) {
    Write-Host "$(Get-Date) Opening $url in Chrome (capture flags)..." -ForegroundColor Cyan
    Set-ChromeCapturePolicy
    $chrome = Get-ChromePath
    try {
        if ($chrome) {
            Start-Process -FilePath $chrome -ArgumentList ($chromeCaptureFlags + @($url))
        } else {
            Start-Process $url
        }
    } catch {
        Write-Warning "Could not open browser: $_"
    }
}

# Last resort after /api/capture/recover did not bring audio back: close Chrome
# (graceful first) and open ONE capture tab with the capture flags, so stale
# pre-restart pages and gesture-less tabs are gone and the flags take effect.
$captureRelaunchGap = [TimeSpan]::FromMinutes(30)
$lastCaptureRelaunch = [DateTime]::MinValue
function Restart-CaptureBrowser($url) {
    Write-Host "$(Get-Date) Relaunching Chrome with a single capture tab ($url)." -ForegroundColor Yellow
    $procs = @(Get-Process chrome -ErrorAction SilentlyContinue)
    foreach ($p in $procs) { try { if ($p.MainWindowHandle -ne 0) { $null = $p.CloseMainWindow() } } catch { } }
    $deadline = ([DateTime]::Now).AddSeconds(15)
    while ((Get-Process chrome -ErrorAction SilentlyContinue) -and ([DateTime]::Now) -lt $deadline) { Start-Sleep -Seconds 1 }
    Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Start-Browser $url
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
# Single origin (2026-10-20): every watchdog open uses localhost. DISP-1 ended
# up with a localhost AND a 127.0.0.1 tab; they are different origins (own
# mic permission, own Web Lock, own localStorage).
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

# Capture outage (2026-10-20). DISP-1: a tab kept heartbeating while nothing
# was recorded, so the no-heartbeat check never fired. Now "no recorder chunk
# on this desk for CAPTURE_NO_CHUNK_MIN minutes" (status.lastChunkAgoMs, across
# all tabs) while a tab wants to capture is an outage too. Recovery:
#   - live tab(s) present: ask them to recover (POST /api/capture/recover; on
#     their next heartbeat localhost tabs reload, other-origin tabs navigate to
#     $captureUrl) -- never open a duplicate tab next to a live one;
#   - no live tab: open $captureUrl (same as the no-heartbeat path).
# Old servers without lastChunkAgoMs/liveTabs: no-op (leave it).
$captureNoChunkLimit = [TimeSpan]::FromMinutes($captureNoChunkMin)
$captureRecoverGap = [TimeSpan]::FromMinutes([Math]::Max(10, 2 * $captureNoChunkMin))
$lastCaptureRecover = [DateTime]::MinValue
$captureInactiveLimit = [TimeSpan]::FromMinutes($captureInactiveMin)
# After a recover request, how long to wait for real audio before relaunching Chrome.
$captureRecoverVerifyWait = [TimeSpan]::FromSeconds(120)
$captureRecoverPendingSince = $null

# Returns $null (healthy / unknown) or @{ Reason; LiveTabs }.
function Get-CaptureOutage($port) {
    try {
        $status = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/capture/status" -Method GET -TimeoutSec 15 -UseBasicParsing
    } catch {
        return $null
    }
    if ($null -eq $status -or $null -eq $status.uptimeMs) { return $null }
    if ($null -eq $status.PSObject.Properties['liveTabs']) { return $null }
    $limitMs = $captureNoChunkLimit.TotalMilliseconds
    if ([double]$status.uptimeMs -lt $limitMs) { return $null }
    $live = [int]$status.liveTabs
    if ($live -eq 0) { return $null }  # no heartbeat at all: Test-CapturePageSilent's job
    # Operator pressed Stop in every live tab: not an outage.
    $wanting = @($status.tabs | Where-Object { $_.agoMs -lt 150000 -and $_.autoCapture -ne $false })
    if ($wanting.Count -eq 0) { return $null }
    # 2026-10-21: judge REAL activity (a minute with chunks sent to Whisper or
    # a nonzero level) when the server reports it. Chunk counts alone include
    # silent chunks, and a gesture-less tab with a suspended AudioContext
    # records chunks while hearing nothing.
    if ($null -ne $status.PSObject.Properties['lastActiveAgoMs']) {
        $inactiveMs = $captureInactiveLimit.TotalMilliseconds
        if ([double]$status.uptimeMs -lt $inactiveMs) { return $null }
        $act = $status.lastActiveAgoMs
        if ($null -ne $act -and [double]$act -le $inactiveMs) { return $null }
        $actText = if ($null -eq $act) { "never since boot" } else { "$([int]([double]$act / 60000)) min ago" }
        return @{ Reason = "no real audio (sent>0 or level>0) for $($captureInactiveLimit.TotalMinutes)+ min (last: $actText, live tabs: $live, capturing: $($status.capturingTabs), lease: $($status.leaseHolder) confirmed=$($status.leaseConfirmed))"; LiveTabs = $live }
    }
    $ago = $status.lastChunkAgoMs
    if ($null -ne $ago -and [double]$ago -le $limitMs) { return $null }
    $agoText = if ($null -eq $ago) { "never" } else { "$([int]([double]$ago / 60000)) min ago" }
    return @{ Reason = "no capture chunk for $($captureNoChunkLimit.TotalMinutes)+ min (last: $agoText, live tabs: $live, capturing: $($status.capturingTabs))"; LiveTabs = $live }
}

function Request-CaptureRecover($port) {
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/capture/recover" -Method POST -TimeoutSec 15 -UseBasicParsing | Out-Null
        return $true
    } catch {
        Write-Warning "$(Get-Date) Capture recover request failed: $_"
        return $false
    }
}

# Boot grace (2026-10-06). After a reboot the whole box takes minutes to come
# up: on DISP-1 (11:18 reboot) Whisper was ready at 11:30, the app was started
# at 11:31 and had not bound :5000 within the old 30s wait, so the capture page
# was never opened, and the first loop restarted both Whisper ("scheduled",
# because the 4h timer started at DateTime.MinValue) and the still-booting app.
# Now, on the initial (logon) start:
#   - the app gets up to $appBootWait to answer (polled with backoff), and is
#     NOT restarted during that window unless its process has actually exited;
#   - once it answers, the capture page is opened unless a tab already holds
#     the capture lease or heartbeated recently (Chrome often restores the tab
#     itself) -- and if it is still unconfirmed, later loops retry instead of
#     giving up for good;
#   - the 4h Whisper schedule starts from this start, not from MinValue.
$appBootWait = [TimeSpan]::FromSeconds($appBootWaitSec)
# Boot-time open of the capture page: same single origin as every other open.
$bootCaptureUrl = $captureUrl
# How long to give an existing/restored tab to check in before opening one.
$captureConfirmWait = [TimeSpan]::FromSeconds(90)
# A heartbeat this recent means a live capture page (tabs beat every 60s).
$captureFreshHeartbeat = [TimeSpan]::FromSeconds(150)
$captureRetryGap = [TimeSpan]::FromMinutes(5)
$captureMaxOpenAttempts = 3
# Hard cap on the pending state (it also defers the git pull), e.g. when the
# app never comes up at all.
$capturePendingMax = [TimeSpan]::FromMinutes(30)
$capturePending = @{ Active = $false; Since = [DateTime]::MinValue; Attempts = 0; LastAttempt = [DateTime]::MinValue; AnsweredAt = $null; Unsupported = $false }

# The status object, or $null when it can't be read (app down/starting/slow).
# Sets $capturePending.Unsupported when the server answered but has no
# /api/capture/status (404, or the SPA catch-all returning HTML).
function Get-CaptureStatus($port) {
    try {
        $status = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/capture/status" -Method GET -TimeoutSec 10 -UseBasicParsing
    } catch {
        $code = $null
        try { $code = [int]$_.Exception.Response.StatusCode } catch { }
        if ($code -eq 404) { $capturePending.Unsupported = $true }
        return $null
    }
    if ($null -eq $status -or $null -eq $status.uptimeMs) {
        $capturePending.Unsupported = $true
        return $null
    }
    $capturePending.Unsupported = $false
    return $status
}

function Test-CaptureConfirmed($status) {
    if ($null -eq $status) { return $false }
    # 2026-10-21: a lease (or a heartbeat) alone is not capture -- after the
    # 11:40 restart DISP-1's lease went to a leftover tab that never captured.
    # Servers that report real activity: confirmed only by recent real audio
    # or a lease the server has confirmed from such a heartbeat.
    if ($null -ne $status.PSObject.Properties['lastActiveAgoMs']) {
        if ($null -ne $status.lastActiveAgoMs -and [double]$status.lastActiveAgoMs -lt $captureFreshHeartbeat.TotalMilliseconds) { return $true }
        if ($status.leaseHolder -and $status.leaseConfirmed -eq $true) { return $true }
        return $false
    }
    if ($status.leaseHolder) { return $true }
    if ($null -ne $status.lastHeartbeatAgoMs -and [double]$status.lastHeartbeatAgoMs -lt $captureFreshHeartbeat.TotalMilliseconds) { return $true }
    return $false
}

# Poll the app with backoff until it answers, its process dies, or $timeout
# passes. "Answers" = Test-AppAlive, the same DB-backed check the loop's
# restart rule uses, so the grace can't end while the loop would still see the
# app as dead (e.g. Mongo/network slow right after boot). Each probe has its
# own 15s timeout, so a wedged-but-listening app still ends at the deadline.
# Returns "ready", "dead", or "timeout".
function Wait-AppReady($title, $port, [TimeSpan]$timeout) {
    $deadline = ([DateTime]::Now) + $timeout
    $delay = 2
    Write-Host "$(Get-Date) Waiting for $title to answer on :$port (up to $([int]$timeout.TotalSeconds)s, boot grace)..." -ForegroundColor Cyan
    while ($true) {
        if (Test-AppAlive $port) {
            Write-Host "$(Get-Date) $title is answering on :$port." -ForegroundColor Green
            return "ready"
        }
        if (Test-AppProcessDead $title $port) {
            Write-Warning "$(Get-Date) $title process exited before answering on :$port."
            return "dead"
        }
        $left = ($deadline - ([DateTime]::Now)).TotalSeconds
        if ($left -le 0) { return "timeout" }
        Start-Sleep -Seconds ([int][Math]::Max(1, [Math]::Min($delay, $left)))
        $delay = [Math]::Min($delay * 2, 20)
    }
}

# Open the boot capture page once the app answers, unless a tab already holds
# the lease / heartbeats. Called with -Block on the initial start (waits up to
# $captureConfirmWait for a restored tab), and once per loop while pending.
function Step-BootCapturePage($port, [switch]$Block) {
    if (-not $capturePending.Active) { return }
    if ((([DateTime]::Now) - $capturePending.Since) -gt $capturePendingMax) {
        Write-Warning "$(Get-Date) Boot capture page still unconfirmed after $([int]$capturePendingMax.TotalMinutes) min; leaving it to the 15-min no-heartbeat check."
        $capturePending.Active = $false
        return
    }
    $status = Get-CaptureStatus $port
    if ($Block) {
        $until = ([DateTime]::Now) + $captureConfirmWait
        if (-not $capturePending.AnsweredAt) { $capturePending.AnsweredAt = Get-Date }
        while (-not (Test-CaptureConfirmed $status) -and ([DateTime]::Now) -lt $until) {
            Start-Sleep -Seconds 5
            $status = Get-CaptureStatus $port
        }
    }
    if (Test-CaptureConfirmed $status) {
        Write-Host "$(Get-Date) Capture page confirmed (lease: $($status.leaseHolder), last heartbeat: $($status.lastHeartbeatAgoMs) ms ago); not opening another." -ForegroundColor Green
        $capturePending.Active = $false
        return
    }
    if ($null -eq $status) {
        # Not answering (yet), or a slow/failed status read: try next loop.
        if (-not $capturePending.Unsupported) { return }
        if (-not (Test-AppAlive $port)) { return }
        # Server without /api/capture/status: old behavior, open once.
        if ($capturePending.Attempts -eq 0) { Start-Browser $bootCaptureUrl; $script:lastCaptureReopen = Get-Date }
        $capturePending.Active = $false
        return
    }
    $now = Get-Date
    if (-not $capturePending.AnsweredAt) {
        # First loop that sees the app answer: let a restored tab check in first.
        $capturePending.AnsweredAt = $now
        Write-Host "$(Get-Date) App answering; giving an existing capture tab $([int]$captureConfirmWait.TotalSeconds)s to check in before opening one." -ForegroundColor Cyan
        return
    }
    if (($now - $capturePending.AnsweredAt) -lt $captureConfirmWait) { return }
    if (($now - $capturePending.LastAttempt) -lt $captureRetryGap) { return }
    if ($capturePending.Attempts -ge $captureMaxOpenAttempts) {
        Write-Warning "$(Get-Date) Capture page still not confirmed after $($capturePending.Attempts) opens; leaving it to the 15-min no-heartbeat check."
        $capturePending.Active = $false
        return
    }
    $capturePending.Attempts++
    Write-Host "$(Get-Date) No capture tab holds the lease or heartbeated; opening capture page (boot attempt $($capturePending.Attempts)/$captureMaxOpenAttempts)." -ForegroundColor Yellow
    Start-Browser $bootCaptureUrl
    $capturePending.LastAttempt = $now
    # Counts as a reopen for the 2h no-heartbeat gap, so the two paths can't
    # stack extra tabs on a page that never manages to heartbeat.
    $script:lastCaptureReopen = $now
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
    # The 4h Whisper schedule starts now (boot/logon), not at MinValue --
    # otherwise the first loop reloaded a just-loaded model ~3 min after boot.
    $lastWhisperRestart = Get-Date
    Start-App "Dispatch Monitor" $dispatchMonitor 5000 "npm run dev" $dmLog
    $lastAppRestart["Dispatch Monitor"] = Get-Date
    $capturePending.Active = $true
    $capturePending.Since = Get-Date
    # Boot grace: block here (like Start-Whisper's model wait) until the app
    # answers. Returns early only if the app process exits, so a slow-booting
    # app is never killed and restarted mid-startup.
    $appReady = Wait-AppReady "Dispatch Monitor" 5000 $appBootWait
    if ($appReady -eq "ready") {
        # Start-App's own 30s port wait may have missed a slow bind.
        Set-ServicePriority 5000 'AboveNormal' 'Dispatch Monitor'
        Step-BootCapturePage 5000 -Block
    } else {
        # Grace is over: the loop's normal dead-app rule restarts it, and the
        # capture page stays pending until the app answers.
        Write-Warning "$(Get-Date) Dispatch Monitor not answering after boot wait ($appReady); the loop will restart it if needed and open the capture page once it answers."
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

    # Boot capture page not confirmed yet: retry (lease/heartbeat-checked).
    Step-BootCapturePage 5000

    # Reopen the capture page if no tab has heartbeated for a long time.
    if (-not $capturePending.Active -and (Test-CapturePageSilent 5000)) {
        $sinceReopen = ([DateTime]::Now) - $lastCaptureReopen
        if ($sinceReopen -gt $captureReopenGap) {
            Write-Host "$(Get-Date) No capture-page heartbeat for $($captureSilentLimit.TotalMinutes) min; reopening $captureUrl" -ForegroundColor Yellow
            Start-Browser $captureUrl
            $lastCaptureReopen = Get-Date
        }
    }

    # Heartbeating tab(s) but no audio chunks: idle capture page (2026-10-20).
    if (-not $capturePending.Active) {
        $outage = Get-CaptureOutage 5000
        if ($null -eq $outage) {
            $captureRecoverPendingSince = $null
        } elseif ($null -ne $captureRecoverPendingSince) {
            # Recover was requested and audio still isn't back: relaunch Chrome
            # with ONE capture tab (throttled), so the capture flags apply.
            if ((([DateTime]::Now) - $captureRecoverPendingSince) -ge $captureRecoverVerifyWait) {
                if ($captureRelaunchChrome -and (([DateTime]::Now) - $lastCaptureRelaunch) -gt $captureRelaunchGap) {
                    Write-Host "$(Get-Date) Capture still out $([int]$captureRecoverVerifyWait.TotalSeconds)s after recover: $($outage.Reason)" -ForegroundColor Yellow
                    Restart-CaptureBrowser $captureUrl
                    $lastCaptureRelaunch = Get-Date
                    $lastCaptureReopen = Get-Date
                }
                $captureRecoverPendingSince = $null
            }
        } elseif ((([DateTime]::Now) - $lastCaptureRecover) -gt $captureRecoverGap) {
            Write-Host "$(Get-Date) Capture outage: $($outage.Reason); asking the capture tab(s) to recover (reload on $captureUrl)." -ForegroundColor Yellow
            if (Request-CaptureRecover 5000) { $lastCaptureRecover = Get-Date; $captureRecoverPendingSince = Get-Date }
        }
    }

    # Pull git updates periodically. Not while the boot capture page is still
    # pending (at most ~15 min): a pull can restart the app or hand off to a
    # new watchdog instance (-NoInitialStart), which would drop that state.
    if (-not $capturePending.Active -and ($now - $lastGitPull) -gt $gitPullInterval) {
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
