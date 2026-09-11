# Push this project's doc/status.json to the progress board(s).
# One-time setup: copy push-config.example.json to  %USERPROFILE%\.apphub-push.json
# Config supports MULTIPLE boards (2026-08-22, CostScale migration):
#   { "targets": [ { "url": "https://cost.example.com", "path": "/api/board/push", "token": "..." } ] }
# The old single-target form { "url": ..., "token": ... } still works (path defaults to /api/push).
# Exit code is non-zero if ANY target fails, so the sync state is not marked done
# and the next run retries automatically.
# Usage (run inside the project folder, or pass the folder):
#   powershell -ExecutionPolicy Bypass -File push-status.ps1 [projectFolder]
# ASCII only on purpose (cp950 misreads non-ASCII .ps1 without BOM).

param([string]$ProjectDir = ".")

function Fail($m) { Write-Host "[FAIL] $m"; exit 1 }

$cfgPath = Join-Path $env:USERPROFILE ".apphub-push.json"
if (-not (Test-Path $cfgPath)) { Fail "Config not found: $cfgPath (copy push-config.example.json there and fill it in)" }
try { $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Fail "Config is not valid JSON: $cfgPath" }

# Normalize config into a target list (new "targets" array, or legacy url/token pair).
$targets = @()
if ($cfg.targets) {
  foreach ($t in $cfg.targets) {
    if ($t.url -and $t.token) {
      $p = if ($t.path) { $t.path } else { "/api/push" }
      $targets += [pscustomobject]@{ Url = $t.url; Path = $p; Token = $t.token }
    }
  }
} elseif ($cfg.url -and $cfg.token) {
  $targets += [pscustomobject]@{ Url = $cfg.url; Path = "/api/push"; Token = $cfg.token }
}
if ($targets.Count -eq 0) { Fail "Config has no usable target (need targets[] with url+token, or legacy url/token)" }

$statusPath = Join-Path $ProjectDir "doc/status.json"
if (-not (Test-Path $statusPath)) { Fail "No doc/status.json in $ProjectDir  (let your AI generate it first, then re-run)" }
try { $project = Get-Content $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Fail "doc/status.json is not valid JSON" }

$failed = 0
foreach ($t in $targets) {
  $body = @{ token = $t.Token; project = $project } | ConvertTo-Json -Depth 12
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  $url = ($t.Url.TrimEnd('/')) + $t.Path
  try {
    $resp = Invoke-RestMethod -Uri $url -Method Post -ContentType "application/json; charset=utf-8" -Body $bytes
    Write-Host "[OK] pushed to $($t.Url): $($resp.name)"
  } catch {
    Write-Host "[FAIL] push to $($t.Url) failed: $($_.Exception.Message)"
    $failed++
  }
}
if ($failed -gt 0) { exit 1 }
exit 0
