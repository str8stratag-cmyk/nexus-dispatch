# Start Whisper, dispatch-monitor, and nexus-dispatch locally
# Run from PowerShell: .\setup\start-all.ps1

$ErrorActionPreference = "SilentlyContinue"

function Start-AppInWindow($title, $directory, $command) {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    Start-Process powershell -ArgumentList "-NoExit", "-EncodedCommand", $encoded -WorkingDirectory $directory
    Write-Host "Started $title in new window" -ForegroundColor Green
}

# Kill anything already running
Write-Host "Stopping any existing dispatch/whisper processes..." -ForegroundColor Cyan
$stopScript = Join-Path $PSScriptRoot "stop-all.ps1"
& $stopScript

Start-Sleep -Seconds 2

$dispatchMonitor = Join-Path $env:USERPROFILE "dispatch-monitor"
$nexusDispatch = Join-Path $env:USERPROFILE "nexus-dispatch"

# Start Whisper
Start-AppInWindow "Whisper" $dispatchMonitor "npm run whisper:start"

# Wait for Whisper to be ready
Write-Host "Waiting for Whisper on port 8178..." -ForegroundColor Cyan
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $res = Invoke-WebRequest -Uri "http://127.0.0.1:8178" -Method POST -Body '{}' -TimeoutSec 2
        if ($res.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Start-Sleep -Seconds 1
}
if (-not $ready) {
    Write-Warning "Whisper did not respond in time; starting apps anyway..."
}

# Start dispatch-monitor on port 5000
Start-AppInWindow "Dispatch Monitor" $dispatchMonitor "npm run dev"

# Start nexus-dispatch on port 5001
Start-AppInWindow "Nexus Dispatch" $nexusDispatch "$env:PORT=5001; npm run dev"

Write-Host "All services starting. Close each PowerShell window to stop." -ForegroundColor Green
