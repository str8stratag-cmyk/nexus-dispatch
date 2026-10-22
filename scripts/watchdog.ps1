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

# 2026-10-21 (Disp-4 live test, 5:38 PM): the loop went silent right after
# "Pull of origin/release failed (local changes?)" on a detached HEAD and never
# ran another capture check. Every git/npm call used to run with no timeout in
# the loop's own thread, so a git that waits for credentials / network / a
# lock blocked the watchdog forever. Now every external call goes through
# Invoke-External (hard timeout, process tree killed, no prompts), and
# Pull-Repo never touches a detached HEAD or a checkout of another branch.
$gitTimeoutSec = 60
$gitPullTimeoutSec = 120
$npmTimeoutSec = 600
function Invoke-External([string]$file, [string[]]$argList, [int]$timeoutSec, [string]$workDir = $null) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $file
    $psi.Arguments = (@($argList) | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    $psi.CreateNoWindow = $true
    if ($workDir) { $psi.WorkingDirectory = $workDir }
    # Never wait on a prompt nobody can see (hidden watchdog window).
    $psi.EnvironmentVariables["GIT_TERMINAL_PROMPT"] = "0"
    $psi.EnvironmentVariables["GCM_INTERACTIVE"] = "never"
    $psi.EnvironmentVariables["GIT_ASKPASS"] = ""
    $psi.EnvironmentVariables["SSH_ASKPASS"] = ""
    $psi.EnvironmentVariables["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes -o ConnectTimeout=15"
    $psi.EnvironmentVariables["GIT_EDITOR"] = "true"
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
    } catch {
        return @{ ExitCode = -1; TimedOut = $false; Out = ""; Err = "$_" }
    }
    try { $p.StandardInput.Close() } catch { }
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit([Math]::Max(1, $timeoutSec) * 1000)) {
        Write-Warning "$(Get-Date) TIMEOUT after ${timeoutSec}s: $file $($psi.Arguments); killing it."
        if ($env:OS -eq "Windows_NT") { & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null }
        try { if (-not $p.HasExited) { $p.Kill() } } catch { }
        return @{ ExitCode = -1; TimedOut = $true; Out = ""; Err = "timeout" }
    }
    $p.WaitForExit()
    $out = ""; $err = ""
    if ($outTask.Wait(5000)) { $out = $outTask.Result }
    if ($errTask.Wait(5000)) { $err = $errTask.Result }
    return @{ ExitCode = $p.ExitCode; TimedOut = $false; Out = "$out".Trim(); Err = "$err".Trim() }
}
function Invoke-Git($path, [string[]]$gitArgs, [int]$timeoutSec = $gitTimeoutSec) {
    return Invoke-External "git" (@("-C", $path, "-c", "credential.interactive=never") + $gitArgs) $timeoutSec
}
function Invoke-NpmInstall($path) {
    Write-Host "$(Get-Date) npm install ($path, timeout ${npmTimeoutSec}s)..." -ForegroundColor Cyan
    $file = if ($env:OS -eq "Windows_NT") { "cmd.exe" } else { "sh" }
    $a = if ($env:OS -eq "Windows_NT") { @("/c", "npm install --no-audit --no-fund") } else { @("-c", "npm install --no-audit --no-fund") }
    $r = Invoke-External $file $a $npmTimeoutSec $path
    if ($r.ExitCode -ne 0) { Write-Warning "$(Get-Date) npm install failed in $path (exit $($r.ExitCode)$(if ($r.TimedOut) { ', timed out' }))." }
    return ($r.ExitCode -eq 0)
}

