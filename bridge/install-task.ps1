# 把橋接的常駐管理程式註冊成 Windows 排程工作（登入時自動啟動）。
#
# 用法（一般 PowerShell 視窗，不需系統管理員）：
#   powershell -ExecutionPolicy Bypass -File bridge\install-task.ps1
#
# 移除：
#   Unregister-ScheduledTask -TaskName 'CostScale Bridge' -Confirm:$false

$ErrorActionPreference = 'Stop'

$TaskName = 'CostScale Bridge'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Supervisor = Join-Path $Here 'supervisor.ps1'

if (-not (Test-Path $Supervisor)) {
    Write-Host "[失敗] 找不到 $Supervisor" -ForegroundColor Red
    exit 1
}

# 先檢查前置條件，不要註冊一個註定跑不起來的工作。
$missing = @()
foreach ($k in @('BRIDGE_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN')) {
    if (-not [Environment]::GetEnvironmentVariable($k, 'User')) { $missing += $k }
}
if ($missing.Count) {
    Write-Host "[失敗] 缺少使用者環境變數：$($missing -join '、')" -ForegroundColor Red
    Write-Host "        設定完再執行本腳本。" -ForegroundColor Red
    exit 1
}

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Supervisor`"" `
    -WorkingDirectory $Here

# 登入時啟動。刻意不用開機啟動：橋接要叫的 CLI 是以使用者身分登入的，
# 沒有使用者工作階段時那些憑證讀不到。
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

# 以目前使用者身分執行，不提權——橋接不需要系統管理員權限。
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null

Write-Host ''
Write-Host "[成功] 已註冊排程工作「$TaskName」" -ForegroundColor Green
Write-Host "        觸發時機：使用者登入時"
Write-Host "        日誌位置：$env:LOCALAPPDATA\costscale-bridge\"
Write-Host ''
Write-Host '現在立刻啟動一次…'
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 8

try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8787/health' -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -eq 200) {
        Write-Host '[通過] 橋接服務已回應 /health' -ForegroundColor Green
    }
} catch {
    Write-Host '[注意] 橋接服務尚未回應，可能還在啟動。' -ForegroundColor Yellow
    Write-Host "        稍後查看 $env:LOCALAPPDATA\costscale-bridge\supervisor.log" -ForegroundColor Yellow
}
