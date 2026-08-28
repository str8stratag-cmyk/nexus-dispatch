[CmdletBinding()]
param(
  [string]$Command = "dev"
)

$ErrorActionPreference = "Stop"
$repoRoot = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { Get-Location }

$outLog = Join-Path $repoRoot "app-$Command-out.log"
$errLog = Join-Path $repoRoot "app-$Command-err.log"

$env:PORT = "5001"

Start-Process `
  -FilePath "cmd.exe" `
  -ArgumentList "/c", "npm", "run", $Command `
  -WorkingDirectory $repoRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog

Write-Host "App dev server started in background. Command: npm run $Command, Port: 5001"
Write-Host "Stdout log: $outLog"
Write-Host "Stderr log: $errLog"
Write-Host "Wait ~10s, then check http://127.0.0.1:5001"
