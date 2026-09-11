<#
.SYNOPSIS
  把 Claude Code 用量收集器裝成登入時自動啟動的常駐迴圈（2026-09-07）。

.DESCRIPTION
  與 install-codex-usage-task.ps1 同一套做法，理由也一樣：

  **這台機器上任何非互動的排程工作都走不通**（E-19）。帳號沒有密碼
  （`Password required = No`），而 `LimitBlankPasswordUse = 1` 規定空白密碼
  的帳號只能主控台登入。最惡劣的是工作回報 `Last Result 0` 但動作根本沒被執行。
  所以改用「啟動資料夾 ＋ 隱藏視窗的常駐迴圈」。

  VBS 一定要存成 Unicode（UTF-16LE ＋ BOM，E-25）。用 ASCII 寫的話，
  專案路徑裡的中文會整段變成問號，wscript 照樣執行、照樣不報錯，
  只是 PowerShell 收到一個不存在的路徑然後在隱藏視窗裡默默死掉。

.PARAMETER IntervalMinutes
  幾分鐘跑一輪。預設 30。收集器只讀「有變動」的檔，所以這個值不影響成本。

.PARAMETER Token
  回報用的 token。**主力機不必給**——那台的 `OTEL_EXPORTER_OTLP_HEADERS`
  裡就有（Claude Code 遙測設定留下的），收集器會自己撈。
  其他機器沒設過遙測就沒有那個變數，要用這個參數帶進來，
  或把 token 放在與本腳本同一個資料夾的 `_token.txt`（交付包就是這樣做的）。
  給了會寫進**使用者範圍**的環境變數 `COSTSCALE_INGEST_TOKEN`，只寫一次。

.PARAMETER Uninstall
  移除啟動項並結束常駐行程。
#>
[CmdletBinding()]
param(
  [int]$IntervalMinutes = 30,
  [string]$Token,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$ScriptPath = Join-Path $PSScriptRoot 'push-claude-usage.ps1'
$StartupDir = [Environment]::GetFolderPath('Startup')
$VbsPath    = Join-Path $StartupDir 'costscale-claude-usage.vbs'

$LocalApp = [Environment]::GetFolderPath('LocalApplicationData')
if (-not $LocalApp) { $LocalApp = $env:LOCALAPPDATA }
$LogPath = Join-Path $LocalApp 'costscale-claude-usage.log'

function Stop-ExistingLoop {
  # 只殺「指令列同時含這支腳本檔名與 -LoopMinutes」的，不要用檔名單獨比對——
  # 那會把安裝腳本自己的工具呼叫也比中（第八十四節踩過，差一步殺到自己）。
  $n = 0
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -like '*push-claude-usage.ps1*' -and
      $_.CommandLine -like '*-LoopMinutes*'
    } |
    ForEach-Object {
      try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $n++ } catch { }
    }
  return $n
}

if ($Uninstall) {
  Write-Host '移除 Claude Code 用量收集器…'
  $stopped = Stop-ExistingLoop
  Write-Host "      結束了 $stopped 個常駐行程。"
  if (Test-Path $VbsPath) { Remove-Item $VbsPath -Force; Write-Host "      已刪除 $VbsPath" }
  else { Write-Host '      啟動資料夾裡沒有這一項，不需要移除。' }
  exit 0
}

if (-not (Test-Path $ScriptPath)) {
  Write-Error "找不到收集器：$ScriptPath"
  exit 1
}

# ── token：三個來源，由近而遠 ────────────────────────────────────────
# 1. -Token 參數
# 2. 與本腳本同資料夾的 _token.txt（交付包用這個，使用者不必打字）
# 3. 機器上既有的環境變數（主力機的 OTEL_EXPORTER_OTLP_HEADERS 裡就有）
# 都沒有才問。問的時候要講清楚去哪裡拿，不要只丟一個提示字元。
function Get-ExistingToken {
  foreach ($n in @('COSTSCALE_INGEST_TOKEN')) {
    foreach ($scope in @('Process', 'User', 'Machine')) {
      $v = [Environment]::GetEnvironmentVariable($n, $scope)
      if ($v) { return $v }
    }
  }
  foreach ($scope in @('Process', 'User', 'Machine')) {
    $h = [Environment]::GetEnvironmentVariable('OTEL_EXPORTER_OTLP_HEADERS', $scope)
    if ($h -and $h -match 'Bearer\s+([^\s,;]+)') { return $Matches[1] }
  }
  return $null
}

