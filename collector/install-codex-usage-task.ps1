<#
.SYNOPSIS
  在這台電腦裝上「Codex 用量回報」，每 30 分鐘一次，不需要系統管理員權限。

.DESCRIPTION
  做四件事，全部可重複執行，跑第二次不會弄壞第一次的結果：

    1. 檢查這台機器讀不讀得到 token。不要求你貼金鑰——
       Claude Code 遙測已經設過的 OTEL_EXPORTER_OTLP_HEADERS 裡就有，直接沿用。
    2. 先實跑一次 -DryRun，確認掃得到 session 檔、解析得出數字。
       這一步失敗就停手，不要裝一個註定不會動的東西。
    3. 在「啟動」資料夾放一支 .vbs，登入時以隱藏視窗啟動常駐迴圈。
    4. 立刻啟動一次，並回頭確認紀錄檔真的長出新行——存在不等於跑得動。

  為什麼不用 Windows 工作排程器（2026-08-23 在本機逐一實測，三條路都不通）：

    a. 一般權限**建不了**排程工作，連建在子資料夾 \CostScale\ 底下
       都回 Access is denied。
    b. 提權建成互動模式 ＋ wscript 跑 VBS：手動執行那支 VBS 完全正常，
       但由工作排程器啟動時 wscript 不會動，工作卡在「執行中」，
       連重導輸出的檔案都生不出來。
    c. 改用 S4U 主體（不論使用者是否登入均執行、不需存密碼）：
       工作回報 Last Result 0，但動作**根本沒被執行**。
       根因是這個帳號沒有密碼（`net user` 的 Password required = No），
       而本機原則 `LimitBlankPasswordUse = 1` 規定空白密碼帳號只能主控台登入，
       非互動登入一律被擋。`schtasks /Change` 也會直接警告
       「When the run-as password is empty, the scheduled task may not run」。

  改成「登入時啟動的常駐迴圈」：零管理員權限、零視窗、零排程器。
  代價是沒人登入時不會跑——但沒人登入時 Codex 也不會產生用量，不影響。

.PARAMETER IntervalMinutes
  多久回報一次。預設 30。

.PARAMETER Uninstall
  移除啟動項並結束常駐行程。
#>
[CmdletBinding()]
param(
  [int]$IntervalMinutes = 30,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$ScriptPath  = Join-Path $PSScriptRoot 'push-codex-usage.ps1'
$StartupDir  = [Environment]::GetFolderPath('Startup')
$VbsPath     = Join-Path $StartupDir 'costscale-codex-usage.vbs'
$LogPath     = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'costscale-codex-usage.log'
$MarkerName  = 'push-codex-usage.ps1'

function Fail {
  param([string]$Message)
  Write-Host ''
  Write-Host "失敗：$Message" -ForegroundColor Red
  Write-Host ''
  exit 1
}

function Stop-ExistingLoop {
  # 只殺「命令列裡有 push-codex-usage.ps1 而且帶 -LoopMinutes」的 powershell，
  # 不要用行程名亂殺——這台機器上隨時有好幾個 powershell 在跑別的事。
  $killed = 0
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$MarkerName*" -and $_.CommandLine -like '*LoopMinutes*' } |
    ForEach-Object {
      try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $killed++ } catch { }
    }
  return $killed
}

if ($Uninstall) {
  $n = Stop-ExistingLoop
  if (Test-Path $VbsPath) { Remove-Item $VbsPath -Force; Write-Host "已移除啟動項：$VbsPath" -ForegroundColor Green }
  else { Write-Host '啟動資料夾裡沒有這一項，不需要移除。' }
  Write-Host "已結束 $n 個常駐行程。"
  Write-Host ''
  Write-Host '若這台先前裝過排程工作版本，另外用系統管理員身分執行一次即可清掉：'
  Write-Host '  Start-Process schtasks -Verb RunAs -ArgumentList ''/Delete'',''/TN'',''CostScale Codex Usage'',''/F'''
  exit 0
}

Write-Host '=== CostScale Codex 用量回報 · 安裝 ===' -ForegroundColor Cyan
Write-Host ''

