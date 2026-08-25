# Reads .env and uploads each variable to the linked Vercel project.
# Run in PowerShell from the repo root:
#   .\scripts\sync-env-to-vercel.ps1
# Requires Vercel CLI and a linked project (`vercel link`).

$envPath = Join-Path $PSScriptRoot '..' '.env'

if (-not (Test-Path $envPath)) {
    Write-Error ".env not found at $envPath"
    exit 1
}

# Verify Vercel CLI is available
if (-not (Get-Command vercel -ErrorAction SilentlyContinue)) {
    Write-Error "Vercel CLI not found. Install it: npm i -g vercel"
    exit 1
}

$lines = Get-Content $envPath
$uploaded = 0
$skipped = 0

foreach ($line in $lines) {
    $trimmed = $line.Trim()

    # Skip comments and blank lines
    if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith('#')) {
        continue
    }

    # Parse KEY=VALUE
    $eq = $trimmed.IndexOf('=')
    if ($eq -lt 0) { continue }

    $key = $trimmed.Substring(0, $eq).Trim()
    $value = $trimmed.Substring($eq + 1).Trim()

    # Strip surrounding quotes if present
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
    }

    if ([string]::IsNullOrWhiteSpace($value)) {
        Write-Host "Skipping empty value: $key"
        $skipped++
        continue
    }

    Write-Host "Uploading $key ..."
    $value | vercel env add $key production --yes
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Failed to upload $key"
        $skipped++
    } else {
        $uploaded++
    }
}

Write-Host "Done. Uploaded: $uploaded, Skipped: $skipped" -ForegroundColor Green
Write-Host "Also set variables for Preview/Development in Vercel dashboard if needed."