if (-not $Token) {
  $tokenFile = Join-Path $PSScriptRoot '_token.txt'
  if (Test-Path $tokenFile) {
    $Token = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
    if ($Token) { Write-Host '      token 取自交付包的 _token.txt。' -ForegroundColor DarkGray }
  }
}
if (-not $Token) { $Token = Get-ExistingToken }
if (-not $Token) {
  Write-Host ''
  Write-Host '這台機器上找不到回報用的 token。' -ForegroundColor Yellow
  Write-Host '請貼上 token（在儀表板管理者那裡拿，或問家用主機那台）：'
  $Token = (Read-Host '  token').Trim()
}
if (-not $Token) {
  Write-Error '沒有 token，安裝中止。收集器沒有 token 送不出去，裝了也是白裝。'
  exit 1
}

# 角括號的坑（2026-09-03 踩過）：說明裡的佔位符 `<你的金鑰>` 連角括號一起被貼進來，
# 送出去會被判 401 而且**訊息裡看不出是這個原因**。這裡直接擋掉。
if ($Token -match '^[<"''].*[>"'']$') {
  Write-Error "token 前後有角括號或引號（$($Token.Substring(0,1))…$($Token.Substring($Token.Length-1,1))）。只貼值本身，不要連符號一起貼。"
  exit 1
}

[Environment]::SetEnvironmentVariable('COSTSCALE_INGEST_TOKEN', $Token, 'User')
$env:COSTSCALE_INGEST_TOKEN = $Token
Write-Host "      token 已寫入使用者環境變數（尾 4 碼 …$($Token.Substring([Math]::Max(0,$Token.Length-4)))）。" -ForegroundColor Green

Write-Host '[1/3] 先空跑一次，確認讀得到資料也送得出去…'
$out = & $ScriptPath -DryRun 2>&1
$head = ($out | Where-Object { $_ -like 'DryRun*' -or $_ -like '沒有*' } | Select-Object -First 1)
if (-not $head) {
  Write-Host '      空跑沒有預期的輸出，先看紀錄檔再繼續：' -ForegroundColor Yellow
  $out | Select-Object -First 5 | ForEach-Object { Write-Host "      $_" }
} else {
  Write-Host "      $head" -ForegroundColor Green
}

Write-Host "[2/3] 寫入啟動項（每 $IntervalMinutes 分鐘一輪）…"
$stopped = Stop-ExistingLoop
if ($stopped -gt 0) { Write-Host "      先結束了 $stopped 個舊的常駐行程。" }

$vbs = @"
' 由 install-claude-usage-task.ps1 產生。登入時以隱藏視窗啟動常駐迴圈。
' 用 wscript 而不是直接放 .ps1 捷徑：Run 的第二個參數 0 代表視窗完全不顯示，
' 不是「開了再隱藏」，所以不會閃一下黑窗。
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""$ScriptPath"" -LoopMinutes $IntervalMinutes", 0, False
"@
Set-Content -Path $VbsPath -Value $vbs -Encoding Unicode
Write-Host "      $VbsPath" -ForegroundColor Green

Write-Host '[3/3] 立刻啟動並確認紀錄檔有長出新行…'
$before = if (Test-Path $LogPath) { (Get-Content $LogPath | Measure-Object -Line).Lines } else { 0 }
Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$VbsPath`"" -WindowStyle Hidden

$grew = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 3
  $after = if (Test-Path $LogPath) { (Get-Content $LogPath | Measure-Object -Line).Lines } else { 0 }
  if ($after -gt $before) { $grew = $true; break }
}

if ($grew) {
  Write-Host '      紀錄檔有新行，常駐迴圈確實在跑。' -ForegroundColor Green
  Get-Content $LogPath -Tail 3 | ForEach-Object { Write-Host "      $_" }
  Write-Host ''
  Write-Host "完成。紀錄檔：$LogPath" -ForegroundColor Green
  exit 0
}

# 「裝好了」不能只看檔案有沒有被建立——那證明不了它會跑。
Write-Error "啟動項寫好了，但 60 秒內紀錄檔沒有長出新行。先手動跑一次看錯在哪：`n  & '$ScriptPath' -DryRun"
exit 1
