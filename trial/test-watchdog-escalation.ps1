# Watchdog recover/escalation loop with mocked server + process calls (2026-10-21).
# Extracts the REAL functions from scripts/watchdog.ps1 via the AST.
# Run: pwsh -NoProfile -File trial/test-watchdog-escalation.ps1
$ErrorActionPreference = "Stop"
$path = Join-Path $PSScriptRoot "..\scripts\watchdog.ps1"
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw "watchdog.ps1 parse errors: $($errors.Count)" }
foreach ($name in @("Get-CaptureRecoveryStep", "Invoke-CaptureRecoveryStep", "Test-RecoverAllowed", "Restart-CaptureBrowser", "Read-CaptureState", "Save-CaptureState")) {
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

# ---- pure step ----
$t0 = Get-Date "2026-10-21T15:53:00"
$min = [DateTime]::MinValue
function St($o) {
    $b = @{ Now = $t0; Outage = $true; PendingTabs = 0; LockHeldCapturing = 0; RecoverSentAt = $null; PendingSince = $null; LastRecover = $min; LastRelaunch = $min
        RecoverGap = [TimeSpan]::FromMinutes(30); RelaunchGap = [TimeSpan]::FromMinutes(30); VerifyWindow = [TimeSpan]::FromSeconds(90); PendingEscalateAfter = [TimeSpan]::FromMinutes(5) }
    foreach ($k in $o.Keys) { $b[$k] = $o[$k] }
    return (Get-CaptureRecoveryStep $b).Action
}
Check "healthy -> none" (St @{ Outage = $false }) "none"
Check "outage -> recover" (St @{}) "recover"
Check "NO reload while a tab is pending" (St @{ PendingTabs = 1; PendingSince = $t0.AddSeconds(-30) }) "skip-pending"
Check "pending 5+ min -> escalate" (St @{ PendingTabs = 3; PendingSince = $t0.AddMinutes(-6) }) "escalate"
Check "pending 5+ min but Chrome restarted 10 min ago -> no restart" (St @{ PendingTabs = 3; PendingSince = $t0.AddMinutes(-6); LastRelaunch = $t0.AddMinutes(-10) }) "escalate-cooldown"
Check "recover cooldown 30 min" (St @{ LastRecover = $t0.AddMinutes(-29) }) "recover-cooldown"
Check "recover allowed after 30 min" (St @{ LastRecover = $t0.AddMinutes(-31) }) "recover"
Check "after recover: waiting inside 90 s" (St @{ RecoverSentAt = $t0.AddSeconds(-60) }) "verify-wait"
Check "after recover: lock holder capturing -> verified" (St @{ RecoverSentAt = $t0.AddSeconds(-60); LockHeldCapturing = 1 }) "verified"
Check "after recover: 90 s, nobody capturing -> escalate" (St @{ RecoverSentAt = $t0.AddSeconds(-91) }) "escalate"
Check "escalate at most once per 30 min" (St @{ RecoverSentAt = $t0.AddSeconds(-91); LastRelaunch = $t0.AddMinutes(-20) }) "escalate-cooldown"

# ---- loop simulation with mocks ----
$recoverMinGap = [TimeSpan]::FromMinutes(30); $relaunchMinGap = [TimeSpan]::FromMinutes(30)
$recoverVerifyWindow = [TimeSpan]::FromSeconds(90); $pendingEscalateAfter = [TimeSpan]::FromMinutes(5)
$recoverCooldown = [TimeSpan]::FromMinutes(10); $maxRecoversPerHour = 3
$recentRecovers = New-Object System.Collections.ArrayList
$lastAppRestart = @{ "Dispatch Monitor" = $min }; $lastCodeUpdate = $min; $prevLiveTabs = $null
$captureRelaunchChrome = $true; $captureUrl = "http://localhost:5000"
$captureStateFile = Join-Path ([IO.Path]::GetTempPath()) "wd-capture-state-$PID.json"
if (Test-Path $captureStateFile) { Remove-Item $captureStateFile }

$sim = @{ Outage = $true; Pending = 0; LockHeld = 0; ServerLastAccepted = $min; Recovers = 0; Restarts = 0; Refused = 0 }
function Get-CaptureOutage($port) { if ($sim.Outage) { return @{ Reason = "chunks stopped"; LiveTabs = 1 } } else { return $null } }
function Get-CaptureStatusRaw($port) { [pscustomobject]@{ pendingTabs = $sim.Pending; lockHeldCapturingTabs = $sim.LockHeld } }
function Request-CaptureRecover($port) {
    # Simulated server: 30-min persisted gap, refuses while pending.
    if (($script:simNow - $sim.ServerLastAccepted) -lt [TimeSpan]::FromMinutes(30)) { $sim.Refused++; return @{ Accepted = $false; Reason = "cooldown" } }
    if ($sim.Pending -gt 0) { $sim.Refused++; return @{ Accepted = $false; Reason = "tab-pending" } }
    $sim.ServerLastAccepted = $script:simNow; $sim.Recovers++
    # The reloaded tab comes back stuck at lock=pending (the DISP-5 failure).
    $sim.Pending = 1
    return @{ Accepted = $true; Target = "T0" }
}
function Reset-Sim() {
    $script:lastCaptureRecover = $min; $script:lastCaptureRelaunch = $min; $script:lastCaptureReopen = $min
    $script:captureStep = @{ RecoverSentAt = $null; PendingSince = $null }
    $sim.Outage = $true; $sim.Pending = 0; $sim.LockHeld = 0; $sim.ServerLastAccepted = $min; $sim.Recovers = 0; $sim.Restarts = 0; $sim.Refused = 0
    $recentRecovers.Clear()
}

$script:notified = 0
function Send-BrowserRestarted($port) { $script:notified++ }
# Process mocks for the real Restart-CaptureBrowser.
$script:procCalls = New-Object System.Collections.ArrayList
$script:chromeRunning = $true
function Get-Process { param($Name, $ErrorAction) if ($script:chromeRunning) { return @([pscustomobject]@{ Name = "chrome"; Id = 1 }, [pscustomobject]@{ Name = "chrome"; Id = 2 }) } }
function Stop-Process { param([Parameter(ValueFromPipeline = $true)]$InputObject, [switch]$Force) process { [void]$script:procCalls.Add("Stop-Process $($InputObject.Id) force=$Force"); $script:chromeRunning = $false } }
function Start-Sleep { param($Seconds) }
function Start-Browser($url) { [void]$script:procCalls.Add("Start-Browser $url") }

# Real Restart-CaptureBrowser against mocks: kill all chrome, relaunch ONE tab.
Restart-CaptureBrowser "http://localhost:5000" *> $null
Check "restart tells the server (browser-restarted) between kill and relaunch" $script:notified 1
Check "restart kills every chrome process (force)" ($script:procCalls -join "|") "Stop-Process 1 force=True|Stop-Process 2 force=True|Start-Browser http://localhost:5000"

# Count restarts via a wrapper mock from here on.
function Restart-CaptureBrowser($url) { $sim.Restarts++; $sim.Pending = 0; $sim.LockHeld = $script:restartHeals }

# Scenario A: DISP-5 repeated outage for 3 hours, recover leaves a pending tab,
# Chrome restart does NOT heal (worst case). Loop every 30 s.
Reset-Sim; $script:restartHeals = 0
$start = $t0
for ($i = 0; $i -lt 360; $i++) {
    $script:simNow = $start.AddSeconds(30 * $i)
    if ($sim.Restarts -gt 0 -and $sim.Pending -eq 0 -and $script:restartHeals -eq 0) { $sim.Pending = 1 }  # restart leaves a pending tab too
    [void](Invoke-CaptureRecoveryStep $script:simNow *>&1 | Out-Null)
}
Check "no storm: <= 1 recover per 30 min over 3 h (got $($sim.Recovers))" ($sim.Recovers -le 6) $true
Check "no storm: <= 1 Chrome restart per 30 min over 3 h (got $($sim.Restarts))" ($sim.Restarts -le 6 -and $sim.Restarts -ge 1) $true

# Scenario B: one recover, 90 s later still nothing -> exactly one Chrome restart which heals.
Reset-Sim; $script:restartHeals = 1
$steps = @()
for ($i = 0; $i -lt 20; $i++) {
    $script:simNow = $t0.AddSeconds(30 * $i)
    $r = Invoke-CaptureRecoveryStep $script:simNow 6>$null
    $steps += $r.Action
    if ($sim.LockHeld -gt 0) { $sim.Outage = $false }
}
Check "B: first action is recover" $steps[0] "recover"
Check "B: no reload while the new tab is pending (one recover only)" $sim.Recovers 1
Check "B: escalates after 90 s" ($steps[0..4] -join ",") "recover,verify-wait,verify-wait,escalate,none"
Check "B: exactly one Chrome restart" $sim.Restarts 1
$persisted = Read-CaptureState $captureStateFile
Check "B: recover + restart times persisted" ($persisted.LastRecover -eq $t0 -and $persisted.LastRelaunch -eq $t0.AddSeconds(90)) $true

# Scenario C: a tab is pending before any recover -> never reload, escalate after 5 min, once.
Reset-Sim; $script:restartHeals = 0; $sim.Pending = 2
for ($i = 0; $i -lt 40; $i++) { $script:simNow = $t0.AddSeconds(30 * $i); if ($sim.Restarts) { $sim.Pending = 2 }; [void](Invoke-CaptureRecoveryStep $script:simNow 6>$null) }
Check "C: zero recovers while pending" $sim.Recovers 0
Check "C: one Chrome restart in 20 min" $sim.Restarts 1

Remove-Item $captureStateFile -ErrorAction SilentlyContinue
if ($script:failures) { Write-Host "$($script:failures) FAILURES"; exit 1 } else { Write-Host "all watchdog-escalation tests passed"; exit 0 }
