@echo off
setlocal enabledelayedexpansion

echo Killing local dispatch services...
set "killed="

for /f "tokens=2,5" %%a in ('netstat -ano ^| findstr /R /C:"127\.0\.0\.1:8178.*LISTENING" /C:"0\.0\.0\.0:5000.*LISTENING"') do (
  echo Killing PID %%b on %%a
  taskkill /PID %%b /F >nul 2>&1
  set "killed=1"
)

if not defined killed (
  echo No dispatch services found running.
) else (
  echo Done.
)
