:
setlocal enabledelayedexpansion

cd /d "C:\Users\str8s\dispatch-monitor"
echo Running DISP 3 rule-based reconciler...
node trial/reconciler.mjs
pause
