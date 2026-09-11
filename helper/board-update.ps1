# Update the App progress board from a project's doc/status.json.
# Auto-detects: GitHub repo -> commit status.json + git push ; otherwise -> push channel.
# Works the same no matter which AI edited status.json (Codex / Antigravity / Claude).
# Usage: drag a project folder onto board-update.bat, or run with the folder path.
# ASCII only on purpose (cp950 misreads non-ASCII .ps1 without BOM).

param([string]$ProjectDir = ".")

function Fail($m) { Write-Host "[FAIL] $m"; exit 1 }

$rp = Resolve-Path -LiteralPath $ProjectDir -ErrorAction SilentlyContinue
if (-not $rp) { Fail "Folder not found: $ProjectDir" }
$dir = $rp.Path
$statusPath = Join-Path $dir "doc/status.json"
if (-not (Test-Path $statusPath)) { Fail "No doc/status.json in $dir  (let your AI create/update it first)" }

# Detect a git repo with an origin remote.
$isGit = $false
$remote = ""
if (Test-Path (Join-Path $dir ".git")) {
  $remote = (& git -C $dir remote get-url origin 2>$null)
  if ($LASTEXITCODE -eq 0 -and $remote) { $isGit = $true }
}

if ($isGit) {
  Write-Host "[git] remote: $remote"
  & git -C $dir add -- "doc/status.json" | Out-Null
  & git -C $dir diff --cached --quiet
  if ($LASTEXITCODE -ne 0) {
    & git -C $dir commit -m "Update doc/status.json for progress board" | Out-Null
    Write-Host "[git] committed status.json"
  } else {
    Write-Host "[git] status.json unchanged (will still push any pending commits)"
  }
  & git -C $dir push
  if ($LASTEXITCODE -eq 0) {
    Write-Host "[OK] pushed to GitHub. Board shows it on next refresh (repo must be in the tracked list)."
  } else {
    Fail "git push failed (check network / git credentials)"
  }
  exit 0
} else {
  Write-Host "[push channel] no GitHub remote -> using push-status.ps1"
  & (Join-Path $PSScriptRoot "push-status.ps1") $dir
  exit $LASTEXITCODE
}
