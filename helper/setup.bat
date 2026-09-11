@echo off
rem ONE-CLICK setup: double-click this file on a new computer. No admin needed.
rem Everything it needs (board URL, token, projects root) ships in helper-config.json
rem next to this file. See README.md.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-all.ps1"
