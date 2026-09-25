# Promote reviewed code from main to release. The fleet watchdog deploys ONLY
# origin/release, so this is the single step that puts code on the boxes
# (they pick it up on their next pull cycle, within 4h).
#
# Owner-only. Automated agents must never run this or push to release.
#   powershell -ExecutionPolicy Bypass -File scripts\promote-release.ps1
# Equivalent on any OS:  git fetch origin && git log origin/release..origin/main
#                        git push origin origin/main:refs/heads/release
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$env:GIT_TERMINAL_PROMPT = "0"

git -C $repo fetch origin main release
if ($LASTEXITCODE -ne 0) { throw "git fetch failed" }

$pending = git -C $repo log --oneline origin/release..origin/main
if (-not $pending) {
    Write-Host "release is already up to date with main. Nothing to promote." -ForegroundColor Green
    exit 0
}

Write-Host "These commits on main will go live on every fleet box:" -ForegroundColor Cyan
$pending | ForEach-Object { Write-Host "  $_" }
Write-Host ""
Write-Host "Files changed:" -ForegroundColor Cyan
git -C $repo diff --stat origin/release origin/main | ForEach-Object { Write-Host "  $_" }
Write-Host ""
$answer = Read-Host "Type PROMOTE to release these to the fleet"
if ($answer -ne "PROMOTE") {
    Write-Host "Cancelled. Nothing was pushed." -ForegroundColor Yellow
    exit 1
}

# Fast-forward only: git rejects the push if release has commits main lacks.
git -C $repo push origin origin/main:refs/heads/release
if ($LASTEXITCODE -ne 0) { throw "Push to release failed (not a fast-forward?). Nothing changed." }
Write-Host "Released. Boxes deploy it on their next watchdog pull cycle." -ForegroundColor Green