function Pull-Repo($path, $branch) {
    if (-not (Test-Path (Join-Path $path ".git"))) { return $false }
    # Detached HEAD = a pinned checkout (e.g. a one-desk PR test): never pull.
    $cur = Invoke-Git $path @("symbolic-ref", "--short", "-q", "HEAD")
    if ($cur.TimedOut) { Write-Warning "$(Get-Date) git timed out reading HEAD for $path; skipping pull."; return $false }
    if ($cur.ExitCode -ne 0 -or -not $cur.Out) {
        $sha = (Invoke-Git $path @("rev-parse", "--short", "HEAD")).Out
        Write-Host "$(Get-Date) $path is on a detached HEAD ($sha); skipping pull of origin/$branch (pinned checkout)." -ForegroundColor DarkYellow
        return $false
    }
    if ($cur.Out -ne $branch) {
        Write-Host "$(Get-Date) $path is on branch '$($cur.Out)', not '$branch'; skipping pull." -ForegroundColor DarkYellow
        return $false
    }
    Write-Host "$(Get-Date) Pulling origin/$branch for $path..." -ForegroundColor Cyan
    # Missing branch = do nothing. Never fall back to another branch: that
    # fallback is exactly how unreviewed code would reach the fleet.
    $ls = Invoke-Git $path @("ls-remote", "--exit-code", "--heads", "origin", $branch)
    if ($ls.ExitCode -ne 0) {
        Write-Warning "$(Get-Date) origin/$branch not reachable/found for $path$(if ($ls.TimedOut) { ' (timed out)' }); skipping pull."
        return $false
    }
    $before = (Invoke-Git $path @("rev-parse", "HEAD")).Out
    $pull = Invoke-Git $path @("pull", "--ff-only", "--no-edit", "origin", $branch) $gitPullTimeoutSec
    if ($pull.ExitCode -ne 0) {
        # Conflict with local box edits / diverged / timeout: leave the tree as it was.
        Write-Warning "$(Get-Date) Pull of origin/$branch failed for $path$(if ($pull.TimedOut) { ' (timed out)' } else { ' (local changes or diverged?)' }); left unchanged."
        [void](Invoke-Git $path @("merge", "--abort"))
        return $false
    }
    $after = (Invoke-Git $path @("rev-parse", "HEAD")).Out
    if ($before -ne $after) {
        Write-Host "$(Get-Date) Updated $path" -ForegroundColor Green
        # A dependency change without an install leaves the app unable to boot.
        $diff = Invoke-Git $path @("diff", "--name-only", $before, $after)
        if ($diff.Out -match "(?m)^package(-lock)?\.json$") {
            Write-Host "$(Get-Date) package.json changed in $path - running npm install..." -ForegroundColor Cyan
            [void](Invoke-NpmInstall $path)
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
# --autoplay-policy=no-user-gesture-required; mic access comes from the
# per-site HKCU policy below (capture origins only, no all-sites flag). Flags only apply when this launch starts the
# Chrome process; if Chrome is already running the URL opens in it and the
# flags are ignored, which is why the HKCU policy below is also written.
$chromeCaptureFlags = @("--autoplay-policy=no-user-gesture-required")
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
# "HKCU:\A\B\C" -> "HKCU:\A", "HKCU:\A\B", "HKCU:\A\B\C" (parents first).
function Get-RegistryKeyChain([string]$key) {
    $parts = @($key -split '\\' | Where-Object { $_ })
    $out = @(); $acc = $parts[0]
    for ($i = 1; $i -lt $parts.Count; $i++) { $acc = "$acc\$($parts[$i])"; $out += $acc }
    return $out
}
# Best effort only (2026-10-21 retest): HKCU\Software\Policies\Google needs
# admin on the desks ("Access ... denied"), so this usually fails. Nothing
# depends on it -- Chrome is launched with --autoplay-policy and the desks
# granted mic on http://localhost:5000. One quiet line, once per run.
$chromePolicyNoted = $false
function Set-ChromeCapturePolicy() {
    if (-not $chromeCapturePolicy) { return }
    try {
        $base = "HKCU:\Software\Policies\Google\Chrome"
        foreach ($name in @("AudioCaptureAllowedUrls", "AutoplayAllowlist")) {
            $key = Join-Path $base $name
            foreach ($k in (Get-RegistryKeyChain $key)) {
                if (-not (Test-Path $k)) { New-Item -Path $k -Force -ErrorAction Stop | Out-Null }
            }
            $i = 1
            foreach ($o in $captureOrigins) {
                New-ItemProperty -Path $key -Name "$i" -Value $o -PropertyType String -Force -ErrorAction Stop | Out-Null
                $i++
            }
        }
    } catch {
        if (-not $script:chromePolicyNoted) {
            $script:chromePolicyNoted = $true
            Write-Host "$(Get-Date) Chrome capture policy not written (needs admin; optional, skipped)." -ForegroundColor DarkGray
        }
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
# 2026-10-21: the manual fix that always worked on DISP-5 was
# "Stop-Process chrome; Start-Process chrome http://localhost:5000". Kill
# (no graceful close: a graceful close lets Chrome restore every dead tab),
# wait for the processes to exit, relaunch ONE tab.
function Restart-CaptureBrowser($url) {
    $procs = @(Get-Process chrome -ErrorAction SilentlyContinue)
    Write-Host "$(Get-Date) [capture-escalate] Killing Chrome ($($procs.Count) process(es)) for a clean restart." -ForegroundColor Yellow
    Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    $deadline = ([DateTime]::Now).AddSeconds(15)
    while ((Get-Process chrome -ErrorAction SilentlyContinue) -and ([DateTime]::Now) -lt $deadline) { Start-Sleep -Seconds 1 }
    $left = @(Get-Process chrome -ErrorAction SilentlyContinue).Count
    if ($left) { Write-Warning "$(Get-Date) [capture-escalate] $left Chrome process(es) still running after 15s." }
    Start-Sleep -Seconds 2
    # Clear the server's lease/tabs/recover BEFORE the new tab registers.
    Send-BrowserRestarted 5000
    Write-Host "$(Get-Date) [capture-escalate] Relaunching Chrome with a single tab: $url" -ForegroundColor Yellow
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
$lastCaptureRecover = [DateTime]::MinValue
$captureInactiveLimit = [TimeSpan]::FromMinutes($captureInactiveMin)
# Storm guards (2026-10-21, DISP-5): no recover/relaunch within 10 min of an app
# restart or code pull, none while live tabs > 1 and growing, max 3 per hour.
$recoverCooldown = [TimeSpan]::FromMinutes(10)
$maxRecoversPerHour = 3
$recentRecovers = New-Object System.Collections.ArrayList
$lastCodeUpdate = [DateTime]::MinValue
$prevLiveTabs = $null

# 2026-10-21 (DISP-5 3:53 PM storm, fix 1-3): recover is at most once per
# 30 min, never while a live tab is lock=pending, and if no tab is capturing
# with the lock held within 90 s of a recover, escalate to a clean Chrome
# restart (also at most once per 30 min) instead of reloading again. A tab
# stuck pending for 5+ min (the server's dead-lock-holder takeover had its
# chance) escalates the same way. Timestamps persist in
# logs\watchdog-capture-state.json so a self-update does not reset them.
$recoverMinGap = [TimeSpan]::FromMinutes(30)
$relaunchMinGap = [TimeSpan]::FromMinutes(30)
$recoverVerifyWindow = [TimeSpan]::FromSeconds(90)
$pendingEscalateAfter = [TimeSpan]::FromMinutes(5)
$captureStep = @{ RecoverSentAt = $null; PendingSince = $null; ZeroTabsSince = $null; NoChromeSince = $null }
# 2026-10-21 (Disp-4 live test): with Chrome fully closed (0 live tabs) the
# outage check returned "no live tab" and nothing happened for minutes. Now
# 0 live tabs + no chunk for 90 s = launch Chrome directly (never a recover:
# there is no tab to deliver it to). No Chrome running -> just launch (always
# allowed, min $noChromeLaunchGap apart so a Chrome that will not start is not
# spawned every loop); Chrome running with 0 live tabs -> clean restart, max
# once per $relaunchMinGap.
# 2026-10-21 retest (Disp-4, Chrome closed 6:25:14, launch only 6:29:57, then
# a needless reload 6:30:57): detection waited for tab staleness (150 s) on a
# 60 s loop, then counted 90 s from first sight. Now (target: capture back
# within 2 min of Chrome closing):
#   - capture checks run every $captureCheckInterval (15 s), not once a minute;
#   - Chrome not running (seen on 2 checks >= $noChromeConfirm apart) and no
#     chunk for $noChromeChunkQuiet = launch at once;
#   - Chrome running but 0 live tabs (tabs now report pagehide) and no chunk
#     for $zeroTabsEscalateAfter (by chunk age, not time since first seen) =
#     clean restart (max once per $relaunchMinGap);
#   - our own launch/restart counts as the recover attempt: no reload for
#     $launchGrace after it; then the normal 90 s verify / escalate applies.
$captureCheckInterval = [TimeSpan]::FromSeconds(15)
$zeroTabsEscalateAfter = [TimeSpan]::FromSeconds(45)
$noChromeConfirm = [TimeSpan]::FromSeconds(10)
$noChromeChunkQuiet = [TimeSpan]::FromSeconds(15)
$noChromeLaunchGap = [TimeSpan]::FromMinutes(2)
$launchGrace = [TimeSpan]::FromSeconds(90)
$lastNoChromeLaunch = [DateTime]::MinValue
$lastOwnLaunch = [DateTime]::MinValue
function Test-ChromeRunning() { return [bool](Get-Process chrome -ErrorAction SilentlyContinue) }
# Seconds since the oldest chrome process started ($null = not running / unknown).
# 2026-10-22: never launch/restart Chrome within $chromeYoungGrace of a Chrome
# start (by the watchdog OR a person), its tab needs time to check in.
$chromeYoungGrace = [TimeSpan]::FromSeconds(60)
function Get-ChromeAgeSec() {
    try {
        $starts = @(Get-Process chrome -ErrorAction SilentlyContinue | ForEach-Object { try { $_.StartTime } catch { } } | Where-Object { $_ })
        if (-not $starts.Count) { return $null }
        return ([DateTime]::Now - ($starts | Sort-Object | Select-Object -First 1)).TotalSeconds
    } catch { return $null }
}

# Pure 0-tab / no-Chrome decision. $s: Now, LiveTabs, ChromeRunning,
# LastChunkAgoMs, NoChromeSince, LastOwnLaunch, LaunchGrace, NoChromeConfirm,
# NoChromeChunkQuiet, ZeroTabsAfter, LastNoChromeLaunch, NoChromeGap,
# LastRelaunch, RelaunchGap. Returns @{ Action = none|grace|wait|launch|restart|cooldown; Why }.
function Get-ZeroTabStep($s) {
    $chunkAgo = if ($null -eq $s.LastChunkAgoMs) { [double]::PositiveInfinity } else { [double]$s.LastChunkAgoMs }
    $chunkTxt = if ($null -eq $s.LastChunkAgoMs) { "never" } else { "$([int]($chunkAgo / 1000))s ago" }
    $noChrome = (-not $s.ChromeRunning) -and $chunkAgo -ge $s.NoChromeChunkQuiet.TotalMilliseconds
    $zeroTabs = $s.ChromeRunning -and [int]$s.LiveTabs -eq 0
    if (-not $noChrome -and -not $zeroTabs) { return @{ Action = "none"; Why = "" } }
    if (($s.Now - $s.LastOwnLaunch) -lt $s.LaunchGrace) { return @{ Action = "grace"; Why = "Chrome launched by the watchdog $([int]($s.Now - $s.LastOwnLaunch).TotalSeconds)s ago; waiting for its tab" } }
    if ($s.ChromeRunning -and $null -ne $s.ChromeAgeSec -and $null -ne $s.ChromeYoungGrace -and [double]$s.ChromeAgeSec -lt $s.ChromeYoungGrace.TotalSeconds) { return @{ Action = "grace"; Why = "Chrome started $([int]$s.ChromeAgeSec)s ago; waiting for its tab" } }
    if ($noChrome) {
        if ($null -eq $s.NoChromeSince -or ($s.Now - $s.NoChromeSince) -lt $s.NoChromeConfirm) { return @{ Action = "wait"; Why = "Chrome not running (last chunk: $chunkTxt); confirming on the next check" } }
        if (($s.Now - $s.LastNoChromeLaunch) -lt $s.NoChromeGap) { return @{ Action = "wait"; Why = "Chrome launched $([int]($s.Now - $s.LastNoChromeLaunch).TotalSeconds)s ago and is not running" } }
        return @{ Action = "launch"; Why = "Chrome not running, last chunk: $chunkTxt" }
    }
    if ($chunkAgo -lt $s.ZeroTabsAfter.TotalMilliseconds) { return @{ Action = "wait"; Why = "0 live tabs, last chunk $chunkTxt (escalating at $([int]$s.ZeroTabsAfter.TotalSeconds)s)" } }
    if (($s.Now - $s.LastRelaunch) -lt $s.RelaunchGap) { return @{ Action = "cooldown"; Why = "0 live tabs (last chunk: $chunkTxt), Chrome running, but restarted $([int]($s.Now - $s.LastRelaunch).TotalMinutes) min ago (max once per $([int]$s.RelaunchGap.TotalMinutes) min)" } }
    return @{ Action = "restart"; Why = "0 live tabs while Chrome is running, last chunk: $chunkTxt" }
}

# Pure decision (tested by trial/test-watchdog-outage.ps1). $s: Now, Outage
# (bool), PendingTabs, LockHeldCapturing (int, -1 = server too old to say),
# RecoverSentAt, PendingSince, LastRecover, LastRelaunch, RecoverGap,
# RelaunchGap, VerifyWindow, PendingEscalateAfter. Returns @{ Action; Why }.
# Actions: none | verified | verify-wait | escalate | escalate-cooldown |
#          skip-pending | recover-cooldown | recover
function Get-CaptureRecoveryStep($s) {
    if ($null -ne $s.RecoverSentAt) {
        if ($s.LockHeldCapturing -gt 0 -or ($s.LockHeldCapturing -lt 0 -and -not $s.Outage)) { return @{ Action = "verified"; Why = "a tab is capturing with the lock held" } }
        $waited = $s.Now - $s.RecoverSentAt
        if ($waited -lt $s.VerifyWindow) { return @{ Action = "verify-wait"; Why = "waiting for a capturing lock holder ($([int]$waited.TotalSeconds)s of $([int]$s.VerifyWindow.TotalSeconds)s)" } }
        if (($s.Now - $s.LastRelaunch) -lt $s.RelaunchGap) { return @{ Action = "escalate-cooldown"; Why = "no capturing lock holder $([int]$waited.TotalSeconds)s after recover, but Chrome was restarted $([int]($s.Now - $s.LastRelaunch).TotalMinutes) min ago (max once per $([int]$s.RelaunchGap.TotalMinutes) min)" } }
        return @{ Action = "escalate"; Why = "no tab capturing with the lock held $([int]$waited.TotalSeconds)s after recover" }
    }
    if (-not $s.Outage) { return @{ Action = "none"; Why = "" } }
    # Never reload a tab the watchdog itself just launched.
    if ($null -ne $s.LastOwnLaunch -and $null -ne $s.LaunchGrace -and ($s.Now - $s.LastOwnLaunch) -lt $s.LaunchGrace) { return @{ Action = "launch-grace"; Why = "Chrome launched by the watchdog $([int]($s.Now - $s.LastOwnLaunch).TotalSeconds)s ago; not reloading it" } }
    if ($s.PendingTabs -gt 0) {
        if ($null -ne $s.PendingSince -and ($s.Now - $s.PendingSince) -ge $s.PendingEscalateAfter) {
            if (($s.Now - $s.LastRelaunch) -lt $s.RelaunchGap) { return @{ Action = "escalate-cooldown"; Why = "$($s.PendingTabs) tab(s) lock=pending for $([int]($s.Now - $s.PendingSince).TotalMinutes)+ min, but Chrome was restarted $([int]($s.Now - $s.LastRelaunch).TotalMinutes) min ago" } }
            return @{ Action = "escalate"; Why = "$($s.PendingTabs) tab(s) stuck lock=pending for $([int]($s.Now - $s.PendingSince).TotalMinutes)+ min" }
        }
        return @{ Action = "skip-pending"; Why = "$($s.PendingTabs) live tab(s) lock=pending; never reload while a tab is pending" }
    }
    if (($s.Now - $s.LastRecover) -lt $s.RecoverGap) { return @{ Action = "recover-cooldown"; Why = "last recover $([int]($s.Now - $s.LastRecover).TotalMinutes) min ago (max once per $([int]$s.RecoverGap.TotalMinutes) min)" } }
    return @{ Action = "recover"; Why = "" }
}

function Read-CaptureState($file) {
    $st = @{ LastRecover = [DateTime]::MinValue; LastRelaunch = [DateTime]::MinValue }
    try {
        if (Test-Path $file) {
            $j = Get-Content $file -Raw | ConvertFrom-Json
            if ($j.lastRecover) { $st.LastRecover = [DateTime]::Parse($j.lastRecover, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToLocalTime() }
            if ($j.lastRelaunch) { $st.LastRelaunch = [DateTime]::Parse($j.lastRelaunch, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToLocalTime() }
        }
    } catch { Write-Warning "$(Get-Date) Could not read $file : $_" }
    return $st
}
function Save-CaptureState($file, [DateTime]$lastRecover, [DateTime]$lastRelaunch) {
    try {
        $dir = Split-Path $file -Parent
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        @{ lastRecover = $lastRecover.ToUniversalTime().ToString("o"); lastRelaunch = $lastRelaunch.ToUniversalTime().ToString("o") } | ConvertTo-Json | Set-Content -Path $file -Encoding UTF8
    } catch { Write-Warning "$(Get-Date) Could not write $file : $_" }
}

# 2026-10-22: after the Disp-4 boot the watchdog logged nothing for 3.5 h, so
# a stall was indistinguishable from "all fine". Every $watchdogBeatInterval
# it now writes one state line.
$watchdogBeatInterval = [TimeSpan]::FromMinutes(5)
$lastWatchdogBeat = [DateTime]::MinValue
function Format-WatchdogBeat($status, [bool]$chromeRunning, $bootPending, [DateTime]$lastRecover, [DateTime]$lastRelaunch) {
    $t = { param($d) if ($d -eq [DateTime]::MinValue) { "never" } else { $d.ToString("HH:mm:ss") } }
    if ($null -eq $status) { $cap = "app status unavailable" } else {
        $chunk = if ($null -eq $status.lastChunkAgoMs) { "never" } else { "$([int]([double]$status.lastChunkAgoMs / 1000))s ago" }
        $cap = "live tabs $($status.liveTabs), capturing-with-lock $($status.lockHeldCapturingTabs), pending $($status.pendingTabs), lease $(if ($status.leaseHolder) { $status.leaseHolder } else { 'none' }), last chunk $chunk"
    }
    return "[watchdog] alive: $cap; Chrome running: $chromeRunning; boot pending: $bootPending; last recover: $(& $t $lastRecover); last Chrome restart: $(& $t $lastRelaunch)"
}
function Write-WatchdogBeat([DateTime]$now) {
    if (($now - $script:lastWatchdogBeat) -lt $watchdogBeatInterval) { return $false }
    $script:lastWatchdogBeat = $now
    Write-Host "$(Get-Date) $(Format-WatchdogBeat (Get-CaptureStatusRaw 5000) (Test-ChromeRunning) $capturePending.Active $script:lastCaptureRecover $script:lastCaptureRelaunch)" -ForegroundColor DarkGray
    return $true
}

# One loop step of capture recovery: reads status, decides, acts, logs.
# Process/HTTP calls go through Get-CaptureStatusRaw / Request-CaptureRecover /
# Restart-CaptureBrowser so the test can mock them.
function Invoke-CaptureRecoveryStep([DateTime]$now) {
    $status = Get-CaptureStatusRaw 5000
    # ---- Chrome gone / 0 live tabs: launch or restart Chrome directly (no recover) ----
    if ($null -ne $status -and $null -ne $status.PSObject.Properties['liveTabs']) {
        $chrome = Test-ChromeRunning
        if ($chrome) { $captureStep.NoChromeSince = $null } elseif ($null -eq $captureStep.NoChromeSince) { $captureStep.NoChromeSince = $now }
        $chromeAge = if ($chrome) { Get-ChromeAgeSec } else { $null }
        $z = Get-ZeroTabStep @{ Now = $now; LiveTabs = [int]$status.liveTabs; ChromeRunning = $chrome; LastChunkAgoMs = $status.lastChunkAgoMs; ChromeAgeSec = $chromeAge; ChromeYoungGrace = $chromeYoungGrace
            NoChromeSince = $captureStep.NoChromeSince; LastOwnLaunch = $script:lastOwnLaunch; LaunchGrace = $launchGrace; NoChromeConfirm = $noChromeConfirm
            NoChromeChunkQuiet = $noChromeChunkQuiet; ZeroTabsAfter = $zeroTabsEscalateAfter; LastNoChromeLaunch = $script:lastNoChromeLaunch; NoChromeGap = $noChromeLaunchGap
            LastRelaunch = $script:lastCaptureRelaunch; RelaunchGap = $relaunchMinGap }
        if ($z.Action -ne "none") {
            if ($null -eq $captureStep.ZeroTabsSince) {
                $captureStep.ZeroTabsSince = $now
                Write-Host "$(Get-Date) [capture-escalate] No capture tab: $($z.Why) (live tabs: $($status.liveTabs), Chrome running: $chrome)." -ForegroundColor Yellow
            }
            $captureStep.PendingSince = $null
            switch ($z.Action) {
                "launch" {
                    Write-Host "$(Get-Date) [capture-escalate] $($z.Why); launching a single tab $captureUrl." -ForegroundColor Yellow
                    Send-BrowserRestarted 5000
                    Start-Browser $captureUrl
                    $script:lastNoChromeLaunch = $now
                    $script:lastOwnLaunch = $now
                    $script:lastCaptureReopen = $now
                    $captureStep.RecoverSentAt = $now   # our launch is the recover attempt: verify, don't reload
                }
                "restart" {
                    Write-Host "$(Get-Date) [capture-escalate] $($z.Why); clean Chrome restart." -ForegroundColor Yellow
                    if ($captureRelaunchChrome) {
                        Restart-CaptureBrowser $captureUrl
                        $script:lastCaptureRelaunch = $now
                        $script:lastOwnLaunch = $now
                        $script:lastCaptureReopen = $now
                        $captureStep.RecoverSentAt = $now
                        Save-CaptureState $captureStateFile $script:lastCaptureRecover $script:lastCaptureRelaunch
                    } else { Write-Host "$(Get-Date) [capture-escalate] CAPTURE_RELAUNCH_CHROME=off; not restarting Chrome." -ForegroundColor DarkYellow }
                }
                "cooldown" { Write-Host "$(Get-Date) [capture-escalate] Not restarting Chrome: $($z.Why)." -ForegroundColor DarkYellow }
                "grace" { }
                default { }
            }
            $script:prevLiveTabs = 0
            return @{ Action = "zero-tabs-$($z.Action)"; Why = $z.Why }
        } elseif ($null -ne $captureStep.ZeroTabsSince) {
            Write-Host "$(Get-Date) [capture-recover] Capture tab(s) back: $($status.liveTabs) live." -ForegroundColor Green
            $captureStep.ZeroTabsSince = $null
        }
    }
    $outage = Get-CaptureOutage 5000
    $pendingTabs = 0
    $lockHeld = -1
    if ($null -ne $status) {
        if ($null -ne $status.PSObject.Properties['pendingTabs']) { $pendingTabs = [int]$status.pendingTabs }
        if ($null -ne $status.PSObject.Properties['lockHeldCapturingTabs']) { $lockHeld = [int]$status.lockHeldCapturingTabs }
    }
    if ($pendingTabs -gt 0) { if ($null -eq $captureStep.PendingSince) { $captureStep.PendingSince = $now } } else { $captureStep.PendingSince = $null }
    $step = Get-CaptureRecoveryStep @{
        Now = $now; Outage = ($null -ne $outage); PendingTabs = $pendingTabs; LockHeldCapturing = $lockHeld
        RecoverSentAt = $captureStep.RecoverSentAt; PendingSince = $captureStep.PendingSince
        LastOwnLaunch = $script:lastOwnLaunch; LaunchGrace = $launchGrace
        LastRecover = $script:lastCaptureRecover; LastRelaunch = $script:lastCaptureRelaunch
        RecoverGap = $recoverMinGap; RelaunchGap = $relaunchMinGap; VerifyWindow = $recoverVerifyWindow; PendingEscalateAfter = $pendingEscalateAfter
    }
    $reason = if ($null -ne $outage) { $outage.Reason } else { "n/a" }
    switch ($step.Action) {
        "none" { }
        "verified" {
            Write-Host "$(Get-Date) [capture-recover] Recovered: $($step.Why) (lockHeldCapturingTabs=$lockHeld)." -ForegroundColor Green
            $captureStep.RecoverSentAt = $null
        }
        "verify-wait" { Write-Host "$(Get-Date) [capture-recover] Verifying recover: $($step.Why); pending tabs: $pendingTabs." -ForegroundColor DarkYellow }
        "skip-pending" { Write-Host "$(Get-Date) [capture-recover] Capture outage ($reason) but NOT reloading: $($step.Why)." -ForegroundColor DarkYellow }
        "recover-cooldown" { Write-Host "$(Get-Date) [capture-recover] Capture outage ($reason) but not recovering: $($step.Why)." -ForegroundColor DarkYellow }
        "escalate-cooldown" {
            Write-Host "$(Get-Date) [capture-escalate] Not restarting Chrome: $($step.Why)." -ForegroundColor DarkYellow
            $captureStep.RecoverSentAt = $null
        }
        "escalate" {
            Write-Host "$(Get-Date) [capture-escalate] Escalating to a clean Chrome restart: $($step.Why) (outage: $reason)." -ForegroundColor Yellow
            if ($captureRelaunchChrome) {
                Restart-CaptureBrowser $captureUrl
                $script:lastCaptureRelaunch = $now
                $script:lastOwnLaunch = $now
                $script:lastCaptureReopen = $now
                Save-CaptureState $captureStateFile $script:lastCaptureRecover $script:lastCaptureRelaunch
            } else {
                Write-Host "$(Get-Date) [capture-escalate] CAPTURE_RELAUNCH_CHROME=off; not restarting Chrome." -ForegroundColor DarkYellow
            }
            $captureStep.RecoverSentAt = $null
            $captureStep.PendingSince = $null
        }
        "recover" {
            $gate = Test-RecoverAllowed $now $lastAppRestart["Dispatch Monitor"] $lastCodeUpdate ([int]$outage.LiveTabs) $prevLiveTabs $recentRecovers $recoverCooldown $maxRecoversPerHour
            if (-not $gate.Allow) {
                Write-Host "$(Get-Date) [capture-recover] Capture outage ($reason) but not recovering: $($gate.Why)." -ForegroundColor DarkYellow
            } else {
                Write-Host "$(Get-Date) [capture-recover] Capture outage: $reason; asking ONE capture tab to recover (reload on $captureUrl); will verify for $([int]$recoverVerifyWindow.TotalSeconds)s." -ForegroundColor Yellow
                $r = Request-CaptureRecover 5000
                if ($r.Accepted) {
                    Write-Host "$(Get-Date) [capture-recover] Server accepted recover -> tab $($r.Target)." -ForegroundColor Yellow
                    $script:lastCaptureRecover = $now
                    $captureStep.RecoverSentAt = $now
                    [void]$recentRecovers.Add($now)
                    Save-CaptureState $captureStateFile $script:lastCaptureRecover $script:lastCaptureRelaunch
                } else {
                    Write-Host "$(Get-Date) [capture-recover] Server refused recover: $($r.Reason)." -ForegroundColor DarkYellow
                    if ($r.Reason -eq "cooldown") { $script:lastCaptureRecover = $now }
                }
            }
        }
    }
    if ($null -ne $outage) { $script:prevLiveTabs = [int]$outage.LiveTabs } else { $script:prevLiveTabs = $null }
    return $step
}

# Pure outage rule; mirror of classifyCaptureOutage() in shared/capture-recover.ts
# (tested by trial/test-watchdog-outage.ps1). Outage only when chunks stopped,
# or chunks flow with a REPORTED level of 0 (suspended audio). Level never
# reported (pre-update bundle) = unknown -> not an outage while chunks flow.
function Get-CaptureOutageDecision($status, [int]$wantingCount, [double]$limitMs) {
    if ([double]$status.uptimeMs -lt $limitMs) { return @{ Outage = $false; Why = "app just started" } }
    if ([int]$status.liveTabs -eq 0) { return @{ Outage = $false; Why = "no live tab" } }
    if ($wantingCount -eq 0) { return @{ Outage = $false; Why = "operator stopped capture" } }
    $ago = $status.lastChunkAgoMs
    if ($null -eq $ago -or [double]$ago -gt $limitMs) { return @{ Outage = $true; Why = "chunks stopped" } }
    $lvl = $status.levelReportedAgoMs
    if ($null -eq $lvl -or [double]$lvl -gt $limitMs) { return @{ Outage = $false; Why = "chunks flowing, level unknown" } }
    $nz = $status.nonzeroLevelAgoMs
    # 2026-10-21: a quiet (0) level is unknown, not an outage (quiet radio reads 0).
    if ($null -eq $nz -or [double]$nz -gt $limitMs) { return @{ Outage = $false; Why = "chunks flowing, level quiet (unknown)" } }
    return @{ Outage = $false; Why = "chunks flowing with level" }
}

# Pure recover gate; mirror of mayRequestRecover() in shared/capture-recover.ts.
function Test-RecoverAllowed([DateTime]$now, [DateTime]$lastAppRestart, [DateTime]$lastCodeUpdate, [int]$liveTabs, $prevLiveTabs, $recentRecovers, [TimeSpan]$cooldown, [int]$maxPerHour) {
    if (($now - $lastAppRestart) -lt $cooldown) { return @{ Allow = $false; Why = "cooldown after app restart" } }
    if (($now - $lastCodeUpdate) -lt $cooldown) { return @{ Allow = $false; Why = "cooldown after code pull" } }
    if ($liveTabs -gt 1 -and $null -ne $prevLiveTabs -and $liveTabs -gt [int]$prevLiveTabs) { return @{ Allow = $false; Why = "live tabs growing" } }
    $hour = @($recentRecovers | Where-Object { ($now - $_) -lt [TimeSpan]::FromHours(1) })
    if ($hour.Count -ge $maxPerHour) { return @{ Allow = $false; Why = "hourly recover cap reached" } }
    return @{ Allow = $true; Why = "" }
}

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
    # 2026-10-21 (DISP-5 storm): servers that report level fields use
    # Get-CaptureOutageDecision -- missing level = unknown (chunk age decides),
    # quiet radio (chunks flowing, sent=0) is NOT an outage.
    if ($null -ne $status.PSObject.Properties['levelReportedAgoMs']) {
        $d = Get-CaptureOutageDecision $status $wanting.Count $captureInactiveLimit.TotalMilliseconds
        if (-not $d.Outage) { return $null }
        return @{ Reason = "$($d.Why) (live tabs: $live, capturing: $($status.capturingTabs), last chunk: $($status.lastChunkAgoMs) ms ago)"; LiveTabs = $live }
    }
    $ago = $status.lastChunkAgoMs
    if ($null -ne $ago -and [double]$ago -le $limitMs) { return $null }
    $agoText = if ($null -eq $ago) { "never" } else { "$([int]([double]$ago / 60000)) min ago" }
    return @{ Reason = "no capture chunk for $($captureNoChunkLimit.TotalMinutes)+ min (last: $agoText, live tabs: $live, capturing: $($status.capturingTabs))"; LiveTabs = $live }
}

# Returns @{ Accepted; Target; Reason }. 429 = server refused (cooldown / tab-pending / no-live-tab).
function Request-CaptureRecover($port) {
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/capture/recover" -Method POST -TimeoutSec 15 -UseBasicParsing
        return @{ Accepted = $true; Target = $r.targetTabId; Reason = "" }
    } catch {
        $code = $null
        try { $code = [int]$_.Exception.Response.StatusCode } catch { }
        $reason = "request failed: $_"
        if ($code -eq 429) {
            $reason = "refused (429)"
            try { $j = $_.ErrorDetails.Message | ConvertFrom-Json; if ($j.reason) { $reason = "$($j.reason)" } } catch { }
        }
        Write-Warning "$(Get-Date) Capture recover request: $reason"
        return @{ Accepted = $false; Target = $null; Reason = $reason }
    }
}

# After killing Chrome: tell the server every tab is gone so the stale lease /
# tabs / outstanding recover clear at once (Disp-4: the lease took ~3 min).
function Send-BrowserRestarted($port) {
    Write-Host "$(Get-Date) [capture-escalate] POST /api/capture/browser-restarted (clear lease/tabs/recover)..." -ForegroundColor Cyan
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/capture/browser-restarted" -Method POST -ContentType "application/json" -Body "{}" -TimeoutSec 10 -UseBasicParsing
        Write-Host "$(Get-Date) [capture-escalate] Server cleared lease/tabs/recover (tabs dropped: $($r.tabsCleared), lease: $(if ($r.leaseCleared) { $r.leaseCleared } else { 'none' }))." -ForegroundColor Cyan
        return $true
    } catch {
        Write-Warning "$(Get-Date) [capture-escalate] browser-restarted POST failed (old server?): $_"
        return $false
    }
}

function Get-CaptureStatusRaw($port) {
    try { return Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/capture/status" -Method GET -TimeoutSec 15 -UseBasicParsing } catch { return $null }
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
        # Chunks flowing is capture too (quiet radio sends nothing; an old
        # bundle reports no level) unless the level is reported and stuck at 0.
        if ($status.leaseHolder -and $null -ne $status.lastChunkAgoMs -and [double]$status.lastChunkAgoMs -lt $captureFreshHeartbeat.TotalMilliseconds) {
            $lvlKnown = $null -ne $status.levelReportedAgoMs -and [double]$status.levelReportedAgoMs -lt $captureFreshHeartbeat.TotalMilliseconds
            $nzRecent = $null -ne $status.nonzeroLevelAgoMs -and [double]$status.nonzeroLevelAgoMs -lt $captureFreshHeartbeat.TotalMilliseconds
            if (-not $lvlKnown -or $nzRecent) { return $true }
        }
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
            # Chrome closed / 0 tabs at boot: the recovery step launches ONE tab
            # (never next to a live tab or a Chrome younger than 60 s).
            try { [void](Invoke-CaptureRecoveryStep ([DateTime]::Now)) } catch { }
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
    # 2026-10-22 (Disp-4 boot 7:32-7:46 PM): the boot check used to open an
    # extra page whenever no tab held the lease -- next to a live standby tab,
    # 90 s after a clean Chrome restart -- and both tabs sat in standby. It
    # never opens a page now: it hands off to Invoke-CaptureRecoveryStep,
    # which launches/restarts Chrome (single tab) only with 0 live tabs or no
    # Chrome, never within $chromeYoungGrace of a Chrome start, and the server
    # hands the lock+lease to exactly one tab when nobody holds it.
    $live = if ($null -ne $status.PSObject.Properties['liveTabs']) { [int]$status.liveTabs } else { -1 }
    Write-Host "$(Get-Date) [capture-boot] Capture not confirmed $([int]($now - $capturePending.AnsweredAt).TotalSeconds)s after the app answered (live tabs: $live, lease: $(if ($status.leaseHolder) { $status.leaseHolder } else { 'none' })); NOT opening another page -- handing over to capture recovery." -ForegroundColor Yellow
    $capturePending.Active = $false
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
$captureStateFile = Join-Path $dispatchMonitor "logs\watchdog-capture-state.json"
$persisted = Read-CaptureState $captureStateFile
$lastCaptureRecover = $persisted.LastRecover
$lastCaptureRelaunch = $persisted.LastRelaunch
Write-Host "$(Get-Date) [capture-recover] Last recover: $(if ($lastCaptureRecover -eq [DateTime]::MinValue) { 'never' } else { $lastCaptureRecover }); last Chrome restart: $(if ($lastCaptureRelaunch -eq [DateTime]::MinValue) { 'never' } else { $lastCaptureRelaunch })." -ForegroundColor Cyan
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
    # Self-update follows a code pull: open pages may still run the old bundle.
    $lastCodeUpdate = Get-Date
}
$dmLog = Join-Path $dispatchMonitor "logs\dispatch-monitor.log"
$captureStateFile = Join-Path $dispatchMonitor "logs\watchdog-capture-state.json"
$persisted = Read-CaptureState $captureStateFile
$lastCaptureRecover = $persisted.LastRecover
$lastCaptureRelaunch = $persisted.LastRelaunch
Write-Host "$(Get-Date) [capture-recover] Last recover: $(if ($lastCaptureRecover -eq [DateTime]::MinValue) { 'never' } else { $lastCaptureRecover }); last Chrome restart: $(if ($lastCaptureRelaunch -eq [DateTime]::MinValue) { 'never' } else { $lastCaptureRelaunch })." -ForegroundColor Cyan

Write-Host "Watchdog running. Whisper restart every $($whisperRestartInterval.TotalHours)h, git pull of origin/$deployBranch every $($gitPullInterval.TotalHours)h." -ForegroundColor Green

# Consecutive-failure debounce (2026-09-22): a single slow/timed-out health
# check under CPU contention is not "dead" -- restarting on one miss forces a
# model reload that adds more load, causing the next check to miss too.
# Require 2 consecutive misses (~2 health-check cycles) before restarting.
$whisperFailStreak = 0

while ($true) {
    # Capture checks every $captureCheckInterval while waiting for the next
    # full health check (2026-10-21: 60 s loop made Chrome-closed detection slow).
    $nextFull = ([DateTime]::Now) + $healthCheckInterval
    while (([DateTime]::Now) -lt $nextFull) {
        $left = ($nextFull - ([DateTime]::Now)).TotalSeconds
        Start-Sleep -Seconds ([Math]::Max(1, [Math]::Min($captureCheckInterval.TotalSeconds, [Math]::Ceiling($left))))
        # Runs during the boot window too (2026-10-22): it is the only path that
        # opens Chrome, and it never adds a tab next to a live one.
        try { [void](Invoke-CaptureRecoveryStep ([DateTime]::Now)) } catch { Write-Warning "$(Get-Date) Capture check failed (continuing): $_" }
        try { [void](Write-WatchdogBeat ([DateTime]::Now)) } catch { Write-Warning "$(Get-Date) Watchdog heartbeat line failed: $_" }
    }
    # 2026-10-21: one failing step must never stop the loop.
    try {

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
    # (Capture recovery runs every $captureCheckInterval in the wait loop above.)

    # Pull git updates periodically. Not while the boot capture page is still
    # pending (at most ~15 min): a pull can restart the app or hand off to a
    # new watchdog instance (-NoInitialStart), which would drop that state.
    if (-not $capturePending.Active -and ($now - $lastGitPull) -gt $gitPullInterval) {
        # Stamp first: a failed/timed-out pull waits for the next interval.
        $lastGitPull = $now
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
            [void](Invoke-NpmInstall $dispatchMonitor)
            Restart-App "Dispatch Monitor" $dispatchMonitor 5000 "npm run dev" $dmLog
            $lastCodeUpdate = Get-Date
            $lastAppRestart["Dispatch Monitor"] = Get-Date
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
    } catch {
        Write-Warning "$(Get-Date) Watchdog loop step failed (continuing): $_"
    }
}
