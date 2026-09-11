# One-time setup for a new computer (2026-08-22 rewrite for the CostScale board).
# Writes the two per-user config files and installs the silent auto-sync task.
# Easiest use: drag your PROJECTS ROOT folder onto setup-pc.bat (passes the path here),
# then paste the push token when asked.
#
# What the old version got wrong on a fresh PC (all fixed here):
#   - task pointed at hardcoded C:\apphub-helper (broken at any other install path)
#   - task ran powershell directly every 5 minutes (black window flashing all day)
#   - board URL pointed at the old Cloudflare board
# NOTE: inside PowerShell double-quoted strings use `" for a literal quote, NEVER \" (that was the
# original bug that made task registration fail on fresh PCs).
# ASCII only on purpose (the Chinese projects path comes in at runtime, not as a literal).

param([string]$Root = "", [string]$Url = "")

# Your CostScale dashboard address (the AUTH_URL in the server's .env).
# Can also come from the COSTSCALE_BOARD_URL user environment variable.
$newPath = "/api/board/push"

if (-not $Root) {
  $Root = Read-Host "Projects root folder full path"
}
$Root = $Root.Trim('"').Trim()
if (-not (Test-Path -LiteralPath $Root)) { Write-Host "[FAIL] folder not found: $Root"; exit 1 }

if (-not $Url) { $Url = [Environment]::GetEnvironmentVariable('COSTSCALE_BOARD_URL', 'User') }
if (-not $Url) { $Url = Read-Host "CostScale dashboard address (e.g. https://cost.example.com)" }
$newUrl = $Url.Trim().TrimEnd('/')
if ($newUrl -notmatch '^https?://') { Write-Host "[FAIL] address must start with https:// : $newUrl"; exit 1 }

$tok = Read-Host "Board push token (BOARD_PUSH_TOKEN from the CostScale server)"
if (-not $tok) { Write-Host "[FAIL] token is empty"; exit 1 }

$targets = @()
$targets += [pscustomobject]@{ url = $newUrl; path = $newPath; token = $tok }

$pushPath = Join-Path $env:USERPROFILE ".apphub-push.json"
$syncPath = Join-Path $env:USERPROFILE ".apphub-sync.json"
([pscustomobject]@{ targets = $targets }) | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $pushPath -Encoding UTF8
([pscustomobject]@{ root = $Root; gitAutoPush = $false }) | ConvertTo-Json | Set-Content -LiteralPath $syncPath -Encoding UTF8
Write-Host "[OK] wrote $pushPath  ($($targets.Count) target(s))"
Write-Host "[OK] wrote $syncPath  (root: $Root)"

# Install the background auto-sync: every 4 hours, launched via wscript so no
# console window ever appears. Task points at THIS folder, works from any path.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $here "board-sync-silent.vbs"
if (-not (Test-Path -LiteralPath $vbs)) { Write-Host "[FAIL] missing $vbs"; exit 1 }
schtasks /Delete /TN "AppHub-Board-AutoSync" /F 2>$null | Out-Null
schtasks /Create /TN "AppHub-Board-AutoSync" /TR "wscript.exe `"$vbs`"" /SC HOURLY /MO 4 /F | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Host "[OK] auto-sync installed (every 4 hours, silent)" }
else { Write-Host "[WARN] could not register task; if an old admin-created task exists, delete it once from an admin prompt: schtasks /Delete /TN `"AppHub-Board-AutoSync`" /F" }

Write-Host ""
Write-Host "Done. Also run install.bat once to register the apphub:// open protocol."
Write-Host "Tip: run board-sync-all.bat once now to sync immediately."
