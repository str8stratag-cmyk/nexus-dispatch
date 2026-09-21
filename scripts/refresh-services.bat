@echo off
setlocal enabledelayedexpansion

set "repoRoot=%~dp0.."
cd /d "%repoRoot%"

echo Stopping any running dispatch services...
for /f "tokens=2,5" %%a in ('netstat -ano ^| findstr /R /C:":8178.*LISTENING" /C:":5000.*LISTENING" /C:":5001.*LISTENING"') do (
  echo Killing PID %%b on %%a
  taskkill /PID %%b /F >nul 2>&1
)

powershell.exe -Command "Start-Sleep -Seconds 2" >nul 2>&1

echo Starting Whisper service...
powershell.exe -ExecutionPolicy Bypass -File "%repoRoot%\scripts\start-whisper-detached.ps1"

echo Starting app dev server...
powershell.exe -ExecutionPolicy Bypass -File "%repoRoot%\scripts\start-app-detached.ps1"

REM Nexus Dispatch retired from runtime on DISP-2 (user decision 2026-09-18):
REM repo stays as a clone/edit source only, not started here anymore. The kill
REM loop above still sweeps port 5001 if anything ever starts it.

echo.
echo Waiting for services to start...
powershell.exe -Command "Start-Sleep -Seconds 15" >nul 2>&1

echo.
curl -s http://127.0.0.1:8178/health
echo.
curl -s -o nul -w "App HTTP status: %%{http_code}\n" http://127.0.0.1:5000/
REM Nexus retired — no :5001 check.
REM curl -s -o nul -w "Nexus HTTP status: %%{http_code}\n" http://127.0.0.1:5001/

echo.
echo Refresh complete.
