# Review recent dispatch calls for nonsense / fine-tuning opportunities
# Run from PowerShell: .\scripts\review-calls.ps1

cd "C:\Users\str8s\dispatch-monitor"
node scripts\review-calls.mjs

Write-Host "Press any key to close..." -ForegroundColor Cyan
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
