<#
.SYNOPSIS
  把本機 Codex CLI 的 token 用量送到 AI CostScale。

.DESCRIPTION
  為什麼要有這支：Codex 0.148.0 支援 OTLP，但匯出的 logs／metrics／traces
  裡完全沒有 token 欄位（2026-08-23 用本機 OTLP 樁實測）。唯一拿得到 token 的
  地方是它自己的 session 檔：

      ~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl

  每個檔的最後一個 token_count 事件帶著該 thread 的**累計** total_token_usage，
  同一個事件裡還有 rate_limits.primary.used_percent（訂閱週額度用量）。

  三件實作上必須小心的事：

  1. 那些檔一天約 140 MB、單檔可到 24 MB。整份 Get-Content 會很慢，
     所以只讀「第一行」（session_meta）與「檔尾若干行」（找最後一個 token_count）。
  2. 送上去的是累計值，伺服器端以 (source, session_id) 覆寫而不是累加。
     跑幾次都不會重複計算，可以放心排程。
  3. 參數不要取名 $Args。那是 PowerShell 的自動變數，函式一旦宣告具名參數
     它就是空的，值會靜默不見（LESSONS L-138，橋接為此壞過一整天）。

.PARAMETER Days
  只回報「最後寫入在這幾天內」的 session 檔。預設 2。
  判斷依據是**檔案的最後寫入時間**，不是它放在哪個日期資料夾——
  兩者會差很多，理由見下方「收集」段的註解。

.PARAMETER TailLines
  從檔尾讀幾行去找最後一個 token_count 事件。預設 400。
  找不到時會退回整份掃描，所以這個值只影響速度、不影響正確性。

.PARAMETER DryRun
  只印出要送什麼，不真的送。
#>
[CmdletBinding()]
param(
  [int]$Days = 2,
  [int]$TailLines = 400,
  [switch]$DryRun,
  [int]$LoopMinutes = 0
)

$ErrorActionPreference = 'Stop'

# ── 紀錄檔（2026-08-24 從下面搬上來）─────────────────────────────────
# 搬上來的理由：常駐迴圈在原本的位置之前就開始跑了，它想寫紀錄也寫不了
# （Write-Log 還沒定義），所以整支迴圈是靜音的。B-5 拖了一天就是這個原因。
#
# 紀錄檔位置不要只靠 $env:LOCALAPPDATA。排程工作以 S4U 執行時使用者設定檔
# 不一定完整載入，那個變數可能是空的，Join-Path 就會產生相對路徑，
# 檔案落到 C:\Windows\system32 然後因為沒有寫入權限而整支腳本無聲死掉。
$localApp = [Environment]::GetFolderPath('LocalApplicationData')
if (-not $localApp) { $localApp = $env:LOCALAPPDATA }
if (-not $localApp -and $env:USERPROFILE) { $localApp = Join-Path $env:USERPROFILE 'AppData\Local' }
if (-not $localApp) { $localApp = $PSScriptRoot }
$LogPath    = Join-Path $localApp 'costscale-codex-usage.log'

# 迴圈改成每輪都留痕之後一天約 200 行。留個上限免得長到沒人想開。
# 超過 1 MB 只保留最後 2000 行；截斷本身也寫一行，不要靜悄悄地掉資料。
$LogMaxBytes  = 1MB
$LogKeepLines = 2000

function Write-Log {
  param([string]$Message)
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  try {
    if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt $LogMaxBytes)) {
      $keep = Get-Content -Path $LogPath -Tail $LogKeepLines -Encoding utf8
      Set-Content -Path $LogPath -Value $keep -Encoding utf8 -ErrorAction Stop
      $note = "{0}  ROTATE 紀錄檔超過 1 MB，只保留最後 {1} 行" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $LogKeepLines
      Add-Content -Path $LogPath -Value $note -Encoding utf8 -ErrorAction Stop
    }
    Add-Content -Path $LogPath -Value $line -Encoding utf8 -ErrorAction Stop
  } catch {
    # 連紀錄都寫不出去時，至少讓呼叫端看得出有問題。
    Write-Warning "無法寫入 $LogPath：$($_.Exception.Message)"
  }
  Write-Verbose $line
}

