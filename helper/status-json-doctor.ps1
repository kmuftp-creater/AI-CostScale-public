<#
.SYNOPSIS
  看板 status.json 體檢與清理工具（可帶著走，單檔、零相依）。

.DESCRIPTION
  AI CostScale 的專案看板（https://cost.example.com/projects）只讀每個專案的
  doc/status.json。實務上那支檔案很容易被歷次收工總結灌爆——2026-08-23 在主力
  電腦上實測 20 支合計 894 KB，其中一支 484 KB、裡面有 169 個看板根本讀不到的
  欄位。這支工具就是把那次的清理流程整理成可重複執行的東西。

  三條紀律，程式強制執行，不是靠自律：
    1. 移除的內容一字不刪。先原文照錄到該專案的
       doc/backup-<日期>-status-json-清理備存.md，再動 status.json。
    2. notes 絕對不動。那是唯一的人工欄位。
    3. updatedAt 絕對不動。清理沒有改變專案的實際進度，動它會讓看板
       誤以為有新工作。寫入後會回頭比對這兩欄，對不上就中止。

  自動處理（機械性、無需判斷）：
    - category 收進受控七類
    - 移除非 schema 欄位
    - cycles 超過 12 筆 → 最近 8 筆＋一筆指向備存文件，每筆只留第一句
    - host／path 空白時依實際位置補上

  不自動處理（需要人判斷，工具只會列清單）：
    - summary 超過 100 字
    - progress 超過 500 字
    這兩欄要壓縮就得決定「什麼是重點」，程式硬截會截出半句話。
    工具會產生「需要人工改寫.md」，把原文與建議一併列出；
    改好的內容放進 overrides.json 再跑一次 -Apply 就會套用。

.PARAMETER Root
  要掃描的根目錄。預設是這支腳本的上兩層（適合放在專案資料夾裡）。
  例：-Root 'D:\Claude'

.PARAMETER Apply
  真的寫入。不加這個參數就只體檢不改東西。

.PARAMETER Push
  套用後順便推送到看板（需要本機已安裝 push-status.ps1）。

.PARAMETER PushScript
  **通常不需要給。** `-Push` 預設由這支工具自己送出，不依賴 push-status.ps1。

  推送設定是**每個使用者一份**、放在 `%USERPROFILE%\.apphub-push.json`
  （由安裝包的 `setup.bat` 產生），跟腳本放在哪個資料夾無關。
  所以只要那台機器設定過，這支工具自己就推得動。

  真的想改用外部的 push-status.ps1 才給這個參數。

.PARAMETER Depth
  往下找幾層。預設 3。有些專案的 status.json 藏得比較深
  （例如 `<專案>\<子資料夾>\doc\status.json`），掃不到就加大這個值。

.PARAMETER Only
  只處理指定的專案（比對 status.json 的 `name` 欄位，可給多個）。
  同一個資料夾底下有些專案要清、有些不要動的時候用這個。
  例：-Only backup-job

.PARAMETER Exclude
  跳過指定的專案（同樣比對 `name`，可給多個）。
  例：-Exclude claude-harness,260708-Auto-Line

.PARAMETER FixHostPath
  把 `host`／`path` 改成「這支 status.json 實際所在的位置」。

  預設**只報告不修改**：那兩欄有值但指到別的地方時，工具會列出來讓你看，
  但不會動它——有值代表有人刻意寫過，不該被工具無聲改掉。

  什麼時候該加這個旗標：看板用 `path` 開專案資料夾、用 `host` 標示在哪台機器，
  所以指到部署目的地（例如 VPS 的 /var/www/...）雖然「有意義」，
  對看板來說是錯的，按了會開不起來。確認要改再加。

.EXAMPLE
  # 只體檢，什麼都不改
  .\status-json-doctor.ps1 -Root 'D:\Claude'

.EXAMPLE
  # 套用機械性修正並推送
  .\status-json-doctor.ps1 -Root 'D:\Claude' -Apply -Push
