@echo off
rem Update the App progress board from a project.
rem Drag a project folder onto this file, or run it from inside the project folder.
rem Auto-detects GitHub (commit+push) vs local (push channel).
setlocal
set "DIR=%~1"
if "%DIR%"=="" set "DIR=%CD%"
powershell -ExecutionPolicy Bypass -File "%~dp0board-update.ps1" "%DIR%"
echo.
pause
