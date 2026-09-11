<#
.SYNOPSIS
  把本機 Claude Code 的 token 用量送到 AI CostScale（2026-09-07）。

.DESCRIPTION
  為什麼要有這一支——遙測那條**漏掉六成**。

  Claude Code 的 OTLP 遙測（`otel_usage`，2026-08-20 起）確實有分模型的 token，
  但同一個時間視窗實測比對：

      08-20 起   遙測 67.2 億   本機紀錄 170.7 億   本機是遙測的 2.54 倍
      05-29 至 08-19   遙測 0        本機紀錄 266.6 億

  漏的痕跡很明顯：`claude-fable-5` 在本機同期有 5.63 億 token，
  而 `otel_usage` 裡**連這個模型都沒出現過**——代表有整批 session 完全沒回報。
  原因推測是那些 session 啟動時沒有帶到 OTLP 的環境變數（**這是假設**，沒有查證）。

  本機紀錄在 `~/.claude/projects/<專案>/<sessionId>.jsonl`，每一則助理訊息帶
  `message.model` 與 `message.usage`（input／output／cache_creation／cache_read），
  是完整的第一手資料，不依賴任何環境變數有沒有設對。

  ── 三個設計決定，都有實測依據 ────────────────────────────────────

  1. **一列一個「(session, 模型)」，不是一列一個 session。**
     實測 316 個有用量的 session 檔裡，**51 個（16.1%）混了多個模型**
     （最多一個檔有 4 種）。若一個 session 只記一個模型，
     會有 **7.17%（31.3 億 token）記到錯的模型頭上**。
     所以 `sessionId` 送 `<uuid>#<模型>`，主鍵 `(source, session_id)` 照樣成立，
     `model` 欄位才會是對的。session 數會因此比檔案數多約 16%，這是刻意的。

  2. **只掃「檔案有變動」的。** 用狀態檔記每個檔的最後寫入時間與大小，
     沒變就整個跳過。第一次回填要掃 25 萬行，之後每輪通常只有個位數個檔。

  3. **`<synthetic>` 這個模型名要濾掉。** 那是 Claude Code 自己塞的佔位訊息，
     token 全部是 0，留著只會在模型排行上多一列沒有意義的東西。

  ── 與 push-codex-usage.ps1 的差別 ────────────────────────────────

  Codex 的 rollout 檔每個 `token_count` 事件帶的是**累計值**，所以那支只讀檔尾。
  Claude Code 的 `usage` 是**每則訊息各自的增量**，必須整份加總，不能只讀檔尾。
  兩者語意相反，不要互相套用。

  送出端點與認證沿用同一套（`/api/cli-usage`、`OTEL_INGEST_TOKEN`），
  不為了一支腳本再發一把 token。

.PARAMETER DryRun
  只印出要送什麼，不真的送。

.PARAMETER Full
  忽略狀態檔，重新掃所有檔案。第一次回填或狀態檔壞掉時用。

.PARAMETER LoopMinutes
  大於 0 時變成常駐迴圈，每隔這麼多分鐘跑一輪。給啟動資料夾的 .vbs 用。

.PARAMETER SinceDays
  只收「最後事件在這幾天內」的 (session, 模型)。預設 0 ＝不限制（全部回填）。
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Full,
  [int]$LoopMinutes = 0,
  [int]$SinceDays = 0
)

$ErrorActionPreference = 'Stop'

# ── 紀錄檔 ───────────────────────────────────────────────────────────
# 位置不要只靠 $env:LOCALAPPDATA（E-26）。排程或非互動情境下那個變數可能是空的，
# Join-Path 會產生相對路徑，檔案落到 system32 然後因為沒有寫入權限而無聲死掉。
$LocalApp = [Environment]::GetFolderPath('LocalApplicationData')
if (-not $LocalApp) { $LocalApp = $env:LOCALAPPDATA }
if (-not $LocalApp -and $env:USERPROFILE) { $LocalApp = Join-Path $env:USERPROFILE 'AppData\Local' }
if (-not $LocalApp) { $LocalApp = $PSScriptRoot }