#>
[CmdletBinding()]
param(
  [string]$Root,
  [switch]$Apply,
  [switch]$Push,
  [string]$PushScript,
  [int]$Depth = 3,
  [switch]$FixHostPath,
  [string[]]$Only,
  [string[]]$Exclude
)

$ErrorActionPreference = 'Stop'

# ── 規格 ─────────────────────────────────────────────────────────────
$SCHEMA = @('name','title','status','category','summary','progress','notes',
            'host','path','apps','links','cycles','tags','updatedAt','completedAt')
$CATEGORIES = @('AI 工具','行銷工具','網站','教學','工具','基礎建設','其他')
$MAX_SUMMARY  = 100
$MAX_PROGRESS = 500
$CYCLE_KEEP   = 8
$CYCLE_NOTE   = 120
$STAMP        = Get-Date -Format 'yyyyMMdd'
$DOCNAME      = "backup-$STAMP-status-json-清理備存.md"

# 常見的自創分類 → 受控七類。對不上的不會亂猜，會列進報告請人決定。
$CATMAP = @{
  'ERP'='工具'; 'Utility'='工具'; '小工具'='工具'; '工具程式'='工具'
  'Windows 桌面工具'='工具'
  '資料備份與知識庫建置'='工具'; '備份'='工具'; '知識庫'='工具'
  '簡報'='教學'; '教學工具'='教學'; '課程'='教學'
  'Infrastructure'='基礎建設'; '開發環境'='基礎建設'; '環境維運'='基礎建設'
  'AI 基礎建設'='基礎建設'; '維運'='基礎建設'
  'AI 自動化'='AI 工具'; 'AI SaaS / 電商工具'='AI 工具'; 'AI 提示詞工程'='AI 工具'
  'AI 應用'='AI 工具'; 'AI'='AI 工具'
  'SaaS 工具'='網站'; 'SaaS'='網站'; 'Personal Brand'='網站'; '網站開發'='網站'
  '個人品牌'='網站'
  '行銷'='行銷工具'; 'Marketing'='行銷工具'
}

if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
if (-not (Test-Path $Root)) { Write-Error "找不到根目錄：$Root"; exit 1 }

# ── 自己寫 JSON，不用 ConvertTo-Json ─────────────────────────────────
# PowerShell 5.1 的 ConvertTo-Json 會把 < > & ' 逸出成 \u003c 這種東西
# （2026-08-23 實測）。那會把 "Next.js & PostgreSQL" 這類文字寫壞，
# 而且是靜默的——檔案仍是合法 JSON，只是內容變了。所以自己寫。
function ConvertTo-JsonEscaped {
  param([string]$Text)
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $Text.ToCharArray()) {
    $code = [int]$ch
    switch ($ch) {
      '"'  { [void]$sb.Append('\"'); continue }
      '\'  { [void]$sb.Append('\\'); continue }
      "`b" { [void]$sb.Append('\b');  continue }
      "`f" { [void]$sb.Append('\f');  continue }
      "`n" { [void]$sb.Append('\n');  continue }
      "`r" { [void]$sb.Append('\r');  continue }
      "`t" { [void]$sb.Append('\t');  continue }
      default {
        if ($code -lt 32) { [void]$sb.Append(('\u{0:x4}' -f $code)) }
        else { [void]$sb.Append($ch) }
      }
    }
  }
  return $sb.ToString()
}

