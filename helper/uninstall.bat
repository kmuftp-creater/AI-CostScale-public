@echo off
setlocal
rem Remove the apphub:// protocol for the current user.

reg delete "HKCU\Software\Classes\apphub" /f >nul 2>&1

echo.
echo [OK] App Hub helper removed.
echo.
pause
