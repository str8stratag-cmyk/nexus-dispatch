@echo off
setlocal enabledelayedexpansion

echo Starting Nexus Dispatch (Disp 2) Whisper test service...
echo Model: distil-large-v3
echo Port: 8179

set "WHISPER_MODEL=distil-large-v3"
set "WHISPER_PORT=8179"
set "WHISPER_DEVICE=cpu"
set "WHISPER_COMPUTE_TYPE=int8"

powershell -ExecutionPolicy Bypass -File "C:\Users\str8s\nexus-dispatch\scripts\start-whisper.ps1" -Model distil-large-v3
