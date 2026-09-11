@echo off
rem Sync ALL projects to the board right now (one click, no per-folder drag).
rem Local-only: uses no AI and no tokens.
powershell -ExecutionPolicy Bypass -File "%~dp0board-sync-all.ps1"
echo.
pause
