# App Hub local helper: handles apphub://open?path=...&apps=App1,App2
# Opens the project folder and launches the selected apps from apps.json.
# ASCII only on purpose: PowerShell 5.1 misreads non-ASCII .ps1 without a BOM.
# Security: only launches apps registered in apps.json, never arbitrary URL commands.

param([string]$Url)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppsFile = Join-Path $ScriptDir 'apps.json'
$LogFile = Join-Path $ScriptDir 'apphub.log'

function Log($msg) {
  try { Add-Content -Path $LogFile -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) } catch {}
}
function Show-Msg($text) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($text, 'App Hub') | Out-Null
}

try {
  Log "URL: $Url"
  $query = $Url -replace '^[a-zA-Z]+://[^?]*\??', ''
  $params = @{}
  foreach ($pair in ($query -split '&')) {
    if ($pair -match '=') {
      $kv = $pair -split '=', 2
      $params[$kv[0]] = [System.Uri]::UnescapeDataString($kv[1])
    }
  }

  $path = $params['path']
  Log "path: $path"
  if (-not $path) { Log 'no path'; Show-Msg 'No folder path received.'; exit }
  if (-not (Test-Path $path)) {
    Log 'path not found'
    Show-Msg "Folder not found:`n$path`n`nThis project may be on another computer."
    exit
  }

  # 1) open the folder
  Start-Process explorer.exe $path
  Log 'explorer opened'

  # 2) auto-create apps.json if missing (best-effort detection)
  if (-not (Test-Path $AppsFile)) {
    Log 'apps.json missing, autodetect'
    $map = [ordered]@{}
    $cand = @{
      'Antigravity' = @("$env:LOCALAPPDATA\Programs\Antigravity\Antigravity.exe")
      'VS Code'     = @("$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe")
    }
    foreach ($n in $cand.Keys) {
      $hit = $cand[$n] | Where-Object { Test-Path $_ } | Select-Object -First 1
      if ($hit) { $map[$n] = $hit }
    }
    if ($map.Count -eq 0) { $map['Antigravity'] = '' }
    ($map | ConvertTo-Json) | Set-Content -Path $AppsFile -Encoding UTF8
  }

  $apps = @()
  if ($params['apps']) { $apps = $params['apps'] -split ',' | Where-Object { $_ } }
  Log ("apps requested: " + ($apps -join ','))
  if ($apps.Count -eq 0) { Log 'no apps, folder only'; exit }

  $appMap = @{}
  try {
    (Get-Content $AppsFile -Raw | ConvertFrom-Json).PSObject.Properties |
      ForEach-Object { $appMap[$_.Name.ToLower()] = $_.Value }
  } catch { Log "apps.json read error: $($_.Exception.Message)" }

  $missing = @()
  foreach ($name in $apps) {
    $key = $name.Trim().ToLower()
    $cmd = $appMap[$key]
    if ($cmd) {
      Log "launch $name -> $cmd"
      try { Start-Process -FilePath $cmd -ArgumentList "`"$path`"" -WorkingDirectory $path }
      catch { Log "launch fail $name : $($_.Exception.Message)"; $missing += $name }
    } else {
      Log "no mapping for $name"
      $missing += $name
    }
  }
  if ($missing.Count -gt 0) {
    Show-Msg ("These apps are not set on this PC (skipped):`n" + ($missing -join ', ') +
              "`n`nEdit apps.json in the helper folder to add their exe paths.")
  }
  Log 'done'
}
catch {
  Log "ERROR: $($_.Exception.Message)"
  Show-Msg "Error opening:`n$($_.Exception.Message)"
}
