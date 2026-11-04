@echo off
rem Starts Wandless. Double-click this file or its desktop shortcut.
rem It opens the control page in your browser: the address to type on the headset, the folders, the passcode.
rem Close this window to stop Wandless.
title Wandless
cd /d "%~dp0"
if not defined PORT set "PORT=8443"
if not defined CONTROL_PORT set "CONTROL_PORT=8440"

powershell -NoProfile -Command "if (Get-NetTCPConnection -State Listen -LocalPort %PORT% -ErrorAction SilentlyContinue) { exit 1 }"
if errorlevel 1 (
  echo Wandless is already running. Opening its control page.
  start "" "http://127.0.0.1:%CONTROL_PORT%/"
  timeout /t 3 /nobreak >nul
  exit /b 0
)

echo Starting Wandless...
echo.
call npm start --silent -- --port %PORT%
if errorlevel 1 (
  echo.
  echo Wandless stopped with an error. Read the lines above to see why.
  pause
)
