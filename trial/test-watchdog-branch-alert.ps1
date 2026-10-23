# Branch-drift alert (2026-10-23): Pull-Repo used to silently skip a desk
# stuck on the wrong branch, so release updates never reached it and nobody
# was told. Tests the real watchdog functions (AST-extracted): the pure
# rate-limit decision, credential parsing, persisted alert state, and
# Pull-Repo's end-to-end behavior against a real git repo. Telegram sending
# itself is mocked (no network) -- only Get-TelegramCredentials' file
# parsing is exercised for real.
# Run: powershell -NoProfile -File trial/test-watchdog-branch-alert.ps1
$ErrorActionPreference = "Continue"
$path = Join-Path $PSScriptRoot "..\scripts\watchdog.ps1"
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw "watchdog.ps1 parse errors: $($errors.Count)" }
foreach ($name in @("Invoke-External", "Invoke-Git", "Invoke-NpmInstall", "Pull-Repo",
        "Get-TelegramCredentials", "Send-TelegramAlert", "Test-BranchAlertAllowed",
        "Read-BranchAlertState", "Save-BranchAlertState", "Send-BranchDriftAlert")) {
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

# ---------------- pure rate-limit decision ----------------
$now = Get-Date "2026-10-23T12:00:00"
$hour = [TimeSpan]::FromHours(1)
Check "never alerted -> allowed" (Test-BranchAlertAllowed $now ([DateTime]::MinValue) $hour) $true
Check "alerted 59 min ago -> not allowed" (Test-BranchAlertAllowed $now ($now.AddMinutes(-59)) $hour) $false
Check "alerted exactly 1h ago -> allowed" (Test-BranchAlertAllowed $now ($now.AddHours(-1)) $hour) $true
Check "alerted 2h ago -> allowed" (Test-BranchAlertAllowed $now ($now.AddHours(-2)) $hour) $true
Check "alerted 1 min ago -> not allowed" (Test-BranchAlertAllowed $now ($now.AddMinutes(-1)) $hour) $false

# ---------------- persisted state round-trip ----------------
$tmp = Join-Path ([IO.Path]::GetTempPath()) "wd-branch-alert-$PID"
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory $tmp | Out-Null
$stateFile = Join-Path $tmp "state.json"
$t1 = Get-Date "2026-10-23T08:00:00"
Save-BranchAlertState $stateFile @{ "C:\repoA" = $t1 }
$back = Read-BranchAlertState $stateFile
Check "round-trip: key present" ($back.ContainsKey("C:\repoA")) $true
Check "round-trip: timestamp preserved to the second" ($back["C:\repoA"].ToString("yyyy-MM-ddTHH:mm:ss")) ($t1.ToString("yyyy-MM-ddTHH:mm:ss"))
Check "missing file -> empty state, no throw" ((Read-BranchAlertState (Join-Path $tmp "nope.json")).Count) 0

# ---------------- Get-TelegramCredentials: file parsing ----------------
$credRepo = Join-Path $tmp "credrepo"
New-Item -ItemType Directory $credRepo | Out-Null
Set-Content -Path (Join-Path $credRepo ".env") -Value @(
    "# comment line, ignored"
    "MONGODB_URI=mongodb://127.0.0.1:27017"
    "TELEGRAM_BOT_TOKEN=123:ABC-fake-token-not-real"
    'TELEGRAM_CHAT_ID="-100999"'
) -Encoding UTF8
$oldBot = $env:TELEGRAM_BOT_TOKEN; $oldChat = $env:TELEGRAM_CHAT_ID
$env:TELEGRAM_BOT_TOKEN = $null; $env:TELEGRAM_CHAT_ID = $null
$creds = Get-TelegramCredentials $credRepo
Check "creds parsed from .env: bot token" $creds.BotToken "123:ABC-fake-token-not-real"
Check "creds parsed from .env: chat id (quotes stripped)" $creds.ChatId "-100999"
$emptyRepo = Join-Path $tmp "norepo"
New-Item -ItemType Directory $emptyRepo | Out-Null
$noCreds = Get-TelegramCredentials $emptyRepo
Check "no .env, no env vars -> both null" ($null -eq $noCreds.BotToken -and $null -eq $noCreds.ChatId) $true
$env:TELEGRAM_BOT_TOKEN = $oldBot; $env:TELEGRAM_CHAT_ID = $oldChat

# ---------------- Send-TelegramAlert: missing creds never throws, never sends ----------------
$warn = Send-TelegramAlert $emptyRepo "test message" 3>&1 6>$null
Check "missing creds: returns false" ($warn | Where-Object { $_ -isnot [System.Management.Automation.WarningRecord] }) $false

# ---------------- Send-BranchDriftAlert: end-to-end rate limiting (Telegram mocked) ----------------
$script:tgCalls = New-Object System.Collections.ArrayList
function Send-TelegramAlert($repoPath, [string]$text) { [void]$script:tgCalls.Add(@{ Repo = $repoPath; Text = $text }); return $true }

$script:branchAlertStateFile = Join-Path $tmp "branch-alert-state.json"
$script:branchAlertCooldown = [TimeSpan]::FromHours(1)
$script:dispatchMonitor = $credRepo
if (Test-Path $script:branchAlertStateFile) { Remove-Item $script:branchAlertStateFile }

$t0 = Get-Date "2026-10-23T10:00:00"
$r1 = Send-BranchDriftAlert "C:\desk1" "feature" "release" $t0
Check "first drift: alert sent" $r1 $true
Check "first drift: Telegram called once" $script:tgCalls.Count 1
Check "first drift: message names actual + expected branch" ($script:tgCalls[0].Text -match "feature" -and $script:tgCalls[0].Text -match "release") $true

$r2 = Send-BranchDriftAlert "C:\desk1" "feature" "release" ($t0.AddMinutes(30))
Check "30 min later: suppressed (rate limit)" $r2 $false
Check "30 min later: Telegram still called once" $script:tgCalls.Count 1

$r3 = Send-BranchDriftAlert "C:\desk1" "feature" "release" ($t0.AddHours(1).AddSeconds(1))
Check "after cooldown: alert sent again" $r3 $true
Check "after cooldown: Telegram called twice" $script:tgCalls.Count 2

# A different path rate-limits independently of desk1.
$r4 = Send-BranchDriftAlert "C:\desk2" "main" "release" ($t0.AddMinutes(1))
Check "different repo path: not suppressed by desk1's cooldown" $r4 $true
Check "different repo path: Telegram called a third time" $script:tgCalls.Count 3

# No state file configured (e.g. Pull-Repo exercised outside the full script): safe no-op.
$script:branchAlertStateFile = $null
$r5 = Send-BranchDriftAlert "C:\desk3" "main" "release" $t0
Check "no state file configured: no-op, returns false" $r5 $false
Check "no state file configured: Telegram not called" $script:tgCalls.Count 3

# ---------------- Pull-Repo end-to-end: branch mismatch triggers the alert ----------------
$gitTimeoutSec = 10; $gitPullTimeoutSec = 10; $npmTimeoutSec = 10
$gitTmp = Join-Path $tmp "git"
New-Item -ItemType Directory $gitTmp | Out-Null
$origin = Join-Path $gitTmp "origin.git"
git init -q --bare -b release $origin
# Seed origin via push from an independent repo -- never clone it while empty
# (cloning a truly empty repo prints a warning that some PowerShell hosts
# treat as a terminating native-command error).
$seed = Join-Path $gitTmp "seed"
git init -q -b release $seed
git -C $seed -c user.email=t@t -c user.name=t commit -q --allow-empty -m seed
git -C $seed push -q $origin HEAD:release 2>$null
$desk = Join-Path $gitTmp "desk"
git clone -q $origin $desk 2>$null
git -C $desk checkout -q -b feature

$script:tgCalls.Clear()
$script:branchAlertStateFile = Join-Path $tmp "pull-repo-state.json"
$script:branchAlertCooldown = [TimeSpan]::FromHours(1)
$script:dispatchMonitor = $credRepo

$out = Pull-Repo $desk "release" 6>&1 3>&1 | Out-String
Check "branch mismatch: Pull-Repo returns false" (Pull-Repo $desk "release" 6>$null 3>$null) $false
Check "branch mismatch: loud warning logged" ($out -match "BRANCH DRIFT") $true
Check "branch mismatch: alert fired via Pull-Repo" $script:tgCalls.Count 1
Check "branch mismatch: alert text names this desk's path" ($script:tgCalls[0].Text -match [regex]::Escape($desk)) $true
Check "branch mismatch: creds read from dispatchMonitor, not the drifted desk" ($script:tgCalls[0].Repo -eq $credRepo) $true

[void](Pull-Repo $desk "release" 6>$null 3>$null)
Check "branch mismatch repeated immediately: rate-limited, no second alert" $script:tgCalls.Count 1

# Backdate the persisted alert so the next Pull-Repo call is outside the cooldown.
$state = Read-BranchAlertState $script:branchAlertStateFile
$state[$desk] = (Get-Date).AddHours(-2)
Save-BranchAlertState $script:branchAlertStateFile $state
[void](Pull-Repo $desk "release" 6>$null 3>$null)
Check "branch mismatch after cooldown elapses: alerts again" $script:tgCalls.Count 2

Remove-Item -Recurse -Force $gitTmp -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
if ($script:failures) { Write-Host "$($script:failures) FAILURES"; exit 1 } else { Write-Host "all watchdog branch-alert tests passed"; exit 0 }
