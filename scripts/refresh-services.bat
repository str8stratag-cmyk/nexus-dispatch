@echo off
setlocal enabledelayedexpansion

set "repoRoot=%~dp0.."
cd /d "%repoRoot%"

echo Stopping any running dispatch services...
for /f "tokens=2,5" %%a in ('netstat -ano ^| findstr /R /C:"127\.0\.0\.1:8178.*LISTENING" /C:"0\.0\.0\.0:5000.*LISTENING"') do (
  echo Killing PID %%b on %%a
  taskkill /PID %%b /F >nul 2>&1
)

timeout /t 2 /nobreak >nul

echo Starting Whisper service...
powershell.exe -ExecutionPolicy Bypass -File "%repoRoot%\scripts\start-whisper-detached.ps1"

echo Starting app dev server...
powershell.exe -ExecutionPolicy Bypass -File "%repoRoot%\scripts\start-app-detached.ps1"

echo.
echo Waiting for services to start...
timeout /t 15 /nobreak >nul

echo.
curl -s http://127.0.0.1:8178/health
echo.
curl -s -o nul -w "App HTTP status: %%{http_code}\n" http://127.0.0.1:5000/

echo.
echo Refresh complete.
