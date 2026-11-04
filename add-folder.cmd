@echo off
rem Adds a video folder for Wandless: pick it in the normal Windows folder window.
rem The headset shows it after you reload the page. The server does not need a restart.
title Wandless - add a folder
cd /d "%~dp0"
powershell -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0scripts\add-folder.ps1"
echo.
pause
