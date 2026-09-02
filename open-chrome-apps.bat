@echo off
setlocal enabledelayedexpansion

echo Opening Dispatch Monitor and Nexus Dispatch in Chrome app windows...
start chrome --app=http://localhost:5000
start chrome --app=http://localhost:5001
