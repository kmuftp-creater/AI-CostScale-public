# ONE-CLICK setup for a new computer (2026-08-22).
# Run via setup.bat. Reads helper-config.json that ships INSIDE this folder,
# so the user never has to type a token or a URL:
#   { "targets": [ { "url": "...", "path": "...", "token": "..." } ],
#     "root": "D:\\your\\projects\\root", "gitAutoPush": false }
# Then it: writes the two per-user config files, registers the silent 4-hour
# sync task (user level, no admin), registers the apphub:// open protocol,
# and runs one sync right away so you can see [OK] lines before closing.
# NOTE: inside PowerShell double-quoted strings use `" for a literal quote, NEVER \" (that was the
# original bug that made task registration fail on fresh PCs).
# ASCII only on purpose (cp950 misreads non-ASCII .ps1 without BOM).

$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
function Say($m) { Write-Host $m }
function Die($m) { Write-Host "[FAIL] $m"; Write-Host ""; Read-Host "Press Enter to close" | Out-Null; exit 1 }

Say "=== Board helper one-click setup ==="
Say "Folder: $here"
Say ""

# 1. Bundled config
$bundled = Join-Path $here "helper-config.json"
if (-not (Test-Path -LiteralPath $bundled)) {
  Die "helper-config.json not found in this folder. Copy the WHOLE helper folder from the source computer (it ships with the config)."
}
try { $cfg = Get-Content -LiteralPath $bundled -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Die "helper-config.json is not valid JSON" }
if (-not $cfg.targets -or $cfg.targets.Count -eq 0) { Die "helper-config.json has no targets" }

# 2. Projects root: use the bundled one if it exists on this PC.
#    Otherwise SCAN this PC for folders that contain projects (a project = a folder
#    with doc\status.json, possibly one level deeper) and offer a numbered list.
#    2026-08-22: the first version asked once in English and died on a typo.
#    A new PC almost never has the same path as the old one, so this is the
#    normal case, not the exception - it has to be easy.
function Find-ProjectRoots {
  $hits = @{}
  # Skip .worktrees / .claude too: git worktrees hold duplicate status.json copies
  # and would make one project count several times (E-32).
  $skip = '\\(Windows|Program Files|Program Files \(x86\)|ProgramData|node_modules|\.git|\.worktrees|\.claude|AppData|\$Recycle\.Bin)(\\|$)'
  $drives = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null -and $_.Root -match '^[A-Z]:\\$' }
  foreach ($d in $drives) {
    $files = Get-ChildItem -LiteralPath $d.Root -Filter status.json -Recurse -Depth 4 -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Directory.Name -eq 'doc' -and $_.FullName -notmatch $skip }
    foreach ($f in $files) {
      $proj = $f.Directory.Parent            # <project>\doc\status.json -> <project>
      if (-not $proj) { continue }
      $r = $proj.Parent.FullName             # <root>\<project>
      if ($hits.ContainsKey($r)) { $hits[$r]++ } else { $hits[$r] = 1 }
    }
  }
  # Nested layout (<root>\<project>\<app>\doc\status.json) also credits the grandparent,
  # so the real root wins by count; show at most 8 candidates.
  return $hits.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 8
}

$root = [string]$cfg.root
if (-not $root -or -not (Test-Path -LiteralPath $root)) {
  Say "Projects root from the package ($root) does not exist on this PC."
  Say "Scanning this PC for folders that contain projects (doc\status.json)... this can take a minute."
  $cands = @(Find-ProjectRoots)
  $root = ""
  for ($try = 0; $try -lt 3 -and -not $root; $try++) {
    if ($cands.Count -gt 0) {
      Say ""
      for ($i = 0; $i -lt $cands.Count; $i++) {
        Say ("  [{0}] {1}   ({2} project(s))" -f ($i + 1), $cands[$i].Key, $cands[$i].Value)
      }
      Say ""
      $ans = Read-Host "Type the NUMBER of your projects root, or paste a full folder path"
    } else {
      $ans = Read-Host "No project folders found by scanning. Paste the full path of the folder that holds your projects"
    }
    $ans = $ans.Trim('"').Trim()
    if ($ans -match '^\d+$' -and [int]$ans -ge 1 -and [int]$ans -le $cands.Count) {
      $root = $cands[[int]$ans - 1].Key
    } elseif ($ans -and (Test-Path -LiteralPath $ans)) {
      $root = $ans
    } else {
      Say "  Not a valid choice: '$ans' - try again ($(2 - $try) left)."
    }
  }
  if (-not $root) { Die "no projects root chosen. Re-run setup.bat when you know the folder." }
  Say "[OK] projects root: $root"
}

# 3. Per-user config files (what push-status.ps1 / board-sync-all.ps1 read)
$pushPath = Join-Path $env:USERPROFILE ".apphub-push.json"
$syncPath = Join-Path $env:USERPROFILE ".apphub-sync.json"
([pscustomobject]@{ targets = $cfg.targets }) | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $pushPath -Encoding UTF8
([pscustomobject]@{ root = $root; gitAutoPush = [bool]$cfg.gitAutoPush }) | ConvertTo-Json | Set-Content -LiteralPath $syncPath -Encoding UTF8
Say "[OK] push config  -> $pushPath  ($($cfg.targets.Count) target(s))"
Say "[OK] sync config  -> $syncPath  (root: $root)"

# 4. Silent auto-sync task, user level, every 4 hours. Points at THIS folder.
$vbs = Join-Path $here "board-sync-silent.vbs"
if (-not (Test-Path -LiteralPath $vbs)) { Die "missing $vbs" }
schtasks /Delete /TN "AppHub-Board-AutoSync" /F 2>$null | Out-Null
schtasks /Create /TN "AppHub-Board-AutoSync" /TR "wscript.exe `"$vbs`"" /SC HOURLY /MO 4 /F 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  Say "[OK] auto-sync task installed (every 4 hours, no window)"
} else {
  Say "[WARN] could not (re)register the task. If this PC has an OLD admin-created task,"
  Say "       it keeps running as before; to replace it, run once from an ADMIN prompt:"
  Say "       schtasks /Delete /TN `"AppHub-Board-AutoSync`" /F   then re-run setup.bat"
}

# 5. apphub:// protocol for the Open button (current user, no admin)
$openPs = Join-Path $here "apphub-open.ps1"
$cmdValue = 'powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $openPs + '" "%1"'
try {
  New-Item -Path "HKCU:\Software\Classes\apphub" -Force | Out-Null
  Set-ItemProperty -Path "HKCU:\Software\Classes\apphub" -Name "(default)" -Value "URL:App Hub Protocol"
  New-ItemProperty -Path "HKCU:\Software\Classes\apphub" -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
  New-Item -Path "HKCU:\Software\Classes\apphub\shell\open\command" -Force | Out-Null
  Set-ItemProperty -Path "HKCU:\Software\Classes\apphub\shell\open\command" -Name "(default)" -Value $cmdValue
  Say "[OK] apphub:// open protocol registered"
} catch {
  Say "[WARN] protocol registration failed: $($_.Exception.Message)  (run install.bat later)"
}

# 6. Sync right now so the result is visible.
Say ""
Say "--- first sync ---"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here "board-sync-all.ps1")
Say ""
Say "Done. Open the board to check this PC's projects appear."
Read-Host "Press Enter to close" | Out-Null
exit 0
