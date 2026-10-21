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
foreach ($name in @("Get-CaptureRecoveryStep", "Invoke-CaptureRecoveryStep", "Get-ZeroTabStep", "Test-RecoverAllowed", "Read-CaptureState", "Save-CaptureState",
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

# ---------------- 0 live tabs ----------------
$recoverMinGap = [TimeSpan]::FromMinutes(30); $relaunchMinGap = [TimeSpan]::FromMinutes(30)
$recoverVerifyWindow = [TimeSpan]::FromSeconds(90); $pendingEscalateAfter = [TimeSpan]::FromMinutes(5)
$zeroTabsEscalateAfter = [TimeSpan]::FromSeconds(90); $noChromeLaunchGap = [TimeSpan]::FromMinutes(2)
$recoverCooldown = [TimeSpan]::FromMinutes(10); $maxRecoversPerHour = 3
$recentRecovers = New-Object System.Collections.ArrayList
$lastAppRestart = @{ "Dispatch Monitor" = $min }; $lastCodeUpdate = $min; $prevLiveTabs = $null
$captureRelaunchChrome = $true; $captureUrl = "http://localhost:5000"
$captureStateFile = Join-Path ([IO.Path]::GetTempPath()) "wd-zero-$PID.json"
$sim = @{ Live = 0; Chrome = $false; Launches = 0; Restarts = 0; Recovers = 0; Notified = 0; HealOnLaunch = $false }
function Get-CaptureStatusRaw($port) { [pscustomobject]@{ uptimeMs = 3600000; liveTabs = $sim.Live; lastChunkAgoMs = $null; pendingTabs = 0; lockHeldCapturingTabs = 0 } }
function Get-CaptureOutage($port) { if ($sim.Live -gt 0 -and -not $sim.HealOnLaunch) { @{ Reason = "chunks stopped"; LiveTabs = $sim.Live } } else { $null } }
function Request-CaptureRecover($port) { $sim.Recovers++; @{ Accepted = $true; Target = "x" } }
function Test-ChromeRunning() { $sim.Chrome }
function Start-Browser($url) { $sim.Launches++; $sim.Chrome = -not $sim.ChromeFails; if ($sim.HealOnLaunch) { $sim.Live = 1 } }
function Restart-CaptureBrowser($url) { $sim.Restarts++; $sim.Chrome = $true; if ($sim.HealOnLaunch) { $sim.Live = 1 } }
function Send-BrowserRestarted($port) { $sim.Notified++ }
function Reset-Sim() {
    $script:lastCaptureRecover = $min; $script:lastCaptureRelaunch = $min; $script:lastCaptureReopen = $min; $script:lastNoChromeLaunch = $min
    $script:captureStep = @{ RecoverSentAt = $null; PendingSince = $null; ZeroTabsSince = $null }
    $sim.Live = 0; $sim.Chrome = $false; $sim.Launches = 0; $sim.Restarts = 0; $sim.Recovers = 0; $sim.Notified = 0; $sim.HealOnLaunch = $false; $sim.ChromeFails = $false
}
function Run($n, $everySec = 30) { $acts = @(); for ($i = 0; $i -lt $n; $i++) { $acts += (Invoke-CaptureRecoveryStep $t0.AddSeconds($everySec * $i) 6>$null).Action }; return $acts }

# A: Disp-4 repro: Chrome fully closed, 0 live tabs. Launch at 90 s, no recover request.
Reset-Sim; $sim.HealOnLaunch = $true
$a = Run 6
Check "0 tabs, no Chrome: waits then launches at 90 s" ($a[0..3] -join ",") "zero-tabs-wait,zero-tabs-wait,zero-tabs-wait,zero-tabs-launch"
Check "0 tabs: never asks for a recover" $sim.Recovers 0
Check "0 tabs, no Chrome: launched once, no kill" "$($sim.Launches)/$($sim.Restarts)" "1/0"

# B: no Chrome, and Chrome fails to start -> relaunch allowed (not 30-min capped), but >= 2 min apart.
Reset-Sim; $sim.ChromeFails = $true
$null = Run 20  # 10 min
Check "no Chrome: launches repeat (always allowed) but spaced (got $($sim.Launches) in 10 min)" ($sim.Launches -ge 2 -and $sim.Launches -le 5) $true
Check "no Chrome: still zero recovers" $sim.Recovers 0

# C: Chrome running with 0 live tabs -> clean restart once, then 30-min cap; server told.
Reset-Sim; $sim.Chrome = $true
$null = Run 40  # 20 min
Check "Chrome running, 0 tabs: exactly one clean restart in 20 min" $sim.Restarts 1
Check "server told Chrome restarted (lease/tabs cleared)" $sim.Notified 1
Check "Chrome running, 0 tabs: no plain launches" $sim.Launches 0

# D: pure step table.
$z = @{ Now = $t0; ZeroTabsSince = $t0.AddSeconds(-95); After = $zeroTabsEscalateAfter; ChromeRunning = $false; LastNoChromeLaunch = $min; NoChromeGap = $noChromeLaunchGap; LastRelaunch = $t0.AddMinutes(-5); RelaunchGap = $relaunchMinGap }
Check "no Chrome launch ignores the 30-min restart cap" (Get-ZeroTabStep $z).Action "launch"
$z.ChromeRunning = $true
Check "Chrome running + restarted 5 min ago -> cooldown" (Get-ZeroTabStep $z).Action "cooldown"

# ---------------- registry key chain ----------------
Check "registry parents created first" ((Get-RegistryKeyChain "HKCU:\Software\Policies\Google\Chrome\AutoplayAllowlist") -join "|") "HKCU:\Software|HKCU:\Software\Policies|HKCU:\Software\Policies\Google|HKCU:\Software\Policies\Google\Chrome|HKCU:\Software\Policies\Google\Chrome\AutoplayAllowlist"

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
Reset-Sim; $sim.HealOnLaunch = $true
$null = Pull-Repo $desk "release" 6>$null 3>$null
$a = Run 4
Check "after failed pull: 0-tab escalation still happens" $a[3] "zero-tabs-launch"

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Remove-Item $captureStateFile -ErrorAction SilentlyContinue
if ($script:failures) { Write-Host "$($script:failures) FAILURES"; exit 1 } else { Write-Host "all watchdog zero-tabs/pull tests passed"; exit 0 }
