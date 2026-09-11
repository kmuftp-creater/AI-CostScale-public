<#
.SYNOPSIS
  自動偵測這台電腦用過哪些 AI CLI，把收得到用量的都裝起來。

.DESCRIPTION
  偵測結果分三類，每一類都會講清楚：

    已接上   ——  找到了，收集器裝好，開始回報
    沒偵測到 ——  這台沒有用過那個 CLI。不是錯誤，略過就好；
                 以後用了再跑一次這支，它會自動接上
    收不到   ——  CLI 在，但它沒有把 token 數字留在本機，拿不到

  偵測看的是「紀錄資料在不在」，不是「程式有沒有裝」：
  裝了但從來沒用過的 CLI 沒有任何 session 檔，收集器裝了也只會空轉。

  需要兩個值，依序從這些地方找，都沒有才問人：
    儀表板網址：-Url 參數 → 同資料夾的 _url.txt → 使用者環境變數 COSTSCALE_CLI_USAGE_URL
    回報 token：-Token 參數 → 同資料夾的 _token.txt → 使用者環境變數 COSTSCALE_INGEST_TOKEN

.PARAMETER Url
  儀表板網址，例如 https://cost.example.com（伺服器 .env 的 AUTH_URL）。

.PARAMETER Token
  回報用的 token（伺服器 .env 的 OTEL_INGEST_TOKEN）。

.PARAMETER IntervalMinutes
  幾分鐘跑一輪。預設 30。

.PARAMETER Uninstall
  把這支裝過的東西全部移除。
