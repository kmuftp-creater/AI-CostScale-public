@echo off
rem Push a project's doc/status.json to the App progress board.
rem Use: drag a project folder onto this file, or run it from inside the project folder.
setlocal
set "DIR=%~1"
if "%DIR%"=="" set "DIR=%CD%"
powershell -ExecutionPolicy Bypass -File "%~dp0push-status.ps1" "%DIR%"
echo.
pause
