# 把 Claude Code 的長效權杖寫進使用者環境變數，並自我驗證。
# 用法：在一般 PowerShell 視窗執行
#   powershell -ExecutionPolicy Bypass -File scripts\set-claude-token.ps1
#
# 權杖只存在於這支腳本的記憶體與 Windows 的使用者環境變數，
# 不會寫進任何檔案、不會出現在畫面上、不會進版本控制。

$ErrorActionPreference = 'Stop'
$VAR = 'CLAUDE_CODE_OAUTH_TOKEN'

Write-Host ''
Write-Host '=== 設定 Claude Code 長效權杖 ===' -ForegroundColor Cyan
Write-Host ''
Write-Host '若你還沒有權杖，先關掉這支腳本，執行 claude setup-token 取得。'
Write-Host '權杖長得像 sk-ant-oat01-... 這樣。'
Write-Host ''

# 用 SecureString 讀取：貼上時畫面不會顯示內容。
$secure = Read-Host '請貼上權杖（畫面不會顯示，貼完按 Enter）' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Host '[失敗] 沒有讀到任何內容，可能是貼上沒成功。請重跑。' -ForegroundColor Red
    exit 1
}
$token = $token.Trim()

# 基本格式檢查：擋掉貼錯東西的情況，但不驗證權杖本身是否有效。
if ($token -notmatch '^sk-ant-') {
    Write-Host "[失敗] 這串不像 Claude 權杖（應以 sk-ant- 開頭）。長度 $($token.Length)。" -ForegroundColor Red
    Write-Host '        沒有寫入任何東西。請確認貼的是 claude setup-token 產生的那一串。' -ForegroundColor Red
    exit 1
}

[Environment]::SetEnvironmentVariable($VAR, $token, 'User')

# 立刻讀回來確認真的寫進去了，不要只相信上一行沒報錯。
$check = [Environment]::GetEnvironmentVariable($VAR, 'User')
$token = $null
[GC]::Collect()

if (-not $check) {
    Write-Host '[失敗] 寫入後讀不回來，環境變數沒有生效。' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host "[成功] 已寫入使用者環境變數 $VAR（長度 $($check.Length)）" -ForegroundColor Green
Write-Host ''

# 用剛設好的權杖實際問一次認證狀態，這才是真的證明它能用。
$env:CLAUDE_CODE_OAUTH_TOKEN = $check
Write-Host '--- 實際驗證認證狀態 ---'
try {
    $status = & claude auth status 2>&1 | Out-String
    Write-Host $status.Trim()
    if ($status -match '"loggedIn"\s*:\s*true') {
        Write-Host ''
        Write-Host '[通過] 權杖可用。' -ForegroundColor Green
    } else {
        Write-Host ''
        Write-Host '[注意] 權杖已寫入，但認證狀態不是 true。' -ForegroundColor Yellow
        Write-Host '        可能是權杖已作廢，或需要重新產生一把。' -ForegroundColor Yellow
    }
} catch {
    Write-Host "[注意] 無法執行 claude auth status：$($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host ''
Write-Host '重要：已經開著的終端機視窗不會自動吃到新的環境變數。' -ForegroundColor Cyan
Write-Host '      設定完請重開終端機（含 Claude Code）。' -ForegroundColor Cyan
Write-Host ''
