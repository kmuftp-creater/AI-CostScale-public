@echo off
rem Removes the old board target from this PC's .apphub-push.json.
rem Touches nothing else. Backs up first.
rem Uses %%~dp0 so this pair of files can sit anywhere.
powershell -ExecutionPolicy Bypass -File "%~dp0移除舊看板推送目標.ps1"
