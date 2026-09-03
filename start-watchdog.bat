@echo off
setlocal enabledelayedexpansion

echo Starting Dispatch Monitor watchdog...
echo This will launch Whisper, dispatch-monitor, and nexus-dispatch.
echo.

powershell -ExecutionPolicy Bypass -File "C:\Users\str8s\dispatch-monitor\scripts\watchdog.ps1"
