' Launch the board sync with NO console window at all.
' wscript.exe is a GUI host, so powershell.exe never flashes a black window
' and never steals focus while you are working.
'
' 2026-08-22: path is derived from this file's own folder, so the helper works
' from ANY install location. The old version hardcoded C:\apphub-helper, which
' silently broke every copy placed anywhere else.
Option Explicit
Dim sh, fso, here, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & here & "\board-sync-all.ps1"""
sh.Run cmd, 0, False