# 起一個子行程但**保證不配置主控台視窗**。
# -WindowStyle Hidden 是行程起來之後才隱藏，擋不住那一瞬間的黑窗；
# 只有 ProcessStartInfo.CreateNoWindow 是在建立時就不給視窗
# （bridge/supervisor.ps1 的 Invoke-Hidden 同一個做法）。
# 參數千萬不要叫 $Args——那是自動變數，函式宣告具名參數之後它就是空陣列，
# 子行程會收到零個參數而且完全不報錯（LESSONS L-138）。
function Invoke-ChildRun {
  param([string]$ScriptPath, [int]$RunDays, [int]$RunTailLines, [int]$TimeoutSec = 600)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName  = (Join-Path $PSHOME 'powershell.exe')
  $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $ScriptPath + '" -Days ' + $RunDays + ' -TailLines ' + $RunTailLines
  $psi.UseShellExecute        = $false
  $psi.CreateNoWindow         = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError  = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
    try { $proc.Kill() } catch {}
    return @{ Ok = $false; Code = -1; Err = "逾時 $TimeoutSec 秒，已強制結束" }
  }
  $stdErr = $proc.StandardError.ReadToEnd()
  return @{ Ok = ($proc.ExitCode -eq 0); Code = $proc.ExitCode; Err = $stdErr }
}

# ── 常駐模式 ─────────────────────────────────────────────────────────
# -LoopMinutes N：跑一次、睡 N 分鐘、再跑，直到行程被結束。
#
# 為什麼不用 Windows 工作排程器（2026-08-23 實測，三條路都走過）：
#   1. 一般權限**建不了**排程工作，連建在子資料夾底下都 Access is denied。
#   2. 提權建成互動模式 ＋ wscript 跑 VBS：手動執行那支 VBS 完全正常，
#      但由工作排程器啟動時 wscript 不會動，工作卡在「執行中」。
#   3. 改用 S4U 主體（不論是否登入均執行）：工作回報 Last Result 0，
#      但動作**根本沒被執行**。根因是這個帳號沒有密碼
#      （`net user` 的 Password required = No），而本機原則
#      `LimitBlankPasswordUse = 1` 規定空白密碼帳號只能主控台登入，
#      非互動登入一律擋掉。
# 結論：這台機器上，任何非互動排程都走不通。改成登入時啟動一支常駐迴圈，
# 完全不需要管理員權限，也不會有視窗（由啟動資料夾的 .vbs 隱藏啟動）。
if ($LoopMinutes -gt 0) {
  # 2026-08-24 改寫。原本是 `& $PSCommandPath ...`，註解寫「一次一個子行程」，
  # 但 `&` 呼叫 .ps1 **不會另起行程**，是在同一個 runspace 裡跑——
  # 所以「死掉不影響迴圈」這個保證從來沒成立過，內層的 exit 與
  # $ErrorActionPreference = 'Stop' 都作用在同一個行程上。
  #
  # 而且原本的 catch 只有 Write-Warning。這支由啟動資料夾的 .vbs 以
  # -NonInteractive、隱藏視窗啟動，警告輸出沒有任何地方接得到，失敗完全靜音。
  #
  # 實測後果（B-5）：常駐行程跑了 3 小時 17 分，紀錄檔 0 行、只推送 1 次
  # （照 30 分鐘一輪該有 6 次），而那段時間 Codex 正在大量產生用量。
  #
  # 三個修正：
  #   1. 真的另起子行程（Invoke-ChildRun，CreateNoWindow 不閃黑窗）。
  #   2. 失敗寫進紀錄檔，不是只 Write-Warning。
  #   3. **每一輪都先寫一行 tick**。這條最重要——原本「跑了但沒事做」與
  #      「根本沒跑」在紀錄上長得一模一樣，沉默的成功與沉默的失敗無法區分。
  Write-Log ("LOOP start pid={0} 間隔={1} 分鐘 script={2}" -f $PID, $LoopMinutes, $PSCommandPath)
  $tick = 0
  while ($true) {
    $tick++
    Write-Log ("LOOP tick #{0}" -f $tick)
    try {
      $r = Invoke-ChildRun -ScriptPath $PSCommandPath -RunDays $Days -RunTailLines $TailLines
      if ($r.Ok) {
        Write-Log ("LOOP tick #{0} 子行程結束 exit=0" -f $tick)
      } else {
        $msg = ($r.Err -replace '\s+', ' ')
        if ($msg.Length -gt 300) { $msg = $msg.Substring(0, 300) + '…' }
        Write-Log ("LOOP tick #{0} 子行程失敗 exit={1} err={2}" -f $tick, $r.Code, $msg)
      }
    } catch {
      # 單次失敗不能讓常駐迴圈死掉——網路斷一次就再也不回報了。
      Write-Log ("LOOP tick #{0} 例外：{1}" -f $tick, $_.Exception.Message)
    }
    Start-Sleep -Seconds ($LoopMinutes * 60)
  }
}

