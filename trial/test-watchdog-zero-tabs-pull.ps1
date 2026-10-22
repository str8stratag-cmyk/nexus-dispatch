# Disp-4 live-test failure (2026-10-21 5:38-5:44 PM): 0 live tabs -> nothing
# for 4+ min; loop silent after "Pull of origin/release failed" on a detached
# HEAD. Uses the REAL watchdog functions (AST-extracted); git runs for real
# against temp repos; Chrome/HTTP are mocked.
# Run: pwsh -NoProfile -File trial/test-watchdog-zero-tabs-pull.ps1
$ErrorActionPreference = "Stop"
$path = Join-Path $PSScriptRoot "..\scripts\watchdog.ps1"
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw "watchdog.ps1 parse errors: $($errors.Count)" }
foreach ($name in @("Set-ChromeCapturePolicy", "Get-CaptureRecoveryStep", "Invoke-CaptureRecoveryStep", "Get-ZeroTabStep", "Test-RecoverAllowed", "Read-CaptureState", "Save-CaptureState",
        "Invoke-External", "Invoke-Git", "Pull-Repo", "Get-RegistryKeyChain")) {
    $fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
    if (-not $fn) { throw "function $name not found" }
    . ([ScriptBlock]::Create($fn.Extent.Text))
}
$script:failures = 0
function Check($name, $actual, $expected) {
    $ok = "$actual" -eq "$expected"
    if (-not $ok) { $script:failures++ }
    Write-Host ("{0}: {1}{2}" -f $(if ($ok) { "ok  " } else { "FAIL" }), $name, $(if ($ok) { "" } else { " -- got '$actual', want '$expected'" }))
}
$min = [DateTime]::MinValue
$t0 = Get-Date "2026-10-21T17:40:00"

# ---------------- 0 live tabs / Chrome closed ----------------
$recoverMinGap = [TimeSpan]::FromMinutes(30); $relaunchMinGap = [TimeSpan]::FromMinutes(30)
$recoverVerifyWindow = [TimeSpan]::FromSeconds(90); $pendingEscalateAfter = [TimeSpan]::FromMinutes(5)
$captureCheckInterval = [TimeSpan]::FromSeconds(15)
$zeroTabsEscalateAfter = [TimeSpan]::FromSeconds(45); $noChromeConfirm = [TimeSpan]::FromSeconds(10)
$noChromeChunkQuiet = [TimeSpan]::FromSeconds(15); $noChromeLaunchGap = [TimeSpan]::FromMinutes(2); $launchGrace = [TimeSpan]::FromSeconds(90)
$recoverCooldown = [TimeSpan]::FromMinutes(10); $maxRecoversPerHour = 3
$recentRecovers = New-Object System.Collections.ArrayList
$lastAppRestart = @{ "Dispatch Monitor" = $min }; $lastCodeUpdate = $min; $prevLiveTabs = $null
$captureRelaunchChrome = $true; $captureUrl = "http://localhost:5000"
$captureStateFile = Join-Path ([IO.Path]::GetTempPath()) "wd-zero-$PID.json"