# ── 步驟 1：token ────────────────────────────────────────────────────
Write-Host '[1/4] 檢查 token…'
if (-not (Test-Path $ScriptPath)) {
  Fail "找不到 $ScriptPath。這支安裝腳本要和 push-codex-usage.ps1 放在同一個資料夾。"
}
$headers  = [Environment]::GetEnvironmentVariable('OTEL_EXPORTER_OTLP_HEADERS', 'User')
$explicit = [Environment]::GetEnvironmentVariable('COSTSCALE_INGEST_TOKEN', 'User')
if ($explicit) {
  Write-Host '      找到 COSTSCALE_INGEST_TOKEN，會用它。' -ForegroundColor Green
} elseif ($headers -match 'Authorization\s*=\s*Bearer\s+(\S+)') {
  Write-Host '      沿用 Claude Code 遙測那把 token（OTEL_EXPORTER_OTLP_HEADERS）。' -ForegroundColor Green
} else {
  Fail @'
這台機器讀不到 token。
先照儀表板「遙測」頁的「接線設定」把 Claude Code 的遙測環境變數設好
（其中 OTEL_EXPORTER_OTLP_HEADERS 那一行就是 token），設完重開一個終端機再跑這支。
'@
}

# ── 步驟 2：試跑 ─────────────────────────────────────────────────────
Write-Host '[2/4] 試跑一次（不會真的送出）…'
$out = & powershell -NoProfile -ExecutionPolicy Bypass -File $ScriptPath -DryRun -Days 1 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host ($out | Out-String)
  Fail '試跑失敗，什麼都沒有安裝。上面是錯誤訊息。'
}
Write-Host "      $(($out | Where-Object { $_ -like 'DryRun*' } | Select-Object -First 1))" -ForegroundColor Green

# ── 步驟 3：啟動項 ───────────────────────────────────────────────────
Write-Host "[3/4] 寫入啟動項（每 $IntervalMinutes 分鐘）…"
$stopped = Stop-ExistingLoop
if ($stopped -gt 0) { Write-Host "      先結束了 $stopped 個舊的常駐行程。" }

$vbs = @"
' 由 install-codex-usage-task.ps1 產生。登入時以隱藏視窗啟動常駐迴圈。
' 用 wscript 而不是直接放 .ps1 捷徑：Run 的第二個參數 0 代表視窗完全不顯示，
' 不是「開了再隱藏」，所以不會閃一下黑窗。
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""$ScriptPath"" -LoopMinutes $IntervalMinutes", 0, False
"@
# 一定要 Unicode（UTF-16LE ＋ BOM）。用 ASCII 寫的話，專案路徑裡的中文會整段
# 變成問號，wscript 照樣執行、照樣不報錯，只是 PowerShell 收到一個不存在的
# 路徑然後在隱藏視窗裡默默死掉（2026-08-23 實測踩過）。
Set-Content -Path $VbsPath -Value $vbs -Encoding Unicode
Write-Host "      $VbsPath" -ForegroundColor Green

# ── 步驟 4：立刻啟動並確認 ───────────────────────────────────────────
Write-Host '[4/4] 立刻啟動並確認紀錄檔有長出新行…'
$before = if (Test-Path $LogPath) { (Get-Content $LogPath | Measure-Object -Line).Lines } else { 0 }
Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$VbsPath`"" -WindowStyle Hidden

$grew = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 3
  $after = if (Test-Path $LogPath) { (Get-Content $LogPath | Measure-Object -Line).Lines } else { 0 }
  if ($after -gt $before) { $grew = $true; break }
}
if (-not $grew) {
  Fail "啟動項寫好了，但一分鐘內紀錄檔沒有長出新行。看 $LogPath。"
}
Write-Host "      $((Get-Content $LogPath -Tail 1))" -ForegroundColor Green

Write-Host ''
Write-Host '完成（已確認常駐行程真的跑起來並寫出紀錄）。' -ForegroundColor Green
Write-Host "回報間隔：每 $IntervalMinutes 分鐘"
Write-Host "啟動項：  $VbsPath"
Write-Host "紀錄檔：  $LogPath"
Write-Host ''
Write-Host '要移除的話：'
Write-Host '  .\install-codex-usage-task.ps1 -Uninstall'
Write-Host ''
