@echo off
rem Sets the Wandless passcode (digits only). Double-click this file or its Desktop shortcut.
rem For a password with letters instead, run in a terminal:  npm run set-password -- --password
title Wandless - set the passcode
cd /d "%~dp0"
echo Type a passcode: digits only, at least 4. Nothing shows while you type. That is normal.
echo.
call npm run set-password --silent
echo.
echo If the server is running, close its window, then double-click Wandless to start it again.
pause
