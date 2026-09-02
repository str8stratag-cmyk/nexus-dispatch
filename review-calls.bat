@echo off
setlocal enabledelayedexpansion

cd /d "C:\Users\str8s\dispatch-monitor"
node scripts/review-calls.mjs
pause