function ConvertTo-JsonText {
  param($Value, [int]$Indent = 0)
  $pad = ' ' * $Indent
  $pad2 = ' ' * ($Indent + 2)
  if ($null -eq $Value) { return 'null' }
  if ($Value -is [bool]) { if ($Value) { return 'true' } else { return 'false' } }
  if ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) {
    return ([string]$Value)
  }
  if ($Value -is [string]) { return '"' + (ConvertTo-JsonEscaped $Value) + '"' }
  if ($Value -is [System.Collections.IDictionary]) {
    if ($Value.Count -eq 0) { return '{}' }
    $items = foreach ($k in $Value.Keys) {
      $pad2 + '"' + (ConvertTo-JsonEscaped ([string]$k)) + '": ' + (ConvertTo-JsonText $Value[$k] ($Indent + 2))
    }
    return "{`n" + ($items -join ",`n") + "`n$pad}"
  }
  if ($Value -is [System.Management.Automation.PSCustomObject]) {
    $props = $Value.PSObject.Properties
    if (-not $props) { return '{}' }
    $items = foreach ($p in $props) {
      $pad2 + '"' + (ConvertTo-JsonEscaped $p.Name) + '": ' + (ConvertTo-JsonText $p.Value ($Indent + 2))
    }
    if (-not $items) { return '{}' }
    return "{`n" + ($items -join ",`n") + "`n$pad}"
  }
  if ($Value -is [System.Collections.IEnumerable]) {
    $arr = @($Value)
    if ($arr.Count -eq 0) { return '[]' }
    $items = foreach ($v in $arr) { $pad2 + (ConvertTo-JsonText $v ($Indent + 2)) }
    return "[`n" + ($items -join ",`n") + "`n$pad]"
  }
  return '"' + (ConvertTo-JsonEscaped ([string]$Value)) + '"'
}

function Get-FirstSentence {
  param([string]$Text, [int]$Limit)
  if (-not $Text) { return '' }
  $t = ($Text -replace '\s+', ' ').Trim()
  # 全形句號後面不會有空白，所以不能一律要求「標點＋空白」——那會讓 .*? 一路
  # 貪到最後一個句號，等於整段都留下來（2026-08-23 用測試夾具抓到）。
  # 全形標點直接斷句；半形 . ! ? 才要求後面是空白或結尾，免得把 Next.js 斷開。
  $m = [regex]::Match($t, '^.*?(?:[。！？]|[.!?](?=\s|$))')
  $out = if ($m.Success) { $m.Value.Trim() } else { $t }
  if ($out.Length -gt $Limit) { $out = $out.Substring(0, $Limit).TrimEnd() + '…' }
  return $out
}

# ── 掃描 ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host "=== status.json 體檢 ===" -ForegroundColor Cyan
Write-Host "根目錄：$Root（往下 $Depth 層）"
Write-Host "模式：$(if ($Apply) { '套用變更' } else { '只體檢，不改任何東西' })" -ForegroundColor $(if ($Apply) { 'Yellow' } else { 'Green' })
Write-Host ''

$files = Get-ChildItem -Path $Root -Recurse -Depth $Depth -Filter 'status.json' -File -ErrorAction SilentlyContinue |
  # git worktree 底下各有一份 status.json，同一個專案會被算成好幾支（E-32）。
  # 那些不會推上看板，掃到只會產生假警報，這裡一併排除。
  Where-Object { $_.Directory.Name -eq 'doc' -and $_.FullName -notmatch '\\(node_modules|\.worktrees|\.claude\\worktrees)\\' }

if (-not $files) { Write-Host '找不到任何 doc/status.json。' -ForegroundColor Yellow; exit 0 }
Write-Host ("找到 {0} 支 status.json" -f @($files).Count)
if ($Only)    { Write-Host ("只處理：{0}" -f ($Only -join '、')) -ForegroundColor Cyan }
if ($Exclude) { Write-Host ("跳過：{0}" -f ($Exclude -join '、')) -ForegroundColor Cyan }
Write-Host ''

# overrides.json：人工改寫過的 summary／progress 放這裡
$ovPath = Join-Path $Root 'status-json-overrides.json'
$ov = @{}
if (Test-Path $ovPath) {
  try {
    $raw = Get-Content -LiteralPath $ovPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($p in $raw.PSObject.Properties) { $ov[$p.Name] = $p.Value }
    Write-Host ("讀到 overrides.json，涵蓋 {0} 個專案。" -f $ov.Count) -ForegroundColor Green
  } catch { Write-Host "overrides.json 解析失敗，忽略：$($_.Exception.Message)" -ForegroundColor Yellow }
}

