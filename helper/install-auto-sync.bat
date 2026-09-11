@echo off
rem Install the background auto-sync. Local-only: no AI, no tokens.
rem Runs every 4 hours via wscript, so NO console window ever appears.
rem 2026-08-22: the task now points at THIS folder (%~dp0), so the helper can
rem live anywhere. The old version hardcoded C:\apphub-helper and silently
rem broke every copy placed at a different path.
rem Change the interval: edit /MO 4 below (in hours). Remove with uninstall-auto-sync.bat.
rem NOTE: does NOT require administrator. A per-user task is enough for a
rem per-user sync, and a user-level task can later be edited without admin
rem rights (the old admin-created task could not - see DEVLOG-2026-08-05).

set "VBS=%~dp0board-sync-silent.vbs"
if not exist "%VBS%" (
  echo [FAIL] board-sync-silent.vbs not found next to this file.
  pause
  exit /b 1
)

schtasks /Delete /TN "AppHub-Board-AutoSync" /F >nul 2>&1
schtasks /Create /TN "AppHub-Board-AutoSync" /TR "wscript.exe \"%VBS%\"" /SC HOURLY /MO 4 /F
if errorlevel 1 (
  echo [FAIL] Could not register the task.
  echo If an OLD task exists that was created as administrator, delete it once
  echo from an admin prompt:  schtasks /Delete /TN "AppHub-Board-AutoSync" /F
) else (
  echo.
  echo [OK] Installed. The board auto-syncs every 4 hours, silently - no popup window.
  echo Need it right now? Run board-sync-all.bat.
)
echo.
pause