# Simulated desk on a timeline. A launched Chrome shows its tab (heartbeat)
# after TabAfter s and is capturing with the lock held after CaptureAfter s.
$sim = @{}
function Reset-Sim($o = @{}) {
    $script:lastCaptureRecover = $min; $script:lastCaptureRelaunch = $min; $script:lastCaptureReopen = $min; $script:lastNoChromeLaunch = $min; $script:lastOwnLaunch = $min
    $script:captureStep = @{ RecoverSentAt = $null; PendingSince = $null; ZeroTabsSince = $null; NoChromeSince = $null }
    $recentRecovers.Clear()
    $script:sim = @{ Now = $t0; Chrome = $true; Live = 1; LastChunk = $t0; Capturing = $true; LaunchedAt = $null; ChromeFails = $false
        TabAfter = 8; CaptureAfter = 25; Launches = 0; Restarts = 0; Recovers = 0; Notified = 0; CaptureBackAt = $null }
    foreach ($k in $o.Keys) { $script:sim[$k] = $o[$k] }
}
function Advance([DateTime]$now) {
    $sim.Now = $now
    if ($null -ne $sim.LaunchedAt -and $sim.Chrome) {
        $since = ($now - $sim.LaunchedAt).TotalSeconds
        if ($since -ge $sim.TabAfter) { $sim.Live = 1 }
        if ($since -ge $sim.CaptureAfter) { $sim.Capturing = $true; $sim.LastChunk = $now; if ($null -eq $sim.CaptureBackAt) { $sim.CaptureBackAt = $now } }
    } elseif ($sim.Capturing) { $sim.LastChunk = $now }
}
function Get-CaptureStatusRaw($port) {
    $ago = if ($null -eq $sim.LastChunk) { $null } else { ($sim.Now - $sim.LastChunk).TotalMilliseconds }
    [pscustomobject]@{ uptimeMs = 3600000; liveTabs = $sim.Live; lastChunkAgoMs = $ago; pendingTabs = 0; lockHeldCapturingTabs = $(if ($sim.Capturing -and $sim.Live) { 1 } else { 0 }) }
}
function Get-CaptureOutage($port) { if ($sim.Live -gt 0 -and -not $sim.Capturing) { @{ Reason = "chunks stopped"; LiveTabs = $sim.Live } } else { $null } }
function Request-CaptureRecover($port) { $sim.Recovers++; @{ Accepted = $true; Target = "x" } }
function Test-ChromeRunning() { $sim.Chrome }
function Get-ChromeAgeSec() { 3600 }
function Start-Browser($url) { $sim.Launches++; if (-not $sim.ChromeFails) { $sim.Chrome = $true; $sim.LaunchedAt = $sim.Now } }
function Restart-CaptureBrowser($url) { $sim.Restarts++; $sim.Live = 0; $sim.Capturing = $false; Send-BrowserRestarted 5000; $sim.Chrome = $true; $sim.LaunchedAt = $sim.Now }
function Send-BrowserRestarted($port) { $sim.Notified++; $sim.LastChunk = $null; return $true }
# Run the 15 s capture-check loop from $start for $seconds; return actions.
function Run-Timeline([DateTime]$start, [int]$seconds, [int]$step = 15) {
    $acts = @()
    for ($s = 0; $s -le $seconds; $s += 1) {
        Advance $start.AddSeconds($s)
        if ($s % $step -eq 0) { $acts += (Invoke-CaptureRecoveryStep $sim.Now 6>$null 3>$null).Action }
    }
    return $acts
}
function Close-Chrome([DateTime]$at, [switch]$KeepProcess) { $sim.Now = $at; $sim.Capturing = $false; $sim.Live = 0; $sim.Chrome = [bool]$KeepProcess; $sim.LastChunk = $at.AddSeconds(-2) }

# A: 2-minute end-to-end target. Chrome closed (process gone) at every phase of the 15 s check cycle.
$worst = 0; $allOk = $true; $recov = 0; $launch = 0; $notified = 0
foreach ($phase in 0..14) {
    Reset-Sim
    $null = Run-Timeline $t0 30          # healthy
    $closeAt = $t0.AddSeconds(30 + $phase)
    Close-Chrome $closeAt
    $null = Run-Timeline $closeAt.AddSeconds(1) 300
    if ($null -eq $sim.CaptureBackAt) { $allOk = $false; continue }
    $took = ($sim.CaptureBackAt - $closeAt).TotalSeconds
    if ($took -gt $worst) { $worst = $took }
    $recov += $sim.Recovers; $launch += $sim.Launches; $notified += $sim.Notified
}
Check "Chrome closed: capture back within 2 min at every check phase (worst $([int]$worst)s)" ($allOk -and $worst -le 120) $true
Check "Chrome closed: zero reloads/recovers (incl. right after own launch)" $recov 0
Check "Chrome closed: one launch per case" $launch 15
Check "Chrome closed: server told to clear lease/tabs every launch" $notified 15

# A2: Disp-4 retest shape: capture back but the new tab only reports capturing late (60 s) -> still no reload.
Reset-Sim @{ CaptureAfter = 70 }
Close-Chrome $t0
$a = Run-Timeline $t0.AddSeconds(1) 300
Check "slow new tab: no recover right after own launch" $sim.Recovers 0

