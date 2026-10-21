# Tests the watchdog's pure outage/recover functions (extracted from
# scripts/watchdog.ps1 via the PowerShell AST, so the real code is tested).
# Run: pwsh -NoProfile -File trial/test-watchdog-outage.ps1
$ErrorActionPreference = "Stop"
$path = Join-Path $PSScriptRoot "..\scripts\watchdog.ps1"
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw "watchdog.ps1 parse errors: $($errors.Count)" }
foreach ($name in @("Get-CaptureOutageDecision", "Test-RecoverAllowed")) {
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
$lim = 300000
function S($o) { [pscustomobject]$o }
$base = @{ uptimeMs = 600000; liveTabs = 1; lastChunkAgoMs = 5000; levelReportedAgoMs = $null; nonzeroLevelAgoMs = $null }
Check "DISP-5 repro: quiet radio + old bundle not an outage" (Get-CaptureOutageDecision (S $base) 1 $lim).Outage $false
$b = $base.Clone(); $b.levelReportedAgoMs = 30000; $b.nonzeroLevelAgoMs = 30000
Check "quiet radio with level not an outage" (Get-CaptureOutageDecision (S $b) 1 $lim).Outage $false
$b = $base.Clone(); $b.levelReportedAgoMs = 30000
Check "level reported but 0 = outage" (Get-CaptureOutageDecision (S $b) 1 $lim).Why "chunks flowing but level 0 (suspended audio)"
$b = $base.Clone(); $b.lastChunkAgoMs = 400000
Check "chunks stopped = outage" (Get-CaptureOutageDecision (S $b) 1 $lim).Why "chunks stopped"
$b = $base.Clone(); $b.lastChunkAgoMs = $null
Check "no chunk ever = outage" (Get-CaptureOutageDecision (S $b) 1 $lim).Outage $true
Check "operator stop not an outage" (Get-CaptureOutageDecision (S $b) 0 $lim).Outage $false
$b.uptimeMs = 60000
Check "just booted not an outage" (Get-CaptureOutageDecision (S $b) 1 $lim).Outage $false

$now = Get-Date
$cd = [TimeSpan]::FromMinutes(10)
$min = [DateTime]::MinValue
Check "gate allows normal" (Test-RecoverAllowed $now $min $min 1 $null @() $cd 3).Allow $true
Check "gate cooldown after restart" (Test-RecoverAllowed $now $now.AddMinutes(-3) $min 1 $null @() $cd 3).Why "cooldown after app restart"
Check "gate cooldown after pull" (Test-RecoverAllowed $now $min $now.AddMinutes(-9) 1 $null @() $cd 3).Why "cooldown after code pull"
Check "gate tabs growing" (Test-RecoverAllowed $now $min $min 58 12 @() $cd 3).Why "live tabs growing"
Check "gate steady 2 tabs" (Test-RecoverAllowed $now $min $min 2 2 @() $cd 3).Allow $true
Check "gate hourly cap" (Test-RecoverAllowed $now $min $min 1 $null @($now.AddMinutes(-50), $now.AddMinutes(-30), $now.AddMinutes(-5)) $cd 3).Why "hourly recover cap reached"
Check "gate old recovers age out" (Test-RecoverAllowed $now $min $min 1 $null @($now.AddHours(-3)) $cd 3).Allow $true

if ($script:failures) { Write-Host "$($script:failures) FAILURES"; exit 1 } else { Write-Host "all watchdog-outage tests passed"; exit 0 }
