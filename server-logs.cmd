@echo off
title CorNet - server activity
cd /d "%~dp0"
echo CorNet server activity. Press Ctrl+C to stop.
echo.
railway.cmd logs
if errorlevel 1 pause
