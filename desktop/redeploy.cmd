@echo off
rem redeploy.cmd - double-click to rebuild + redeploy the station after a code change.
rem (ASCII only: the console codepage mangles non-ASCII here.)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-desktop.ps1"
echo.
pause