$report = New-Object System.Collections.ArrayList
$manual = New-Object System.Collections.ArrayList
$changedDirs = New-Object System.Collections.ArrayList
$namedDirs = New-Object System.Collections.ArrayList
$totalBefore = 0; $totalAfter = 0

foreach ($f in $files) {
  $projRoot = Split-Path -Parent $f.Directory.FullName
  $size0 = $f.Length
  # 原檔有沒有 BOM 要記下來，寫回去時保持一致。
  # 這批檔案兩種都有：PowerShell 讀得動兩種，但 Python 的 json.load 用一般
  # utf-8 開會被 BOM 噎到（Unexpected UTF-8 BOM）。擅自加上或拿掉都可能
  # 弄壞別人既有的讀檔流程，所以照原樣。
  $head = [System.IO.File]::ReadAllBytes($f.FullName) | Select-Object -First 3
  $hadBom = ($head.Count -eq 3 -and $head[0] -eq 0xEF -and $head[1] -eq 0xBB -and $head[2] -eq 0xBF)
  try { $d = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { Write-Host ("  [讀取失敗] {0}：{1}" -f $f.FullName, $_.Exception.Message) -ForegroundColor Red; continue }
  if (-not $d.name) { continue }

  $name = [string]$d.name
  if ($Only -and ($Only -notcontains $name)) { continue }
  # -Only 是「我指名要處理這幾個」。即使這一輪沒有東西要改，
  # 使用者加了 -Push 就是想把它送上看板——檔案早就對了、看板還沒更新
  # 正是最常見的情況。所以指名的專案一律列入推送清單。
  if ($Only -and ($Only -contains $name)) { [void]$namedDirs.Add($projRoot) }
  if ($Exclude -and ($Exclude -contains $name)) {
    Write-Host ("  [依 -Exclude 跳過] {0}" -f $name) -ForegroundColor DarkGray
    continue
  }
  $props = @($d.PSObject.Properties.Name)
  $extras = @($props | Where-Object { $SCHEMA -notcontains $_ })
  $cycles = @($d.cycles)
  $sumLen = ([string]$d.summary).Length
  $progLen = ([string]$d.progress).Length
  $cat = [string]$d.category

  $issues = New-Object System.Collections.ArrayList
  $catNew = $null
  if ($cat -and ($CATEGORIES -notcontains $cat)) {
    if ($CATMAP.ContainsKey($cat)) { $catNew = $CATMAP[$cat]; [void]$issues.Add("category $cat→$catNew") }
    else { [void]$issues.Add("category「$cat」不在受控七類、也沒有對應規則（需人工決定）") }
  }
  if ($extras.Count -gt 0)      { [void]$issues.Add("非 schema 欄位 $($extras.Count) 個") }
  if ($cycles.Count -gt 12)     { [void]$issues.Add("cycles $($cycles.Count) 筆") }
  if ($sumLen -gt $MAX_SUMMARY) { [void]$issues.Add("summary $sumLen 字（需人工改寫）") }
  if ($progLen -gt $MAX_PROGRESS) { [void]$issues.Add("progress $progLen 字（需人工改寫）") }
  $fillHost = -not ([string]$d.host).Trim()
  $fillPath = -not ([string]$d.path).Trim()
  if ($fillHost) { [void]$issues.Add('host 空白') }
  if ($fillPath) { [void]$issues.Add('path 空白') }

  # 有值但指到別的地方。比對前先正規化：斜線方向、結尾斜線、大小寫都不算差異。
  $norm = { param($x) ([string]$x).Trim().Replace('/', '\').TrimEnd('\').ToLowerInvariant() }
  $hostWrong = (-not $fillHost) -and (([string]$d.host).Trim() -ne $env:COMPUTERNAME)
  $pathWrong = (-not $fillPath) -and ((& $norm $d.path) -ne (& $norm $projRoot))
  if ($hostWrong) { [void]$issues.Add("host 寫 $($d.host)，檔案實際在 $env:COMPUTERNAME$(if ($FixHostPath) { '（會改）' } else { '（只報告）' })") }
  if ($pathWrong) { [void]$issues.Add("path 指到別處$(if ($FixHostPath) { '（會改）' } else { '（只報告）' })") }

  if ($issues.Count -eq 0) { continue }
  [void]$report.Add([pscustomobject]@{ 專案=$name; 位元組=$size0; 問題=($issues -join '、') })
  $totalBefore += $size0

  # 需要人工改寫的，記下來（若 overrides 已提供就不記）
  $ovSum = $null; $ovProg = $null
  if ($ov.ContainsKey($name)) {
    if ($ov[$name].summary)  { $ovSum  = [string]$ov[$name].summary }
    if ($ov[$name].progress) { $ovProg = [string]$ov[$name].progress }
  }
  if ($sumLen -gt $MAX_SUMMARY -and -not $ovSum) {
    [void]$manual.Add([pscustomobject]@{ 專案=$name; 欄位='summary'; 現長=$sumLen; 上限=$MAX_SUMMARY; 原文=[string]$d.summary })
  }
  if ($progLen -gt $MAX_PROGRESS -and -not $ovProg) {
    [void]$manual.Add([pscustomobject]@{ 專案=$name; 欄位='progress'; 現長=$progLen; 上限=$MAX_PROGRESS; 原文=[string]$d.progress })
  }

  if (-not $Apply) { $totalAfter += $size0; continue }

  # ── 備份 ──
  $bak = "$($f.FullName).bak-$STAMP"
  if (-not (Test-Path $bak)) { Copy-Item -LiteralPath $f.FullName -Destination $bak }

  # ── 備存文件（有東西被移除才寫）──
  $needDoc = ($extras.Count -gt 0) -or ($cycles.Count -gt 12) -or ($ovSum -and $sumLen -gt $MAX_SUMMARY) -or ($ovProg -and $progLen -gt $MAX_PROGRESS)
  if ($needDoc) {
    $md = New-Object System.Collections.ArrayList
    [void]$md.Add("# status.json 清理備存（$(Get-Date -Format 'yyyy-MM-dd')）`r`n")
    [void]$md.Add("看板只讀 ``doc/status.json``，而這支檔案原本是 $size0 位元組。依看板的欄位紀律收斂後，**被移除的內容一字不刪，全部收錄在下面**。`r`n")
    [void]$md.Add("原始檔備份：``doc/status.json.bak-$STAMP``。`r`n")
    if ($ovSum -and $sumLen -gt $MAX_SUMMARY) {
      [void]$md.Add("`r`n## 原本的 summary（$sumLen 字）`r`n`r`n``````$([char]10)$($d.summary)$([char]10)```````r`n")
    }
    if ($ovProg -and $progLen -gt $MAX_PROGRESS) {
      [void]$md.Add("`r`n## 原本的 progress（$progLen 字）`r`n`r`n``````$([char]10)$($d.progress)$([char]10)```````r`n")
    }
    if ($cycles.Count -gt 12) {
      [void]$md.Add("`r`n## 原本的 cycles（$($cycles.Count) 筆，原文照錄）`r`n")
      $i = 0
      foreach ($c in $cycles) {
        $i++
        [void]$md.Add("`r`n**$i.** start=``$($c.start)`` end=``$($c.end)```r`n`r`n> $(($c.note -replace '\r?\n',' '))`r`n")
      }
    }
    if ($extras.Count -gt 0) {
      [void]$md.Add("`r`n## 非 schema 欄位（$($extras.Count) 個，看板讀不到，原文照錄）`r`n")
      foreach ($k in ($extras | Sort-Object)) {
        $v = $d.$k
        $body = if ($v -is [string]) { $v } else { ConvertTo-JsonText $v 0 }
        [void]$md.Add("`r`n### ``$k```r`n`r`n``````$([char]10)$body$([char]10)```````r`n")
      }
    }
    $docPath = Join-Path $f.Directory.FullName $DOCNAME
    [System.IO.File]::WriteAllText($docPath, ($md -join ''), (New-Object System.Text.UTF8Encoding $true))
  }

  # ── 組出新的 status.json（固定 15 個欄位、固定順序）──
  $new = [ordered]@{}
  foreach ($k in $SCHEMA) {
    $v = if ($props -contains $k) { $d.$k } else { '' }
    if ($null -eq $v) { $v = '' }
    $new[$k] = $v
  }
  if ($catNew)  { $new['category'] = $catNew }
  if ($ovSum)   { $new['summary']  = $ovSum }
  if ($ovProg)  { $new['progress'] = $ovProg }
  if ($fillHost -or ($hostWrong -and $FixHostPath)) { $new['host'] = $env:COMPUTERNAME }
  if ($fillPath -or ($pathWrong -and $FixHostPath)) { $new['path'] = $projRoot }
  # 四個陣列欄位要正規化成陣列，但**絕對不能整個換掉**。
  # ConvertFrom-Json 對「只有一個元素的陣列」會拆成單一物件回來，
  # 那個物件不是 IEnumerable——早期版本在這裡直接塞 @() 進去，
  # 結果只有一筆 link 的專案 links 會被清空（2026-08-23 用測試夾具抓到）。
  # 正解是 @($v)：陣列維持陣列，單一物件包成一元素陣列，null 才給空陣列。
  foreach ($k in @('apps','links','cycles','tags')) {
    $v = $new[$k]
    if ($null -eq $v) { $new[$k] = @() }
    elseif ($v -is [string]) { if ($v.Trim()) { $new[$k] = @($v) } else { $new[$k] = @() } }
    else { $new[$k] = @($v) }
  }
  if ($cycles.Count -gt 12) {
    $kept = @($cycles | Sort-Object -Property start -Descending | Select-Object -First $CYCLE_KEEP)
    $trim = foreach ($c in $kept) {
      [ordered]@{ start = [string]$c.start; end = [string]$c.end; note = (Get-FirstSentence ([string]$c.note) $CYCLE_NOTE) }
    }
    $trim = @($trim) + @([ordered]@{ start=''; end=''; note="（更早的 $($cycles.Count - $CYCLE_KEEP) 筆與每一筆的完整內容見 doc/$DOCNAME）" })
    $new['cycles'] = $trim
  }

  $text = (ConvertTo-JsonText $new 0) + "`r`n"
  [System.IO.File]::WriteAllText($f.FullName, $text, (New-Object System.Text.UTF8Encoding $hadBom))

  # ── 寫完回頭驗：notes 與 updatedAt 一個字都不能變 ──
  $chk = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$chk.notes -ne [string]$d.notes) {
    Copy-Item -LiteralPath $bak -Destination $f.FullName -Force
    Write-Error "「$name」的 notes 被改到了，已從備份還原。停止。"; exit 1
  }
  if ([string]$chk.updatedAt -ne [string]$d.updatedAt) {
    Copy-Item -LiteralPath $bak -Destination $f.FullName -Force
    Write-Error "「$name」的 updatedAt 被改到了，已從備份還原。停止。"; exit 1
  }

  $size1 = (Get-Item -LiteralPath $f.FullName).Length
  $totalAfter += $size1
  [void]$changedDirs.Add($projRoot)
  Write-Host ("  [已處理] {0,-32} {1,8} → {2,-8} {3}" -f $name, $size0, $size1, ($issues -join '、')) -ForegroundColor Green
}

# ── 報告 ─────────────────────────────────────────────────────────────
Write-Host ''
if ($report.Count -eq 0) {
  Write-Host '全部通過，沒有需要處理的 status.json。' -ForegroundColor Green
  exit 0
}
Write-Host ("有問題的專案：{0} 個" -f $report.Count) -ForegroundColor Yellow
$report | Sort-Object 位元組 -Descending | Format-Table -AutoSize -Wrap
if ($Apply) {
  Write-Host ("合計 {0:N0} → {1:N0} 位元組" -f $totalBefore, $totalAfter) -ForegroundColor Green
}

$reportPath = Join-Path $Root "status-json-doctor-報告-$STAMP.md"
$rl = New-Object System.Collections.ArrayList
[void]$rl.Add("# status.json 體檢報告（$(Get-Date -Format 'yyyy-MM-dd HH:mm')）`r`n")
[void]$rl.Add("`r`n根目錄：``$Root``　機器：``$env:COMPUTERNAME``　模式：$(if ($Apply) { '已套用' } else { '只體檢' })`r`n")
[void]$rl.Add("`r`n| 專案 | 位元組 | 問題 |`r`n|---|---|---|`r`n")
foreach ($r in ($report | Sort-Object 位元組 -Descending)) {
  [void]$rl.Add("| $($r.專案) | $($r.位元組) | $($r.問題) |`r`n")
}
[System.IO.File]::WriteAllText($reportPath, ($rl -join ''), (New-Object System.Text.UTF8Encoding $true))
Write-Host "報告：$reportPath"

# ── 需要人工改寫的清單 ──
if ($manual.Count -gt 0) {
  $manualPath = Join-Path $Root "需要人工改寫-$STAMP.md"
  $ml = New-Object System.Collections.ArrayList
  [void]$ml.Add("# 需要人工改寫的欄位（$(Get-Date -Format 'yyyy-MM-dd')）`r`n")
  [void]$ml.Add(@"

這幾個欄位太長，但**工具刻意不自動壓縮**——要壓縮就得決定「什麼是重點」，
程式硬截會截出半句話。請人或該機器上的 AI 改寫，然後放進根目錄的
``status-json-overrides.json``，再跑一次 ``-Apply`` 就會套用（原文會自動備存）。

上限：``summary`` 100 字、``progress`` 500 字。用台灣繁體中文。
``progress`` 寫「現在做到哪、卡在哪、下一步」，完整開發紀錄留在 ``doc/backup-*.md``。

overrides.json 的格式：

``````json
{
  "專案的 name 欄位": {
    "summary": "改寫後的一句話",
    "progress": "改寫後的現況摘要"
  }
}
``````

---

"@)
  foreach ($m in $manual) {
    [void]$ml.Add("`r`n## $($m.專案) · ``$($m.欄位)``（現在 $($m.現長) 字，上限 $($m.上限)）`r`n`r`n``````$([char]10)$($m.原文)$([char]10)```````r`n")
  }
  [System.IO.File]::WriteAllText($manualPath, ($ml -join ''), (New-Object System.Text.UTF8Encoding $true))
  Write-Host "需要人工改寫：$manualPath（$($manual.Count) 個欄位）" -ForegroundColor Yellow
}

if (-not $Apply) {
  Write-Host ''
  Write-Host '這次什麼都沒改。確認上面的清單沒問題後，加上 -Apply 再跑一次。' -ForegroundColor Cyan
  if ($report.問題 -join '' -match 'host 寫|path 指到別處') {
    Write-Host '有卡片的 host／path 指到別的地方。確認要更正的話，再加上 -FixHostPath。' -ForegroundColor Yellow
  }
  exit 0
}

# ── 推送 ─────────────────────────────────────────────────────────────
$pushDirs = @(@($changedDirs) + @($namedDirs) | Where-Object { $_ } | Sort-Object -Unique)
if ($Push -and $pushDirs.Count -eq 0) {
  Write-Host ''
  Write-Host '沒有東西需要推送：這一輪沒有任何檔案變更。' -ForegroundColor Yellow
  Write-Host '  想把某個專案的現況直接送上看板（即使檔案沒改），用 -Only 指名它：' -ForegroundColor DarkGray
  Write-Host '  ... -Only <專案的 name> -Push' -ForegroundColor DarkGray
}
if ($Push -and $pushDirs.Count -gt 0) {
  Write-Host ''
  if ($PushScript) {
    # 明確指定外部腳本時才走這條。
    if (-not (Test-Path $PushScript)) {
      Write-Host "找不到 $PushScript，跳過推送。改好的檔案已經在原地了。" -ForegroundColor Yellow
    } else {
      Write-Host "推送 $($pushDirs.Count) 個專案（用 $PushScript）…"
      foreach ($pd in $pushDirs) {
        $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $PushScript $pd 2>&1 | Select-Object -Last 1
        Write-Host "  $out"
      }
    }
  } else {
    # 內建推送。不依賴 push-status.ps1，也不依賴任何固定的安裝資料夾——
    # 推送設定是每個使用者一份、放在 %USERPROFILE%\.apphub-push.json，
    # 由安裝包的 setup.bat 產生。舊版曾經把路徑寫死成 C:\apphub-helper，
    # 那個資料夾已經廢除，寫死它會在換過安裝方式的機器上直接失敗。
    $cfgPath = Join-Path $env:USERPROFILE '.apphub-push.json'
    if (-not (Test-Path $cfgPath)) {
      Write-Host '找不到推送設定，跳過推送。改好的檔案已經在原地了。' -ForegroundColor Yellow
      Write-Host "  設定檔應該在：$cfgPath" -ForegroundColor DarkGray
      Write-Host '  這台機器還沒設定過看板推送。把安裝包 apphub-helper-dist 複製過來，' -ForegroundColor DarkGray
      Write-Host '  雙擊 setup.bat，然後再跑一次這支工具（或只加 -Push）即可。' -ForegroundColor DarkGray
    } else {
      $targets = @()
      try {
        $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cfg.targets) {
          foreach ($t in $cfg.targets) {
            if ($t.url -and $t.token) {
              $tp = if ($t.path) { $t.path } else { '/api/push' }
              $targets += [pscustomobject]@{ Url = $t.url; Path = $tp; Token = $t.token }
            }
          }
        } elseif ($cfg.url -and $cfg.token) {
          $targets += [pscustomobject]@{ Url = $cfg.url; Path = '/api/push'; Token = $cfg.token }
        }
      } catch {
        Write-Host "推送設定不是合法 JSON：$cfgPath" -ForegroundColor Yellow
      }
      if ($targets.Count -eq 0) {
        Write-Host "推送設定裡沒有可用的目標（需要 targets[] 含 url 與 token）。" -ForegroundColor Yellow
      } else {
        Write-Host "推送 $($pushDirs.Count) 個專案到 $($targets.Count) 個看板目標…"
        foreach ($pd in $pushDirs) {
          $sp = Join-Path $pd 'doc\status.json'
          if (-not (Test-Path $sp)) { continue }
          $proj = Get-Content -LiteralPath $sp -Raw -Encoding UTF8 | ConvertFrom-Json
          foreach ($t in $targets) {
            # 這裡用 ConvertTo-Json 沒問題：\u003c 是合法的 JSON 逸出，
            # 伺服器端解析回來完全一樣。會自己寫序列化是為了「寫檔」時的
            # 可讀性與 git diff，不是為了正確性。
            $body = @{ token = $t.Token; project = $proj } | ConvertTo-Json -Depth 20
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
            $url = ($t.Url.TrimEnd('/')) + $t.Path
            try {
              $resp = Invoke-RestMethod -Uri $url -Method Post -TimeoutSec 30 `
                        -ContentType 'application/json; charset=utf-8' -Body $bytes
              Write-Host "  [OK] $($resp.name) → $($t.Url)" -ForegroundColor Green
            } catch {
              Write-Host "  [FAIL] $(Split-Path -Leaf $pd) → $($t.Url)：$($_.Exception.Message)" -ForegroundColor Red
            }
          }
        }
      }
    }
  }
}

Write-Host ''
Write-Host '完成。' -ForegroundColor Green
Write-Host "每一支都留了 doc/status.json.bak-$STAMP，要還原直接覆蓋回去即可。"
