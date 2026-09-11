# Auto-sync local projects' doc/status.json to the App progress board.
# Local-only Windows script. Uses NO AI and NO tokens: it only reads files and POSTs to the board.
# Scans the projects root (from %USERPROFILE%\.apphub-sync.json) and pushes only those whose
# doc/status.json changed since last run. Looks one level deeper too, because some projects keep
# the app in a subfolder (<project>\<app>\doc\status.json).
#   - no GitHub remote -> push channel (push-status.ps1)
#   - GitHub repo       -> board only via push channel (no GitHub push) unless gitAutoPush=true
# ASCII only on purpose (cp950 misreads non-ASCII .ps1 without BOM).

$cfgPath = Join-Path $env:USERPROFILE ".apphub-sync.json"
if (-not (Test-Path $cfgPath)) { Write-Host "[FAIL] missing config: $cfgPath"; exit 1 }
try { $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Write-Host "[FAIL] bad config JSON: $cfgPath"; exit 1 }
$root = $cfg.root
if (-not $root -or -not (Test-Path -LiteralPath $root)) { Write-Host "[FAIL] root not found: $root"; exit 1 }
$gitAutoPush = [bool]$cfg.gitAutoPush

$statePath = Join-Path $env:USERPROFILE ".apphub-sync-state.json"
$state = @{}
if (Test-Path $statePath) {
  try {
    $j = Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($p in $j.PSObject.Properties) { $state[$p.Name] = $p.Value }
  } catch {}
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# Collect project folders: direct children holding doc/status.json, plus one level deeper
# for projects whose app lives in a subfolder (e.g. 260101-my-app\my-app\doc\status.json).
$projects = @()
foreach ($d in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
  if (Test-Path -LiteralPath (Join-Path $d.FullName "doc\status.json")) {
    $projects += [pscustomobject]@{ Key = $d.Name; Dir = $d.FullName }
    continue
  }
  foreach ($s in (Get-ChildItem -LiteralPath $d.FullName -Directory -ErrorAction SilentlyContinue)) {
    if ($s.Name -eq "node_modules" -or $s.Name -eq ".git") { continue }
    if (Test-Path -LiteralPath (Join-Path $s.FullName "doc\status.json")) {
      $projects += [pscustomobject]@{ Key = ($d.Name + "/" + $s.Name); Dir = $s.FullName }
    }
  }
}

$synced = 0
foreach ($proj in $projects) {
  $dir = $proj.Dir
  $key = $proj.Key
  $sp = Join-Path $dir "doc\status.json"
  $hash = (Get-FileHash -LiteralPath $sp -Algorithm SHA256).Hash
  if ($state[$key] -eq $hash) { continue }   # unchanged since last sync

  $isGit = $false
  if (Test-Path (Join-Path $dir ".git")) {
    $r = (& git -C $dir remote get-url origin 2>$null)
    if ($LASTEXITCODE -eq 0 -and $r) { $isGit = $true }
  }
  if ($isGit -and -not $gitAutoPush) {
    # Board only: send doc/status.json to your own board via the push channel.
    # This does NOT touch GitHub (no code published) and ignores which branch you are on,
    # so board progress stays current even while you work on a feature branch.
    Write-Host "[sync-board] $key (git project; board only, no GitHub push)"
    & (Join-Path $here "push-status.ps1") $dir
  } else {
    Write-Host "[sync] $key"
    & (Join-Path $here "board-update.ps1") $dir
  }
  if ($LASTEXITCODE -eq 0) { $state[$key] = $hash; $synced++ } else { Write-Host "[warn] failed: $key" }
}

$obj = New-Object psobject
foreach ($k in $state.Keys) { $obj | Add-Member -NotePropertyName $k -NotePropertyValue $state[$k] -Force }
$obj | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
Write-Host "[done] synced $synced project(s)"
