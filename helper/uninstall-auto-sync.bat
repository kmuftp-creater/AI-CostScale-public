@echo off
rem Remove the background auto-sync task.
schtasks /Delete /TN "AppHub-Board-AutoSync" /F
echo.
echo Removed. The board no longer auto-syncs in the background.
pause