#>
[CmdletBinding()]
param(
  [string]$Url,
  [string]$Token,
  [int]$IntervalMinutes = 30,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot

# 雙擊 .bat 開的視窗，腳本一結束就會關掉，使用者來不及看結果——所以每個結束點都先停下來。
function Done([int]$code) {
  Write-Host ''
  Read-Host '按 Enter 關閉這個視窗' | Out-Null
  exit $code
}

if (-not $Uninstall) {
  Write-Host ''
  Write-Host ' AI CostScale：CLI 用量收集器' -ForegroundColor Cyan
  Write-Host ' 偵測這台電腦用過的 Claude Code、Codex，只回報 token 數字與模型名稱。'
  Write-Host ' 不會送出任何對話內容。沒用過的會自動略過，不是錯誤。'
  Write-Host ''
}

function Line { Write-Host ('─' * 62) -ForegroundColor DarkGray }

function Read-Side([string]$name) {
  $p = Join-Path $Here $name
  if (Test-Path -LiteralPath $p) { return (Get-Content -LiteralPath $p -Raw -Encoding UTF8).Trim() }
  return ''
}

# ── 偵測 ─────────────────────────────────────────────────────────────
function Test-ClaudeCode {
  $d = Join-Path $env:USERPROFILE '.claude\projects'
  if (-not (Test-Path $d)) { return @{ Found = $false } }
  $n = @(Get-ChildItem -LiteralPath $d -Recurse -Filter '*.jsonl' -File -ErrorAction SilentlyContinue).Count
  return @{ Found = ($n -gt 0); Count = $n; Unit = '個會話檔' }
}

function Test-Codex {
  $d = Join-Path $env:USERPROFILE '.codex\sessions'
  if (-not (Test-Path $d)) { return @{ Found = $false } }
  $n = @(Get-ChildItem -LiteralPath $d -Recurse -Filter 'rollout-*.jsonl' -File -ErrorAction SilentlyContinue).Count
  return @{ Found = ($n -gt 0); Count = $n; Unit = '個 session 檔' }
}

function Test-Antigravity {
  $dirs = @('.gemini\antigravity-ide\conversations', '.gemini\antigravity-cli\conversations') |
    ForEach-Object { Join-Path $env:USERPROFILE $_ } | Where-Object { Test-Path $_ }
  if (-not $dirs) { return @{ Found = $false } }
  $n = 0
  foreach ($d in $dirs) {
    $n += @(Get-ChildItem -LiteralPath $d -Filter '*.db' -File -ErrorAction SilentlyContinue).Count
  }
  return @{ Found = ($n -gt 0); Count = $n; Unit = '個對話資料庫' }
}

# ── 移除 ─────────────────────────────────────────────────────────────
if ($Uninstall) {
  Write-Host '移除所有收集器…'
  foreach ($s in @('install-claude-usage-task.ps1', 'install-codex-usage-task.ps1')) {
    $p = Join-Path $Here $s
    if (Test-Path $p) {
      Write-Host "  $s"
      & $p -Uninstall 2>&1 | ForEach-Object { Write-Host "    $_" }
    }
  }
  Write-Host '完成。已經送出去的資料不會被刪，那些在伺服器上。' -ForegroundColor Green
  Done 0
}

# ── 儀表板網址 ───────────────────────────────────────────────────────
if (-not $Url) { $Url = Read-Side '_url.txt' }
if (-not $Url) {
  $v = [Environment]::GetEnvironmentVariable('COSTSCALE_CLI_USAGE_URL', 'User')
  if ($v) { $Url = $v }
}
if (-not $Url) {
  Write-Host ''
  Write-Host '請輸入 AI CostScale 儀表板的網址（伺服器 .env 裡的 AUTH_URL）。' -ForegroundColor Yellow
  $Url = (Read-Host '  例如 https://cost.example.com').Trim()
}
$Url = $Url.Trim().Trim('"').TrimEnd('/')
if ($Url -notmatch '^https?://') { Write-Host "網址要以 https:// 開頭：$Url" -ForegroundColor Red; Done 1 }
# 使用者給的是儀表板網址；已經帶了 /api/cli-usage 的也照收
if ($Url -notmatch '/api/cli-usage$') { $Url = "$Url/api/cli-usage" }
[Environment]::SetEnvironmentVariable('COSTSCALE_CLI_USAGE_URL', $Url, 'User')
$env:COSTSCALE_CLI_USAGE_URL = $Url

# ── token（先解一次，兩支收集器共用）────────────────────────────────
if (-not $Token) { $Token = Read-Side '_token.txt' }
if (-not $Token) {
  foreach ($scope in @('Process', 'User', 'Machine')) {
    $v = [Environment]::GetEnvironmentVariable('COSTSCALE_INGEST_TOKEN', $scope)
    if ($v) { $Token = $v; break }
    $h = [Environment]::GetEnvironmentVariable('OTEL_EXPORTER_OTLP_HEADERS', $scope)
    if ($h -and $h -match 'Bearer\s+([^\s,;]+)') { $Token = $Matches[1]; break }
  }
}
if (-not $Token) {
  Write-Host ''
  Write-Host '請貼上回報用的 token（伺服器 .env 裡的 OTEL_INGEST_TOKEN）。' -ForegroundColor Yellow
  $Token = (Read-Host '  token').Trim()
}
if (-not $Token) { Write-Host '沒有 token，安裝中止。' -ForegroundColor Red; Done 1 }
if ($Token -match '^[<"''].*[>"'']$') {
  Write-Host 'token 前後有角括號或引號。只貼值本身，不要連符號一起貼。' -ForegroundColor Red
  Done 1
}
[Environment]::SetEnvironmentVariable('COSTSCALE_INGEST_TOKEN', $Token, 'User')
$env:COSTSCALE_INGEST_TOKEN = $Token

# ── 先確認網址與 token 對不對，不對就不裝 ────────────────────────────
# 送一個空批次：token 錯回 401、端點停用回 503、網址錯連不上，都在這裡擋下來。
try {
  $null = Invoke-RestMethod -Uri $Url -Method Post -ContentType 'application/json' -Body '{"rows":[]}' `
    -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 20
  Write-Host "連線確認：$Url 可以回報。" -ForegroundColor Green
} catch {
  $code = $null
  if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
  if ($code -eq 400) {
    Write-Host "連線確認：$Url 認得這個 token。" -ForegroundColor Green
  } else {
    $why = switch ($code) {
      401 { 'token 不對（伺服器回 401）。確認貼的是 OTEL_INGEST_TOKEN。' }
      403 { 'token 不對（伺服器回 403）。確認貼的是 OTEL_INGEST_TOKEN。' }
      404 { '網址不對（伺服器回 404）。填的應該是儀表板網址，例如 https://cost.example.com。' }
      503 { '伺服器沒有啟用回報（回 503）：伺服器 .env 的 OTEL_INGEST_TOKEN 是空的。' }
      default { "連不上：$($_.Exception.Message)" }
    }
    Write-Host "無法回報到 $Url。$why" -ForegroundColor Red
    Done 1
  }
}

# ── 開跑 ─────────────────────────────────────────────────────────────
Write-Host ''
Line
Write-Host " 這台電腦：$env:COMPUTERNAME" -ForegroundColor Cyan
Line
Write-Host ''

$claude = Test-ClaudeCode
$codex  = Test-Codex
$agy    = Test-Antigravity

$installed = @()
$skipped   = @()
$cannot    = @()

if ($claude.Found) {
  Write-Host "[Claude Code] 找到 $($claude.Count) $($claude.Unit)，開始安裝…" -ForegroundColor Green
  & (Join-Path $Here 'install-claude-usage-task.ps1') -IntervalMinutes $IntervalMinutes -Token $Token 2>&1 |
    ForEach-Object { Write-Host "   $_" }
  if ($LASTEXITCODE -eq 0 -or $null -eq $LASTEXITCODE) { $installed += 'Claude Code' }
  else { $cannot += 'Claude Code（安裝失敗，看上面的訊息）' }
} else {
  Write-Host '[Claude Code] 這台沒有用過，略過。' -ForegroundColor DarkGray
  $skipped += 'Claude Code'
}
Write-Host ''

if ($codex.Found) {
  Write-Host "[Codex] 找到 $($codex.Count) $($codex.Unit)，開始安裝…" -ForegroundColor Green
  & (Join-Path $Here 'install-codex-usage-task.ps1') -IntervalMinutes $IntervalMinutes 2>&1 | ForEach-Object { Write-Host "   $_" }
  if ($LASTEXITCODE -eq 0 -or $null -eq $LASTEXITCODE) { $installed += 'Codex' }
  else { $cannot += 'Codex（安裝失敗，看上面的訊息）' }
} else {
  Write-Host '[Codex] 這台沒有用過，略過。' -ForegroundColor DarkGray
  $skipped += 'Codex'
}
Write-Host ''

if ($agy.Found) {
  Write-Host "[Antigravity] 找到 $($agy.Count) $($agy.Unit)，但收不到 token。" -ForegroundColor Yellow
  Write-Host '   它把對話存成 SQLite，token 數字在沒有欄位名的 protobuf 裡，'
  Write-Host '   本機沒有任何地方留下可讀的 token 數。'
  $cannot += 'Antigravity（本機沒有留 token 數字）'
} else {
  Write-Host '[Antigravity] 這台沒有用過，略過。' -ForegroundColor DarkGray
  $skipped += 'Antigravity'
}

# ── 總結 ─────────────────────────────────────────────────────────────
Write-Host ''
Line
Write-Host ' 結果' -ForegroundColor Cyan
Line
if ($installed) { Write-Host ('  已接上並開始回報：' + ($installed -join '、')) -ForegroundColor Green }
if ($skipped)   { Write-Host ('  這台沒有用過、略過：' + ($skipped -join '、')) -ForegroundColor DarkGray }
if ($cannot)    { Write-Host ('  收不到：' + ($cannot -join '、')) -ForegroundColor Yellow }
Write-Host ''
if ($skipped) {
  Write-Host '  以後在這台用了上面「略過」的那幾個，再跑一次這個安裝就會自動接上。'
  Write-Host ''
}
Write-Host '  紀錄檔在 %LOCALAPPDATA%，檔名 costscale-*-usage.log。'
Write-Host '  確認真的在跑：紀錄檔最後幾行要有「解析」「送出」與「退出碼 0」。'
Write-Host ''
if (-not $installed) { Write-Host '  這台沒有任何可收集的 CLI，什麼都沒裝。' -ForegroundColor Yellow }
Done 0
