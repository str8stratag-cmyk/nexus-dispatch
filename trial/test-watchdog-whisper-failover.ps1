# Whisper GPU failover (2026-10-23): a desk can point at a remote Whisper
# (e.g. the GPU box) instead of running one locally; the watchdog must not
# manage local Whisper while the remote is healthy, must fail over to local
# after a sustained remote outage, and must fail back once the remote has
# been healthy again for a while, without flapping. Tests the real watchdog
# functions (AST-extracted): config/URL resolution, the pure failover
# decision, state persistence, and Invoke-WhisperFailoverStep end-to-end with
# Test-RemoteWhisperAlive/Start-Whisper/Stop-LocalWhisper/Send-TelegramAlert
# mocked (no network, no real processes started/killed).
# Run: powershell -NoProfile -File trial/test-watchdog-whisper-failover.ps1
$ErrorActionPreference = "Continue"
$path = Join-Path $PSScriptRoot "..\scripts\watchdog.ps1"
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw "watchdog.ps1 parse errors: $($errors.Count)" }
foreach ($name in @("Get-ConfiguredWhisperUrl", "Test-WhisperUrlLocal", "Get-WhisperFailoverStep",
        "Read-WhisperRuntimeState", "Save-WhisperRuntimeState", "Invoke-WhisperFailoverStep")) {
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

# ---------------- Test-WhisperUrlLocal ----------------
Check "127.0.0.1 is local" (Test-WhisperUrlLocal "http://127.0.0.1:8178") $true
Check "localhost is local" (Test-WhisperUrlLocal "http://localhost:8178") $true
Check "::1 is local" (Test-WhisperUrlLocal "http://[::1]:8178") $true
Check "LAN IP is remote" (Test-WhisperUrlLocal "http://192.168.6.103:8178") $false
Check "hostname is remote" (Test-WhisperUrlLocal "http://whisp-1.local:8178") $false
Check "malformed URL treated as local (never silently 'remote')" (Test-WhisperUrlLocal "not a url") $true

# ---------------- Get-ConfiguredWhisperUrl: precedence + .env parsing ----------------
$tmp = Join-Path ([IO.Path]::GetTempPath()) "wd-whisper-failover-$PID"
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory $tmp | Out-Null
$oldRemote = $env:WHISPER_REMOTE_URL; $oldVite = $env:VITE_WHISPER_SERVICE_URL
$env:WHISPER_REMOTE_URL = $null; $env:VITE_WHISPER_SERVICE_URL = $null

$noEnvRepo = Join-Path $tmp "norepo"
New-Item -ItemType Directory $noEnvRepo | Out-Null
Check "no .env, no env vars -> local default" (Get-ConfiguredWhisperUrl $noEnvRepo) "http://127.0.0.1:8178"

$viteOnlyRepo = Join-Path $tmp "viteonly"
New-Item -ItemType Directory $viteOnlyRepo | Out-Null
Set-Content -Path (Join-Path $viteOnlyRepo ".env") -Value @('VITE_WHISPER_SERVICE_URL=http://192.168.6.103:8178') -Encoding UTF8
Check "VITE_WHISPER_SERVICE_URL only -> used" (Get-ConfiguredWhisperUrl $viteOnlyRepo) "http://192.168.6.103:8178"

$bothRepo = Join-Path $tmp "both"
New-Item -ItemType Directory $bothRepo | Out-Null
Set-Content -Path (Join-Path $bothRepo ".env") -Value @(
    "WHISPER_REMOTE_URL=http://192.168.6.103:8178"
    "VITE_WHISPER_SERVICE_URL=http://127.0.0.1:8178"
) -Encoding UTF8
Check "WHISPER_REMOTE_URL takes precedence over VITE_WHISPER_SERVICE_URL" (Get-ConfiguredWhisperUrl $bothRepo) "http://192.168.6.103:8178"

$env:WHISPER_REMOTE_URL = $oldRemote; $env:VITE_WHISPER_SERVICE_URL = $oldVite

# ---------------- Get-WhisperFailoverStep: pure decision ----------------
$failoverAfter = [TimeSpan]::FromSeconds(60)
$failbackAfter = [TimeSpan]::FromMinutes(3)
$minDwell = [TimeSpan]::FromSeconds(30)
$t0 = Get-Date "2026-10-23T12:00:00"

# Remote mode, healthy: no-op, streak cleared.
$r = Get-WhisperFailoverStep @{ Now = $t0; Mode = "remote"; RemoteOk = $true; RemoteFailSince = $t0.AddSeconds(-10); RemoteHealthySince = $null; LastSwitch = [DateTime]::MinValue; FailoverAfter = $failoverAfter; FailbackAfter = $failbackAfter; MinDwell = $minDwell }
Check "remote healthy: action" $r.Action "healthy"
Check "remote healthy: fail-since cleared" $r.RemoteFailSince $null

# Remote mode, just started failing: wait, not yet 60s.
$r = Get-WhisperFailoverStep @{ Now = $t0; Mode = "remote"; RemoteOk = $false; RemoteFailSince = $null; RemoteHealthySince = $null; LastSwitch = [DateTime]::MinValue; FailoverAfter = $failoverAfter; FailbackAfter = $failbackAfter; MinDwell = $minDwell }
Check "remote first failure: action" $r.Action "wait-fail"
Check "remote first failure: fail-since stamped to now" $r.RemoteFailSince $t0

# Remote mode, failing for 29s: still waiting.
$r = Get-WhisperFailoverStep @{ Now = $t0.AddSeconds(59); Mode = "remote"; RemoteOk = $false; RemoteFailSince = $t0; RemoteHealthySince = $null; LastSwitch = [DateTime]::MinValue; FailoverAfter = $failoverAfter; FailbackAfter = $failbackAfter; MinDwell = $minDwell }
Check "remote failing 29s: action" $r.Action "wait-fail"

# Remote mode, failing for exactly 60s: fails over.
$r = Get-WhisperFailoverStep @{ Now = $t0.AddSeconds(60); Mode = "remote"; RemoteOk = $false; RemoteFailSince = $t0; RemoteHealthySince = $null; LastSwitch = [DateTime]::MinValue; FailoverAfter = $failoverAfter; FailbackAfter = $failbackAfter; MinDwell = $minDwell }
Check "remote failing 60s: action" $r.Action "failover-to-local"

# Local mode, remote still down: no-op.
$r = Get-WhisperFailoverStep @{ Now = $t0; Mode = "local"; RemoteOk = $false; RemoteFailSince = $null; RemoteHealthySince = $t0.AddSeconds(-10); LastSwitch = $t0.AddMinutes(-5); FailoverAfter = $failoverAfter; FailbackAfter = $failbackAfter; MinDwell = $minDwell }
Check "local, remote still down: action" $r.Action "unhealthy"
Check "local, remote still down: healthy-since cleared" $r.RemoteHealthySince $null

# Local mode, remote just became healthy, but within min dwell of switching to local: dwell.
$r = Get-WhisperFailoverStep @{ Now = $t0; Mode = "local"; RemoteOk = $true; RemoteFailSince = $null; RemoteHealthySince = $null; LastSwitch = $t0.AddSeconds(-10); FailoverAfter = $failoverAfter; FailbackAfter = $failbackAfter; MinDwell = $minDwell }
Check "local, within min dwell: action" $r.Action "dwell"

# Local mode, past min dwell, remote healthy for under 3 min: wait.
$r = Get-WhisperFailoverStep @{ Now = $t0; Mode = "local"; RemoteOk = $true; RemoteFailSince = $null; RemoteHealthySince = $null; LastSwitch = $t0.AddMinutes(-5); FailoverAfter = $failoverAfter; FailbackAfter = $failbackAfter; MinDwell = $minDwell }
Check "local, first healthy tick past dwell: action" $r.Action "wait-healthy"
Check "local, first healthy tick: healthy-since stamped to now" $r.RemoteHealthySince $t0

# Local mode, remote healthy for 2:59: still waiting.
$r = Get-WhisperFailoverStep @{ Now = $t0.AddMinutes(2).AddSeconds(59); Mode = "local"; RemoteOk = $true; RemoteFailSince = $null; RemoteHealthySince = $t0; LastSwitch = $t0.AddHours(-1); FailoverAfter = $failoverAfter; FailbackAfter = $failbackAfter; MinDwell = $minDwell }
Check "local, remote healthy 2:59: action" $r.Action "wait-healthy"

# Local mode, remote healthy for exactly 3 min: fails back.
$r = Get-WhisperFailoverStep @{ Now = $t0.AddMinutes(3); Mode = "local"; RemoteOk = $true; RemoteFailSince = $null; RemoteHealthySince = $t0; LastSwitch = $t0.AddHours(-1); FailoverAfter = $failoverAfter; FailbackAfter = $failbackAfter; MinDwell = $minDwell }
Check "local, remote healthy 3min: action" $r.Action "failback-to-remote"

# Flapping remote while in local mode: each isolated blip resets the
# healthy-since clock back to null via the "unhealthy" branch, so a remote
# that flickers never accumulates toward the 3-min failback threshold.
$r1 = Get-WhisperFailoverStep @{ Now = $t0; Mode = "local"; RemoteOk = $true; RemoteFailSince = $null; RemoteHealthySince = $null; LastSwitch = $t0.AddMinutes(-5); FailoverAfter = $failoverAfter; FailbackAfter = $failbackAfter; MinDwell = $minDwell }
$r2 = Get-WhisperFailoverStep @{ Now = $t0.AddMinutes(2); Mode = "local"; RemoteOk = $false; RemoteFailSince = $null; RemoteHealthySince = $r1.RemoteHealthySince; LastSwitch = $t0.AddMinutes(-5); FailoverAfter = $failoverAfter; FailbackAfter = $failbackAfter; MinDwell = $minDwell }
Check "flapping remote: a blip clears healthy-since (no accumulation)" $r2.RemoteHealthySince $null
Check "flapping remote: action after blip" $r2.Action "unhealthy"

# ---------------- Read/Save-WhisperRuntimeState round-trip ----------------
$stateFile = Join-Path $tmp "whisper-state.json"
$switchAt = Get-Date "2026-10-23T09:30:00"
Save-WhisperRuntimeState $stateFile "local" "http://192.168.6.103:8178" "http://127.0.0.1:8178" $switchAt ($switchAt.AddSeconds(-5)) $null
$back = Read-WhisperRuntimeState $stateFile
Check "round-trip: mode" $back.Mode "local"
Check "round-trip: last switch preserved to the second" ($back.LastSwitch.ToString("yyyy-MM-ddTHH:mm:ss")) ($switchAt.ToString("yyyy-MM-ddTHH:mm:ss"))
Check "round-trip: remote-fail-since preserved" ($back.RemoteFailSince.ToString("yyyy-MM-ddTHH:mm:ss")) ($switchAt.AddSeconds(-5).ToString("yyyy-MM-ddTHH:mm:ss"))
Check "round-trip: remote-healthy-since null" $back.RemoteHealthySince $null
$missing = Read-WhisperRuntimeState (Join-Path $tmp "nope.json")
Check "missing file -> defaults to remote mode, no throw" $missing.Mode "remote"

# File written is also valid JSON the Node proxy can read (sanity check the
# field names server/whisper-failover.ts actually looks for).
$raw = Get-Content $stateFile -Raw | ConvertFrom-Json
Check "written file has 'mode'" $raw.mode "local"
Check "written file has 'remoteUrl'" $raw.remoteUrl "http://192.168.6.103:8178"
Check "written file has 'localUrl'" $raw.localUrl "http://127.0.0.1:8178"

# ---------------- Invoke-WhisperFailoverStep: end-to-end (network/process mocked) ----------------
$script:tgCalls = New-Object System.Collections.ArrayList
function Send-TelegramAlert($repoPath, [string]$text) { [void]$script:tgCalls.Add(@{ Repo = $repoPath; Text = $text }); return $true }
$script:starts = 0
function Start-Whisper() { $script:starts++ }
$script:stops = 0
function Stop-LocalWhisper() { $script:stops++ }
$script:remoteAlive = $true
function Test-RemoteWhisperAlive($url) { return $script:remoteAlive }

$script:dispatchMonitor = $tmp
$script:whisperFailoverStateFile = Join-Path $tmp "e2e-state.json"
$script:remoteWhisperUrl = "http://192.168.6.103:8178"
$script:localWhisperUrl = "http://127.0.0.1:8178"
$script:whisperFailoverCheckInterval = [TimeSpan]::FromSeconds(12)
$script:whisperFailoverToLocalAfter = $failoverAfter
$script:whisperFailoverToRemoteAfter = $failbackAfter
$script:whisperFailoverMinDwell = $minDwell
$script:whisperFailoverEnabled = $true
$script:whisperFailoverMode = "remote"
$script:whisperRemoteFailSince = $null
$script:whisperRemoteHealthySince = $null
$script:whisperFailoverLastSwitch = [DateTime]::MinValue
$script:lastWhisperFailoverCheck = [DateTime]::MinValue
$script:lastWhisperRestart = [DateTime]::MinValue
$script:whisperFailStreak = 7   # should be reset to 0 on failback

$tStart = Get-Date "2026-10-23T14:00:00"
Invoke-WhisperFailoverStep $tStart
Check "disabled check-interval gate: first call always runs (MinValue)" $script:lastWhisperFailoverCheck $tStart
Check "remote healthy at start: mode stays remote" $script:whisperFailoverMode "remote"
Check "remote healthy at start: Whisper not started" $script:starts 0

# Too soon for the next check (interval gate): a call 1s later is a no-op even
# though remote just went down.
$script:remoteAlive = $false
Invoke-WhisperFailoverStep ($tStart.AddSeconds(1))
Check "check-interval gate: no-op within 12s of last check" $script:whisperRemoteFailSince $null

# Advance past the check interval repeatedly until the 60s failover threshold trips.
$t = $tStart
for ($i = 0; $i -lt 6; $i++) {
    $t = $t.AddSeconds(12)
    Invoke-WhisperFailoverStep $t
}
Check "remote down >=60s across ticks: failed over to local" $script:whisperFailoverMode "local"
Check "failover: Start-Whisper called exactly once" $script:starts 1
Check "failover: Telegram alert sent" $script:tgCalls.Count 1
Check "failover: alert mentions FAILOVER" ($script:tgCalls[0].Text -match "FAILOVER") $true
Check "failover: alert sent against dispatchMonitor repo (for creds)" ($script:tgCalls[0].Repo -eq $tmp) $true
$afterFailoverState = Read-WhisperRuntimeState $script:whisperFailoverStateFile
Check "failover: runtime state file mode=local" $afterFailoverState.Mode "local"

# Remote recovers, but min dwell (30s since switch) blocks an immediate failback.
# (+15s: past the 12s check-interval gate so this tick actually runs, but
# still inside the 30s min-dwell window.)
$script:remoteAlive = $true
$switchTime = $script:whisperFailoverLastSwitch
Invoke-WhisperFailoverStep ($switchTime.AddSeconds(15))
Check "remote back up but within min dwell: still local" $script:whisperFailoverMode "local"
Check "min dwell: Stop-LocalWhisper not called yet" $script:stops 0

# Advance past min dwell; remote must stay healthy for 3 full minutes.
$t = $switchTime.AddSeconds(35)
Invoke-WhisperFailoverStep $t
Check "past min dwell, remote just confirmed healthy: still local (healthy-since just started)" $script:whisperFailoverMode "local"
$t2 = $t.AddMinutes(3).AddSeconds(1)
Invoke-WhisperFailoverStep $t2
Check "remote healthy 3min after dwell: failed back to remote" $script:whisperFailoverMode "remote"
Check "failback: Stop-LocalWhisper called exactly once" $script:stops 1
Check "failback: fail streak reset" $script:whisperFailStreak 0
Check "failback: Telegram alert sent (2nd call)" $script:tgCalls.Count 2
Check "failback: alert mentions FAILBACK" ($script:tgCalls[1].Text -match "FAILBACK") $true
$afterFailbackState = Read-WhisperRuntimeState $script:whisperFailoverStateFile
Check "failback: runtime state file mode=remote" $afterFailbackState.Mode "remote"

# Disabled entirely (locally configured desk): no-op regardless of inputs.
$script:whisperFailoverEnabled = $false
$script:starts = 0; $script:stops = 0; $script:tgCalls.Clear()
Invoke-WhisperFailoverStep ($t2.AddHours(1))
Check "failover disabled: never starts Whisper" $script:starts 0
Check "failover disabled: never stops Whisper" $script:stops 0
Check "failover disabled: never alerts" $script:tgCalls.Count 0

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
if ($script:failures) { Write-Host "$($script:failures) FAILURES"; exit 1 } else { Write-Host "all watchdog whisper-failover tests passed"; exit 0 }
