# Disp-4 boot race (2026-10-21 7:32-7:46 PM): boot check opened a SECOND page
# next to a live standby tab 90 s after a clean Chrome restart; both stayed in
# standby ~14 min. REAL watchdog functions (AST); server/Chrome simulated.
# Run: pwsh -NoProfile -File trial/test-watchdog-boot-race.ps1
$ErrorActionPreference = "Stop"
$path = Join-Path $PSScriptRoot "..\scripts\watchdog.ps1"
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw "watchdog.ps1 parse errors: $($errors.Count)" }
foreach ($name in @("Step-BootCapturePage", "Test-CaptureConfirmed", "Invoke-CaptureRecoveryStep", "Get-ZeroTabStep", "Get-CaptureRecoveryStep", "Test-RecoverAllowed",
        "Save-CaptureState", "Format-WatchdogBeat", "Write-WatchdogBeat")) {
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
$recoverMinGap = [TimeSpan]::FromMinutes(30); $relaunchMinGap = [TimeSpan]::FromMinutes(30)
$recoverVerifyWindow = [TimeSpan]::FromSeconds(90); $pendingEscalateAfter = [TimeSpan]::FromMinutes(5)
$zeroTabsEscalateAfter = [TimeSpan]::FromSeconds(45); $noChromeConfirm = [TimeSpan]::FromSeconds(10)
$noChromeChunkQuiet = [TimeSpan]::FromSeconds(15); $noChromeLaunchGap = [TimeSpan]::FromMinutes(2); $launchGrace = [TimeSpan]::FromSeconds(90)
$chromeYoungGrace = [TimeSpan]::FromSeconds(60)
$recoverCooldown = [TimeSpan]::FromMinutes(10); $maxRecoversPerHour = 3
$recentRecovers = New-Object System.Collections.ArrayList
$lastAppRestart = @{ "Dispatch Monitor" = $min }; $lastCodeUpdate = $min; $prevLiveTabs = $null
$captureRelaunchChrome = $true; $captureUrl = "http://localhost:5000"; $bootCaptureUrl = $captureUrl
$captureStateFile = Join-Path ([IO.Path]::GetTempPath()) "wd-boot-$PID.json"
$captureConfirmWait = [TimeSpan]::FromSeconds(90); $captureFreshHeartbeat = [TimeSpan]::FromSeconds(150)
$capturePendingMax = [TimeSpan]::FromMinutes(30)
$watchdogBeatInterval = [TimeSpan]::FromMinutes(5)

# ---- simulated desk + server (server-side takeover as in shared/capture-recover-coordinator.ts:
# holderless 20 s -> one tab told on its next 15 s beat -> capturing 10 s later) ----
$t0 = Get-Date "2026-10-21T19:32:46"
function New-Sim($o) {
    $sim = @{ Now = $t0; Chrome = $true; ChromeStarted = $t0; Tabs = @(); Opens = 0; Restarts = 0; Recovers = 0
        HolderlessSince = $null; Told = $null; CaptureAt = $null; ServerTakeover = $true }
    foreach ($k in $o.Keys) { $sim[$k] = $o[$k] }
    return $sim
}
function Add-Tab($at) { $script:sim.Tabs += @{ Id = "T$($script:sim.Tabs.Count)"; SeenAt = $at; Lock = "standby"; Capturing = $false } }
function Step-Server([DateTime]$now) {
    $sim = $script:sim
    $live = @($sim.Tabs | Where-Object { ($now - $_.SeenAt).TotalSeconds -ge 3 })
    $holder = @($live | Where-Object { $_.Lock -eq "held" -or $_.Capturing })
    if ($holder.Count -or -not $live.Count) { $sim.HolderlessSince = $null } elseif ($null -eq $sim.HolderlessSince) { $sim.HolderlessSince = $now }
    if ($sim.ServerTakeover -and $null -eq $sim.Told -and $null -ne $sim.HolderlessSince -and ($now - $sim.HolderlessSince).TotalSeconds -ge 35) {
        $sim.Told = $now; $live[0].Lock = "held"
    }
    if ($null -ne $sim.Told -and ($now - $sim.Told).TotalSeconds -ge 10) {
        foreach ($t in $live) { if ($t.Lock -eq "held") { $t.Capturing = $true } }
        if ($null -eq $sim.CaptureAt) { $sim.CaptureAt = $now }
    }
}
function Get-CaptureStatusRaw($port) {
    $sim = $script:sim; $now = $sim.Now
    $live = @($sim.Tabs | Where-Object { ($now - $_.SeenAt).TotalSeconds -ge 3 })
    $cap = @($live | Where-Object { $_.Capturing -and $_.Lock -eq "held" })
    $holder = @($live | Where-Object { $_.Lock -eq "held" } | Select-Object -First 1)
    [pscustomobject]@{ uptimeMs = 120000; liveTabs = $live.Count; capturingTabs = $cap.Count; lockHeldCapturingTabs = $cap.Count; pendingTabs = 0
        lastChunkAgoMs = $(if ($cap.Count) { 1000 } else { $null }); leaseHolder = $(if ($cap.Count) { $holder[0].Id } else { $null }); leaseConfirmed = $(if ($cap.Count) { $true } else { $null })
        lastActiveAgoMs = $(if ($cap.Count) { 1000 } else { $null }); lastHeartbeatAgoMs = $(if ($live.Count) { 5000 } else { $null }); levelReportedAgoMs = $null; nonzeroLevelAgoMs = $null; tabs = @() }
}
function Get-CaptureStatus($port) { Get-CaptureStatusRaw $port }
function Get-CaptureOutage($port) { $null }  # app uptime < outage limit at boot
function Request-CaptureRecover($port) { $script:sim.Recovers++; @{ Accepted = $true } }
function Test-ChromeRunning() { $script:sim.Chrome }
function Get-ChromeAgeSec() { if ($script:sim.Chrome) { ($script:sim.Now - $script:sim.ChromeStarted).TotalSeconds } else { $null } }
function Start-Browser($url) { $s = $script:sim; $s.Opens++; if (-not $s.Chrome) { $s.Chrome = $true; $s.ChromeStarted = $s.Now }; Add-Tab $s.Now }
function Restart-CaptureBrowser($url) { $s = $script:sim; $s.Restarts++; $s.Tabs = @(); $s.ChromeStarted = $s.Now; Add-Tab $s.Now }
function Send-BrowserRestarted($port) { }
function Test-AppAlive($port) { $true }

function Run-Boot([int]$seconds) {
    $script:lastCaptureRecover = $min; $script:lastCaptureRelaunch = $min; $script:lastCaptureReopen = $min; $script:lastNoChromeLaunch = $min; $script:lastOwnLaunch = $min
    $script:captureStep = @{ RecoverSentAt = $null; PendingSince = $null; ZeroTabsSince = $null; NoChromeSince = $null }
    $script:capturePending = @{ Active = $true; Since = $t0; Attempts = 0; LastAttempt = $min; AnsweredAt = $null; Unsupported = $false }
    for ($s = 0; $s -le $seconds; $s++) {
        $now = $t0.AddSeconds($s); $script:sim.Now = $now
        Step-Server $now
        if ($s % 15 -eq 0) { [void](Invoke-CaptureRecoveryStep $now 6>$null 3>$null) }
        if ($s % 60 -eq 0) { Step-BootCapturePage 5000 6>$null 3>$null }
    }
}

# 1. Disp-4 repro: clean Chrome restart at 7:32:46 left ONE live standby tab; app answers.
$script:sim = New-Sim @{}
Add-Tab $t0
Run-Boot 600
Check "existing tab + boot: boot check opens NO second page" $sim.Opens 0
Check "existing tab + boot: no Chrome restart" $sim.Restarts 0
Check "existing tab + boot: still exactly one tab" $sim.Tabs.Count 1
Check "existing tab + boot: boot handed off (not pending)" $capturePending.Active $false
Check "existing tab + boot: capture within 2 min ($(if ($sim.CaptureAt) { [int]($sim.CaptureAt - $t0).TotalSeconds } else { 'never' })s)" ($null -ne $sim.CaptureAt -and ($sim.CaptureAt - $t0).TotalSeconds -le 120) $true

# 2. Two standby tabs, no holder (what Disp-4 ended up with).
$script:sim = New-Sim @{}
Add-Tab $t0; Add-Tab $t0.AddSeconds(5)
Run-Boot 600
Check "2 standby tabs: no page opened" $sim.Opens 0
Check "2 standby tabs: exactly one capturing lock holder" (@($sim.Tabs | Where-Object { $_.Lock -eq "held" -and $_.Capturing }).Count) 1
Check "2 standby tabs: capture within 2 min ($(if ($sim.CaptureAt) { [int]($sim.CaptureAt - $t0).TotalSeconds } else { 'never' })s)" ($null -ne $sim.CaptureAt -and ($sim.CaptureAt - $t0).TotalSeconds -le 120) $true

# 3. Chrome launched 20 s ago, its tab not registered yet (0 live tabs): no launch/restart.
$script:sim = New-Sim @{ ChromeStarted = $t0.AddSeconds(-20) }
$script:sim.Tabs += @{ Id = "late"; SeenAt = $t0.AddSeconds(30); Lock = "standby"; Capturing = $false }
Run-Boot 300
Check "young Chrome + slow tab: no extra page, no restart" "$($sim.Opens)/$($sim.Restarts)" "0/0"
Check "young Chrome + slow tab: capture within 2 min" ($null -ne $sim.CaptureAt -and ($sim.CaptureAt - $t0).TotalSeconds -le 120) $true

# 4. Boot with Chrome not running: ONE tab launched (by recovery, not by the boot check), capture within 2 min.
$script:sim = New-Sim @{ Chrome = $false }
Run-Boot 300
Check "no Chrome at boot: exactly one launch" $sim.Opens 1
Check "no Chrome at boot: one tab" $sim.Tabs.Count 1
Check "no Chrome at boot: capture within 2 min ($(if ($sim.CaptureAt) { [int]($sim.CaptureAt - $t0).TotalSeconds } else { 'never' })s)" ($null -ne $sim.CaptureAt -and ($sim.CaptureAt - $t0).TotalSeconds -le 120) $true

# 5. Chrome running (old, not young) with 0 tabs at boot: clean single-tab restart, not an added tab.
$script:sim = New-Sim @{ ChromeStarted = $t0.AddMinutes(-30) }
Run-Boot 300
Check "Chrome w/o tabs at boot: clean restart, no added tab" "$($sim.Restarts)/$($sim.Opens)/$($sim.Tabs.Count)" "1/0/1"
Check "Chrome w/o tabs at boot: capture within 2 min" ($null -ne $sim.CaptureAt -and ($sim.CaptureAt - $t0).TotalSeconds -le 120) $true

# 6. Watchdog heartbeat line every 5 min.
$script:sim = New-Sim @{}; Add-Tab $t0
$script:lastWatchdogBeat = $min
$beats = 0; $lines = @()
for ($s = 0; $s -le 1200; $s += 15) { $sim.Now = $t0.AddSeconds($s); $o = Write-WatchdogBeat $sim.Now 6>&1; if ($o | Where-Object { $_ -eq $true }) { $beats++ }; $lines += @($o | Where-Object { $_ -isnot [bool] }) }
Check "heartbeat line every 5 min (20 min -> 5 lines incl. t0)" $beats 5
Check "heartbeat line shows capture state" ("$($lines[0].MessageData)" -match "\[watchdog\] alive: live tabs \d+, capturing-with-lock \d+, pending \d+, lease \S+, last chunk .+; Chrome running: True; boot pending: (True|False); last recover: .+; last Chrome restart") $true

Remove-Item $captureStateFile -ErrorAction SilentlyContinue
if ($script:failures) { Write-Host "$($script:failures) FAILURES"; exit 1 } else { Write-Host "all watchdog boot-race tests passed"; exit 0 }