# ── 設定 ─────────────────────────────────────────────────────────────
# token 不寫在腳本裡，也不必另外設一個。
# 這台機器為了 Claude Code 遙測已經有 OTEL_EXPORTER_OTLP_HEADERS
#（內容是 "Authorization=Bearer <token>"），接收端是同一把 OTEL_INGEST_TOKEN，
# 所以直接從那裡取用，不要求使用者再貼一次金鑰——少一次人工貼上就少一次貼錯。
# 真要覆寫時才設 COSTSCALE_INGEST_TOKEN。
# 兩個來源都要看「行程環境」與「使用者環境」兩層：setx 設的變數只對之後開的
# 行程生效，排程工作起的行程通常拿得到，但手動在舊終端機裡跑就拿不到——
# 為了這個差異白跑一次很浪費，直接兩層都讀。
function Get-EnvValue {
  param([string]$Name)
  $v = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if (-not $v) { $v = [Environment]::GetEnvironmentVariable($Name, 'User') }
  if (-not $v) { $v = [Environment]::GetEnvironmentVariable($Name, 'Machine') }
  return $v
}

$Token = Get-EnvValue 'COSTSCALE_INGEST_TOKEN'
if (-not $Token) {
  $otelHeaders = Get-EnvValue 'OTEL_EXPORTER_OTLP_HEADERS'
  if ($otelHeaders -match 'Authorization\s*=\s*Bearer\s+(\S+)') { $Token = $Matches[1] }
}
$Endpoint = Get-EnvValue 'COSTSCALE_CLI_USAGE_URL'
if (-not $Endpoint) { $Endpoint = $env:COSTSCALE_ENDPOINT }
if (-not $Endpoint) { $Endpoint = 'https://cost.example.com/api/cli-usage' }
$CodexHome  = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$SessionDir = Join-Path $CodexHome 'sessions'
# 開場先留一行。排程跑起來卻什麼都沒發生時，這一行的有無就是分水嶺：
# 有＝腳本起來了、問題在後面；沒有＝根本沒被執行到。
Write-Log ("START pid={0} user={1} localApp={2} codexHome={3}" -f `
  $PID, $env:USERNAME, $localApp, $env:CODEX_HOME)

if (-not $Token -and -not $DryRun) {
  Write-Log 'ERROR 找不到可用的 token，停止。'
  Write-Error '找不到 token：COSTSCALE_INGEST_TOKEN 沒設，OTEL_EXPORTER_OTLP_HEADERS 也讀不出 Bearer。先跑 scripts/install-codex-usage-task.ps1。'
  exit 1
}
if (-not (Test-Path $SessionDir)) {
  Write-Log "ERROR 找不到 session 目錄：$SessionDir"
  Write-Error "找不到 Codex session 目錄：$SessionDir"
  exit 1
}

# ── 收集 ─────────────────────────────────────────────────────────────

# 挑檔案的依據是「最後寫入時間」，**不是**資料夾的日期。
#
# 這一點初版寫錯過，代價是漏掉 37% 的用量（2026-08-23 實測）：
# rollout 檔是用 session 的**開始日期**歸檔的，一個 8/4 開的 thread
# 今天還在跑，它的檔案永遠留在 2026/08/04 那個資料夾裡。
# 只掃「最近兩天的資料夾」就看不到它——而那一個檔案本身就有 3.12 億 token。
#
# 對照數字：Codex 自己的 state_5.sqlite 認定近兩天有活動的 thread 有 84 個、
# 9.18 億 token；照日期資料夾掃只看得到 69 個、5.78 億，差 15 個檔、3.39 億。
# 改成遞迴整棵樹再依 mtime 篩之後，抓到 85 個，涵蓋完整。
#
# 效能不是問題：整棵樹目前 416 個檔，遞迴列舉只花 0.1 秒——
# Get-ChildItem 只讀目錄項目，不會去開檔案內容。
$cutoff = (Get-Date).AddDays(-$Days)
$files = @(
  Get-ChildItem -Path $SessionDir -Recurse -Filter 'rollout-*.jsonl' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -ge $cutoff }
)

if ($files.Count -eq 0) {
  Write-Log "沒有找到最近 $Days 天內有寫入的 rollout 檔。"
  Write-Output '沒有找到任何 rollout 檔。'
  exit 0
}

function Get-TailFacts {
  # 讀一次檔尾就把兩件事都撈出來：最後一個 token_count 事件、最後一個 turn_context。
  # 分兩次讀等於把 24 MB 的檔案掃兩遍，沒必要。
  # 參數名絕對不能叫 $Args（見檔頭第 3 點）。
  param([string]$Path, [int]$Tail)

  $result = @{ TokenLine = $null; Model = $null }
  $candidates = Get-Content -LiteralPath $Path -Tail $Tail -Encoding UTF8 -ErrorAction SilentlyContinue
  if ($candidates) {
    for ($i = $candidates.Count - 1; $i -ge 0; $i--) {
      $line = $candidates[$i]
      if (-not $result.TokenLine -and $line -like '*"total_token_usage"*') { $result.TokenLine = $line }
      # 模型名不在 session_meta，在 turn_context 事件裡（2026-08-23 確認）。
      if (-not $result.Model -and $line -like '*"type":"turn_context"*') {
        try { $result.Model = ($line | ConvertFrom-Json).payload.model } catch { }
      }
      if ($result.TokenLine -and $result.Model) { break }
    }
  }
  if (-not $result.TokenLine) {
    # 退路：整份掃。只有極短或極特殊的檔會走到這裡。
    $all = Get-Content -LiteralPath $Path -Encoding UTF8 -ErrorAction SilentlyContinue
    if ($all) {
      for ($i = $all.Count - 1; $i -ge 0; $i--) {
        $line = $all[$i]
        if (-not $result.TokenLine -and $line -like '*"total_token_usage"*') { $result.TokenLine = $line }
        if (-not $result.Model -and $line -like '*"type":"turn_context"*') {
          try { $result.Model = ($line | ConvertFrom-Json).payload.model } catch { }
        }
        if ($result.TokenLine -and $result.Model) { break }
      }
    }
  }
  return $result
}

$sessions = New-Object System.Collections.ArrayList
$skipped  = 0

foreach ($f in $files) {
  try {
    # -Encoding UTF8 不能省：Windows PowerShell 5.1 預設用系統碼頁讀檔，
    # Codex 0.153 起 session_meta 帶整段英文系統提示，裡面的「—」「’」會被讀成亂碼，
    # 把後面的引號吃掉，整行 JSON 解析失敗，那個 session 就被跳過。
    $metaLine = Get-Content -LiteralPath $f.FullName -TotalCount 1 -Encoding UTF8 -ErrorAction Stop
    if (-not $metaLine) { $skipped++; continue }
    $meta = $metaLine | ConvertFrom-Json
    if ($meta.type -ne 'session_meta') { $skipped++; continue }

    $facts = Get-TailFacts -Path $f.FullName -Tail $TailLines
    if (-not $facts.TokenLine) { $skipped++; continue }   # 這個 session 一次 API 都沒打過
    $ev = $facts.TokenLine | ConvertFrom-Json
    $usage = $ev.payload.info.total_token_usage
    if (-not $usage) { $skipped++; continue }

    $rl = $ev.payload.rate_limits
    $resetsAt = $null
    if ($rl -and $rl.primary -and $rl.primary.resets_at) {
      # resets_at 是 Unix 秒。轉成 ISO 8601（UTC）再送，伺服器不做時區猜測。
      $resetsAt = ([DateTimeOffset]::FromUnixTimeSeconds([int64]$rl.primary.resets_at)).UtcDateTime.ToString('o')
    }

    $null = $sessions.Add([ordered]@{
      sessionId          = [string]$meta.payload.id
      model              = if ($facts.Model) { [string]$facts.Model } else { $null }
      startedAt          = [string]$meta.payload.timestamp
      lastEventAt        = [string]$ev.timestamp
      inputTokens        = [int64]$usage.input_tokens
      cachedInputTokens  = [int64]$usage.cached_input_tokens
      cacheWriteTokens   = [int64]$usage.cache_write_input_tokens
      outputTokens       = [int64]$usage.output_tokens
      reasoningTokens    = [int64]$usage.reasoning_output_tokens
      totalTokens        = [int64]$usage.total_tokens
      originator         = [string]$meta.payload.originator
      threadSource       = [string]$meta.payload.thread_source
      quotaUsedPct       = if ($rl -and $rl.primary) { [double]$rl.primary.used_percent } else { $null }
      quotaWindowMinutes = if ($rl -and $rl.primary) { [int]$rl.primary.window_minutes } else { $null }
      quotaResetsAt      = $resetsAt
      planType           = if ($rl) { [string]$rl.plan_type } else { $null }
    })
  } catch {
    $skipped++
    Write-Log "WARN 解析失敗 $($f.Name)：$($_.Exception.Message)"
  }
}

if ($sessions.Count -eq 0) {
  Write-Log "沒有任何可回報的 session（掃了 $($files.Count) 檔，跳過 $skipped）。"
  Write-Output '沒有任何可回報的 session。'
  exit 0
}

$body = @{
  source   = 'codex-cli'
  host     = $env:COMPUTERNAME
  sessions = @($sessions)
} | ConvertTo-Json -Depth 6 -Compress

if ($DryRun) {
  Write-Output "DryRun：$($sessions.Count) 個 session（跳過 $skipped），共 $($body.Length) 位元組"
  $sessions | Select-Object -First 3 | ForEach-Object { $_ | ConvertTo-Json -Compress | Write-Output }
  exit 0
}

# ── 送出 ─────────────────────────────────────────────────────────────
# 用管線把 UTF-8 內容交給外部程式會被加上 BOM（LESSONS L-137），
# 這裡走 Invoke-RestMethod 直接送位元組，不經管線。
try {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  $res = Invoke-RestMethod -Uri $Endpoint -Method Post -Body $bytes `
    -ContentType 'application/json; charset=utf-8' `
    -Headers @{ Authorization = "Bearer $Token" } `
    -TimeoutSec 30
  Write-Log ("OK 送出 {0} 個 session，寫入 {1}，跳過 {2}" -f $sessions.Count, $res.written, $skipped)
  Write-Output ("送出 {0} 個 session，伺服器寫入 {1} 筆。" -f $sessions.Count, $res.written)
} catch {
  Write-Log "ERROR 送出失敗：$($_.Exception.Message)"
  Write-Error "送出失敗：$($_.Exception.Message)"
  exit 1
}