# B: Chrome window closed but process lingers (background mode): 0 live tabs -> clean restart, within 2 min.
Reset-Sim
Close-Chrome $t0 -KeepProcess
$null = Run-Timeline $t0.AddSeconds(1) 300
Check "0 tabs, Chrome lingering: one clean restart" $sim.Restarts 1
Check "0 tabs, Chrome lingering: capture back within 2 min ($([int]($sim.CaptureBackAt - $t0).TotalSeconds)s)" ($null -ne $sim.CaptureBackAt -and ($sim.CaptureBackAt - $t0).TotalSeconds -le 120) $true
Check "0 tabs, Chrome lingering: restart capped (still 1 after 5 min)" $sim.Restarts 1

# C: plain tab reload (0 live tabs for ~3 s, chunks fresh) -> nothing.
Reset-Sim
$sim.Live = 0; $sim.LastChunk = $t0
$r = Invoke-CaptureRecoveryStep $t0.AddSeconds(3) 6>$null
Check "tab reload gap: no launch/restart" "$($r.Action)/$($sim.Launches)/$($sim.Restarts)" "zero-tabs-wait/0/0"

# D: Chrome will not start -> relaunch allowed (not 30-min capped) but >= 2 min apart.
Reset-Sim @{ ChromeFails = $true }
Close-Chrome $t0
$null = Run-Timeline $t0.AddSeconds(1) 600
Check "Chrome fails to start: retries spaced (got $($sim.Launches) in 10 min)" ($sim.Launches -ge 3 -and $sim.Launches -le 6) $true
Check "Chrome fails to start: zero recovers" $sim.Recovers 0

# E: pure table.
$z = @{ Now = $t0; LiveTabs = 0; ChromeRunning = $false; LastChunkAgoMs = 20000; NoChromeSince = $t0.AddSeconds(-15); LastOwnLaunch = $min; LaunchGrace = $launchGrace
    NoChromeConfirm = $noChromeConfirm; NoChromeChunkQuiet = $noChromeChunkQuiet; ZeroTabsAfter = $zeroTabsEscalateAfter; LastNoChromeLaunch = $min; NoChromeGap = $noChromeLaunchGap
    LastRelaunch = $t0.AddMinutes(-5); RelaunchGap = $relaunchMinGap }
Check "no Chrome launch ignores the 30-min restart cap" (Get-ZeroTabStep $z).Action "launch"
$z.LastOwnLaunch = $t0.AddSeconds(-30)
Check "inside own-launch grace -> grace" (Get-ZeroTabStep $z).Action "grace"
$z.LastOwnLaunch = $min; $z.ChromeRunning = $true; $z.LastChunkAgoMs = 60000
Check "Chrome running + restarted 5 min ago -> cooldown" (Get-ZeroTabStep $z).Action "cooldown"
$z.LastChunkAgoMs = 30000
Check "Chrome running, 0 tabs, chunk 30 s ago -> wait" (Get-ZeroTabStep $z).Action "wait"
$z.ChromeRunning = $false; $z.LastChunkAgoMs = 5000
Check "no chrome process but chunks fresh (other browser) -> none" (Get-ZeroTabStep $z).Action "none"
$g = Get-CaptureRecoveryStep @{ Now = $t0; Outage = $true; PendingTabs = 0; LockHeldCapturing = 0; RecoverSentAt = $null; PendingSince = $null; LastRecover = $min; LastRelaunch = $min
    RecoverGap = $recoverMinGap; RelaunchGap = $relaunchMinGap; VerifyWindow = $recoverVerifyWindow; PendingEscalateAfter = $pendingEscalateAfter; LastOwnLaunch = $t0.AddSeconds(-60); LaunchGrace = $launchGrace }
Check "outage 60 s after own launch -> no reload" $g.Action "launch-grace"

# ---------------- registry key chain ----------------
Check "registry parents created first" ((Get-RegistryKeyChain "HKCU:\Software\Policies\Google\Chrome\AutoplayAllowlist") -join "|") "HKCU:\Software|HKCU:\Software\Policies|HKCU:\Software\Policies\Google|HKCU:\Software\Policies\Google\Chrome|HKCU:\Software\Policies\Google\Chrome\AutoplayAllowlist"

