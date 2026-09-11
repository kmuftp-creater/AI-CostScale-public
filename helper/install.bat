@echo off
setlocal
rem Register the apphub:// protocol for the current user (no admin needed).

set "PS=%~dp0apphub-open.ps1"

reg add "HKCU\Software\Classes\apphub" /ve /d "URL:App Hub Protocol" /f
reg add "HKCU\Software\Classes\apphub" /v "URL Protocol" /d "" /f
reg add "HKCU\Software\Classes\apphub\shell\open\command" /ve /d "powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File \"%PS%\" \"%%1\"" /f

echo.
if %errorlevel%==0 (
  echo [OK] App Hub helper installed.
) else (
  echo [FAIL] Installation failed. Please screenshot and report.
)
echo.
pause