$LogPath   = Join-Path $LocalApp 'costscale-claude-usage.log'
$StatePath = Join-Path $LocalApp 'costscale-claude-usage-state.json'

function Write-Log([string]$msg) {
  try {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
  } catch { }
}

# 超過 1 MB 只留最後 2000 行。截斷本身也寫一行，不要靜悄悄地掉資料。
try {
  if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt 1MB)) {
    $keep = Get-Content -Path $LogPath -Tail 2000
    Set-Content -Path $LogPath -Value $keep -Encoding UTF8
    Write-Log 'INFO 紀錄檔超過 1 MB，已截斷成最後 2000 行。'
  }
} catch { }

# ── 常駐迴圈 ─────────────────────────────────────────────────────────
# 照 push-codex-usage.ps1 的教訓寫（那支 B-5 事故的三個修正）：
#   1. 用 Start-Process 另起行程，不要用 `&`——`&` 是同一個 runspace，
#      內層的 exit 會把整個迴圈殺掉。
#   2. 每一輪都留痕，成功失敗都寫。靜音的迴圈等於沒有迴圈。
#   3. 迴圈本身不要用 $ErrorActionPreference = 'Stop'。
if ($LoopMinutes -gt 0) {
  Write-Log ('=== 常駐迴圈啟動，每 {0} 分鐘一輪 ===' -f $LoopMinutes)
  $ErrorActionPreference = 'Continue'
  while ($true) {
    try {
      # 路徑要自己加引號。`-ArgumentList` 收陣列時是**用空白串起來、不會補引號**，
      # 而這個專案的路徑含空白（`260818-AI CostScale`），powershell 會把
      # `-File D:\...\260818-AI` 當成檔名、找不到、回 -196608（0xFFFD0000）而且
      # **不會產生任何紀錄**——迴圈看起來在跑，實際上每一輪都什麼都沒做。
      # 2026-09-07 裝好當下就是這樣，靠迴圈自己印退出碼才抓到（B-5 的同一類）。
      $p = Start-Process -FilePath 'powershell.exe' -PassThru -WindowStyle Hidden -Wait `
        -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                        '-File', ('"{0}"' -f $PSCommandPath))
      Write-Log ('迴圈：一輪結束，退出碼 {0}' -f $p.ExitCode)
    } catch {
      Write-Log ('迴圈：這一輪起不來——{0}' -f $_.Exception.Message)
    }
    Start-Sleep -Seconds ($LoopMinutes * 60)
  }
}

# ── 認證與端點 ───────────────────────────────────────────────────────
# 這台機器為了 Claude Code 遙測已經有 OTEL_EXPORTER_OTLP_HEADERS，
# 裡面就是同一把 token，優先從那裡取，不要讓使用者多存一份秘密。
function Get-EnvValue([string]$name) {
  $v = [Environment]::GetEnvironmentVariable($name, 'Process')
  if (-not $v) { $v = [Environment]::GetEnvironmentVariable($name, 'User') }
  if (-not $v) { $v = [Environment]::GetEnvironmentVariable($name, 'Machine') }
  return $v
}

$Token = Get-EnvValue 'COSTSCALE_INGEST_TOKEN'
if (-not $Token) {
  $otelHeaders = Get-EnvValue 'OTEL_EXPORTER_OTLP_HEADERS'
  if ($otelHeaders -match 'Bearer\s+([^\s,;]+)') { $Token = $Matches[1] }
}
$Endpoint = Get-EnvValue 'COSTSCALE_CLI_USAGE_URL'
if (-not $Endpoint) { $Endpoint = $env:COSTSCALE_ENDPOINT }
if (-not $Endpoint) { $Endpoint = 'https://cost.example.com/api/cli-usage' }

if (-not $Token) {
  Write-Log 'ERROR 找不到可用的 token，停止。'
  Write-Error '找不到 token：COSTSCALE_INGEST_TOKEN 沒設，OTEL_EXPORTER_OTLP_HEADERS 也讀不出 Bearer。'
  exit 1
}

# ── 找出要掃的檔 ─────────────────────────────────────────────────────
$ProjectsDir = Join-Path $env:USERPROFILE '.claude\projects'
if (-not (Test-Path $ProjectsDir)) {
  Write-Log ('找不到 Claude Code 的紀錄目錄：{0}' -f $ProjectsDir)
  Write-Output ('找不到 Claude Code 的紀錄目錄：{0}' -f $ProjectsDir)
  exit 0
}

$state = @{}
if (-not $Full -and (Test-Path $StatePath)) {
  try {
    $raw = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($p in $raw.PSObject.Properties) { $state[$p.Name] = $p.Value }
  } catch {
    Write-Log 'WARN 狀態檔解析失敗，這一輪當成全掃。'
  }
}

# 狀態檔的版本標記（2026-09-10）。
# 這一版開始多送「1 小時快取寫入」一欄。舊版狀態檔記著「哪些檔已經送過」，
# 照它跳過的話，舊 session 永遠不會帶著新欄位重送——另外兩台電腦就是這樣：
# 換了新版收集器，資料庫裡它們的列還是缺這一欄。
# 所以狀態檔沒有這個標記時，這一輪當成全掃，全部送成功才寫入標記。
# 不必叫使用者到每一台去手動加 -Full。
$SchemaTag = '2026-09-10-cache-1h'
if ($state['__schema'] -ne $SchemaTag) {
  if ($state.Count -gt 0) {
    Write-Log ('狀態檔是舊版（標記：{0}），這一輪全掃一次，補上 1 小時快取欄位。' -f $state['__schema'])
  }
  $state = @{}
}

$allFiles = @(Get-ChildItem -LiteralPath $ProjectsDir -Recurse -Filter '*.jsonl' -File -ErrorAction SilentlyContinue)
$targets = @()
foreach ($f in $allFiles) {
  $sig = '{0}:{1}' -f $f.LastWriteTimeUtc.Ticks, $f.Length
  if ($state.ContainsKey($f.FullName) -and $state[$f.FullName] -eq $sig) { continue }
  $targets += [pscustomobject]@{ File = $f; Sig = $sig }
}

Write-Log ('掃描：共 {0} 個檔，其中 {1} 個有變動要重讀。' -f $allFiles.Count, $targets.Count)

if ($targets.Count -eq 0) {
  Write-Log '沒有檔案變動，這一輪不送。'
  Write-Output ('沒有檔案變動（共 {0} 個檔）。' -f $allFiles.Count)
  exit 0
}

# ── 解析 ─────────────────────────────────────────────────────────────
# 每則助理訊息各自帶自己的 usage（增量），所以要整份加總。
# 先用字串比對篩掉沒有 usage 的行再 ConvertFrom-Json——那一步很貴，
# 實測 25 萬行裡只有約 10 萬行帶 usage，先篩能省掉六成的解析。
$rows = @{}
$parsed = 0
$badLines = 0

foreach ($t in $targets) {
  $f = $t.File
  try {
    foreach ($line in [System.IO.File]::ReadLines($f.FullName)) {
      if ($line.Length -lt 40) { continue }
      if ($line -notlike '*"usage"*') { continue }
      $d = $null
      try { $d = $line | ConvertFrom-Json } catch { $badLines++; continue }
      $m = $d.message
      if (-not $m) { continue }
      $model = [string]$m.model
      $u = $m.usage
      if (-not $model -or -not $u) { continue }
      if ($model -eq '<synthetic>') { continue }

      $sid = [string]$d.sessionId
      if (-not $sid) { $sid = [IO.Path]::GetFileNameWithoutExtension($f.Name) }
      $key = '{0}#{1}' -f $sid, $model

      $inTok    = [int64]($u.input_tokens                 | ForEach-Object { if ($_) { $_ } else { 0 } })
      $outTok   = [int64]($u.output_tokens                | ForEach-Object { if ($_) { $_ } else { 0 } })
      $cacheW   = [int64]($u.cache_creation_input_tokens  | ForEach-Object { if ($_) { $_ } else { 0 } })
      $cacheR   = [int64]($u.cache_read_input_tokens      | ForEach-Object { if ($_) { $_ } else { 0 } })
      # 1 小時快取與 5 分鐘快取的寫入價不同（2 倍對 1.25 倍輸入價），要分開記。
      # 2026-09-10 實測本機最近 300 個 session：Opus／Fable 的寫入有 99% 以上是 1 小時的，
      # Sonnet 5 與 Haiku 則是 0%——不能用一個固定倍率補，只能逐則記下來。
      # cacheW 仍是寫入總數，這一項是其中屬於 1 小時的部分。
      $cacheW1h = [int64]0
      if ($u.cache_creation -and $u.cache_creation.ephemeral_1h_input_tokens) {
        $cacheW1h = [int64]$u.cache_creation.ephemeral_1h_input_tokens
      }

      $ts = [string]$d.timestamp
      if (-not $rows.ContainsKey($key)) {
        $rows[$key] = [pscustomobject]@{
          SessionId  = $key
          Model      = $model
          First      = $ts
          Last       = $ts
          In         = [int64]0
          Out        = [int64]0
          CacheW     = [int64]0
          CacheW1h   = [int64]0
          CacheR     = [int64]0
          # 從哪個介面跑的。實測本機 318 個檔裡有兩種：
          #   claude-desktop  200,142 次   437.98 億 token
          #   claude-vscode     1,658 次     2.59 億 token（IDE 擴充，含 Antigravity）
          # Antigravity 裝的是 Anthropic 官方的「Claude Code for VS Code」擴充，
          # 內附 resources/native-binary/claude.exe，跑的是同一支 CLI、
          # 寫的是同一個 ~/.claude/projects，所以本來就收得到——
          # 只是先前沒有把「哪個介面」留下來，看不出比例。
          Entry      = $null
        }
      }
      $r = $rows[$key]
      $r.In     += $inTok
      $r.Out    += $outTok
      $r.CacheW += $cacheW
      $r.CacheW1h += $cacheW1h
      $r.CacheR += $cacheR
      # entrypoint 是逐行帶的，取最後看到的那個（與 Codex 收集器取最後一個
      # turn_context 的 model 同一套規則）。同一個 session 換介面很罕見。
      $ep = [string]$d.entrypoint
      if ($ep) { $r.Entry = $ep }
      if ($ts) {
        if (-not $r.First -or $ts -lt $r.First) { $r.First = $ts }
        if (-not $r.Last  -or $ts -gt $r.Last)  { $r.Last  = $ts }
      }
      $parsed++
    }
  } catch {
    Write-Log ('WARN 讀不了 {0}：{1}' -f $f.Name, $_.Exception.Message)
  }
}

Write-Log ('解析：{0} 則帶用量的訊息，湊成 {1} 個 (session, 模型)，解析失敗 {2} 行。' -f $parsed, $rows.Count, $badLines)

# ── 組送出的資料 ─────────────────────────────────────────────────────
$cutoff = $null
if ($SinceDays -gt 0) { $cutoff = (Get-Date).ToUniversalTime().AddDays(-$SinceDays) }

$sessions = @()
foreach ($r in $rows.Values) {
  if (-not $r.First -or -not $r.Last) { continue }
  if ($cutoff) {
    $lastDt = $null
    if (-not [DateTime]::TryParse($r.Last, [ref]$lastDt)) { continue }
    if ($lastDt.ToUniversalTime() -lt $cutoff) { continue }
  }
  $total = $r.In + $r.Out + $r.CacheW + $r.CacheR
  if ($total -le 0) { continue }
  $sessions += [ordered]@{
    sessionId         = $r.SessionId
    model             = $r.Model
    startedAt         = $r.First
    lastEventAt       = $r.Last
    inputTokens       = $r.In
    cachedInputTokens = $r.CacheR
    cacheWriteTokens  = $r.CacheW
    cacheWrite1hTokens = $r.CacheW1h
    outputTokens      = $r.Out
    reasoningTokens   = 0
    totalTokens       = $total
    # originator 存「哪個介面」——claude-desktop、claude-vscode（IDE 擴充）等。
    # 舊資料是寫死的 'claude-code'，那一批分不出介面，會在下一次全掃時被蓋掉。
    originator        = if ($r.Entry) { $r.Entry } else { 'claude-code' }
    threadSource      = 'local-jsonl'
  }
}

if ($sessions.Count -eq 0) {
  Write-Log '沒有任何可回報的 (session, 模型)。'
  Write-Output '沒有任何可回報的資料。'
  exit 0
}

if ($DryRun) {
  Write-Output ('DryRun：{0} 個 (session, 模型)，來自 {1} 個變動的檔' -f $sessions.Count, $targets.Count)
  $sessions | Select-Object -First 3 | ForEach-Object { $_ | ConvertTo-Json -Compress | Write-Output }
  # $sessions 的元素是 [ordered] 雜湊表不是物件，Measure-Object -Property 抓不到，
  # 會回 GenericMeasurePropertyNotFound。自己加。
  $sum = [int64]0
  $models = @{}
  foreach ($s in $sessions) {
    $sum += [int64]$s.totalTokens
    $models[$s.model] = [int64]$models[$s.model] + [int64]$s.totalTokens
  }
  Write-Output ('合計 token：{0:N0}' -f $sum)
  Write-Output '分模型：'
  foreach ($kv in ($models.GetEnumerator() | Sort-Object -Property Value -Descending)) {
    Write-Output ('  {0,-28} {1,18:N0}' -f $kv.Key, $kv.Value)
  }
  exit 0
}

# ── 送出 ─────────────────────────────────────────────────────────────
# 端點一次最多 500 筆，切成每批 400。
# 用管線把 UTF-8 內容交給外部程式會被加上 BOM（L-137），
# 這裡走 Invoke-RestMethod 直接送位元組，不經管線。
$batchSize = 400
$sent = 0
$written = 0
$failed = $false

for ($i = 0; $i -lt $sessions.Count; $i += $batchSize) {
  $chunk = @($sessions[$i..([Math]::Min($i + $batchSize - 1, $sessions.Count - 1))])
  $body = @{
    source   = 'claude-code-local'
    host     = $env:COMPUTERNAME
    sessions = $chunk
  } | ConvertTo-Json -Depth 6 -Compress
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $res = Invoke-RestMethod -Uri $Endpoint -Method Post -Body $bytes `
      -ContentType 'application/json; charset=utf-8' `
      -Headers @{ Authorization = "Bearer $Token" } `
      -TimeoutSec 60
    $sent += $chunk.Count
    $written += [int]$res.written
    Write-Log ('OK 第 {0} 批送出 {1} 筆，寫入 {2}。' -f ([Math]::Floor($i / $batchSize) + 1), $chunk.Count, $res.written)
  } catch {
    $failed = $true
    Write-Log ('ERROR 第 {0} 批送出失敗：{1}' -f ([Math]::Floor($i / $batchSize) + 1), $_.Exception.Message)
    Write-Error ('送出失敗：{0}' -f $_.Exception.Message)
    break
  }
}

# 全部送成功才更新狀態檔。中途失敗就讓下一輪重讀那些檔，
# 寧可重送（端點是冪等的 upsert）也不要漏掉。
if (-not $failed) {
  foreach ($t in $targets) { $state[$t.File.FullName] = $t.Sig }
  $state['__schema'] = $SchemaTag
  try {
    $obj = New-Object psobject
    foreach ($k in $state.Keys) { $obj | Add-Member -NotePropertyName $k -NotePropertyValue $state[$k] -Force }
    $obj | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $StatePath -Encoding UTF8
  } catch {
    Write-Log ('WARN 狀態檔寫入失敗：{0}（下一輪會重掃）' -f $_.Exception.Message)
  }
  Write-Output ('送出 {0} 個 (session, 模型)，伺服器寫入 {1} 筆。' -f $sent, $written)
  exit 0
}

exit 1
