# Stop Whisper, dispatch-monitor, and nexus-dispatch
# Run from PowerShell: .\setup\stop-all.ps1

$ErrorActionPreference = "SilentlyContinue"

function Stop-ProcessOnPort($port) {
    $pids = netstat -ano | Select-String ":$port\s+.*LISTENING" | ForEach-Object {
        ($_ -split '\s+')[-1]
    } | Select-Object -Unique
    foreach ($pid in $pids) {
        if ($pid -and $pid -ne '0') {
            taskkill /PID $pid /F | Out-Null
            Write-Host "Stopped process $pid on port $port" -ForegroundColor Yellow
        }
    }
}

Write-Host "Stopping Whisper (8178)..." -ForegroundColor Cyan
Stop-ProcessOnPort 8178

Write-Host "Stopping dispatch-monitor (5000)..." -ForegroundColor Cyan
Stop-ProcessOnPort 5000

Write-Host "Stopping nexus-dispatch (5001)..." -ForegroundColor Cyan
Stop-ProcessOnPort 5001

Write-Host "Done." -ForegroundColor Green
