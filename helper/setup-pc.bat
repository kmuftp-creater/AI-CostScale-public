@echo off
rem One-time setup for a new computer.
rem Easiest: drag your PROJECTS ROOT folder onto this file, then type the board password.
setlocal
set "ROOT=%~1"
powershell -ExecutionPolicy Bypass -File "%~dp0setup-pc.ps1" "%ROOT%"
echo.
pause