# Registry policy: access denied must be silent best effort (no warning/error).
$chromeCapturePolicy = $true; $captureOrigins = @("http://localhost:5000"); $chromePolicyNoted = $false
function New-Item { throw [System.UnauthorizedAccessException]::new("Access to the registry key 'HKEY_CURRENT_USER\Software\Policies\Google' is denied.") }
function Test-Path { $false }
$warn = Set-ChromeCapturePolicy 3>&1 2>&1 6>$null
Check "registry denied: no warning/error emitted" (@($warn).Count) 0
Remove-Item Function:\New-Item, Function:\Test-Path

# ---------------- external calls never block ----------------
$sw = [Diagnostics.Stopwatch]::StartNew()
$r = Invoke-External "sleep" @("30") 2
Check "hung external command killed at timeout ($([int]$sw.Elapsed.TotalSeconds)s)" ($r.TimedOut -and $sw.Elapsed.TotalSeconds -lt 8) $true

# ---------------- Pull-Repo: detached HEAD / failed pull ----------------
$gitTimeoutSec = 5; $gitPullTimeoutSec = 5; $npmTimeoutSec = 5
$tmp = Join-Path ([IO.Path]::GetTempPath()) "wd-pull-$PID"
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory $tmp | Out-Null
$origin = Join-Path $tmp "origin.git"; $desk = Join-Path $tmp "desk"
git init -q --bare -b release $origin
git clone -q $origin $desk 2>$null
git -C $desk -c user.email=t@t -c user.name=t commit -q --allow-empty -m one
git -C $desk push -q origin HEAD:release 2>$null
$seed = Join-Path $tmp "seed"; git clone -q -b release $origin $seed 2>$null
git -C $seed -c user.email=t@t -c user.name=t commit -q --allow-empty -m two; git -C $seed push -q origin release 2>$null

git -C $desk checkout -q --detach HEAD
$sw = [Diagnostics.Stopwatch]::StartNew()
$out = Pull-Repo $desk "release" 6>&1 3>&1 | Out-String
Check "detached HEAD: no pull, returns false" (Pull-Repo $desk "release" 6>$null 3>$null) $false
Check "detached HEAD: logs why" ($out -match "detached HEAD") $true
Check "detached HEAD: returns fast ($([int]$sw.Elapsed.TotalSeconds)s)" ($sw.Elapsed.TotalSeconds -lt 10) $true
Check "detached HEAD: tree not moved" ((git -C $desk log -1 --format=%s)) "one"

git -C $desk checkout -q -B feature
Check "other branch: skipped" (Pull-Repo $desk "release" 6>$null 3>$null) $false

git -C $desk checkout -q release 2>$null; if ($LASTEXITCODE) { git -C $desk checkout -q -B release origin/release }
git -C $desk reset -q --hard HEAD~0
git -C $desk -c user.email=t@t -c user.name=t commit -q --allow-empty -m local-diverged
$out = Pull-Repo $desk "release" 6>&1 3>&1 | Out-String
Check "diverged: pull fails cleanly (ff-only), logs it" ($out -match "Pull of origin/release failed") $true
Check "diverged: tree left as it was" ((git -C $desk log -1 --format=%s)) "local-diverged"

git -C $desk reset -q --hard origin/release~1 2>$null; git -C $desk fetch -q origin 2>$null; git -C $desk reset -q --hard origin/release~1
Check "on release, behind: fast-forward pull works" (Pull-Repo $desk "release" 6>$null 3>$null) $true

# Unreachable origin (black-hole address): must time out, not hang.
git -C $desk remote set-url origin "http://10.255.255.1/x.git"
$sw = [Diagnostics.Stopwatch]::StartNew()
$res = Pull-Repo $desk "release" 6>$null 3>$null
Check "unreachable origin: gives up within timeout ($([int]$sw.Elapsed.TotalSeconds)s)" ((-not $res) -and $sw.Elapsed.TotalSeconds -lt 15) $true

# After a failed pull the next capture step still runs (loop not stalled).
Reset-Sim
$null = Pull-Repo $desk "release" 6>$null 3>$null
Close-Chrome $t0
$a = Run-Timeline $t0.AddSeconds(1) 40
Check "after failed pull: Chrome-closed launch still happens" (($a -join ",") -match "zero-tabs-launch") $true

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Remove-Item $captureStateFile -ErrorAction SilentlyContinue
if ($script:failures) { Write-Host "$($script:failures) FAILURES"; exit 1 } else { Write-Host "all watchdog zero-tabs/pull tests passed"; exit 0 }
