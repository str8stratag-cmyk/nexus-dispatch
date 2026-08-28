# Review recent dispatch calls for nonsense / fine-tuning opportunities
# Run from PowerShell: .\scripts\review-calls.ps1

$repoRoot = Join-Path $env:USERPROFILE "dispatch-monitor"
if (-not (Test-Path $repoRoot)) {
    Write-Host "dispatch-monitor repo not found at $repoRoot" -ForegroundColor Red
    exit 1
}

Set-Location $repoRoot
npx tsx scripts\review-calls.mjs

Write-Host "Press any key to close..." -ForegroundColor Cyan
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
