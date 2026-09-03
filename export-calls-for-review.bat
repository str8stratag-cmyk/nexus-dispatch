@echo off
setlocal enabledelayedexpansion

cd /d "C:\Users\str8s\dispatch-monitor"
node scripts/export-calls-for-review.mjs
pause
