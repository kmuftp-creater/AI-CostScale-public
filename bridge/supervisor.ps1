# 訂閱橋接的常駐管理程式。
#
# 同時看顧兩個行程，任一個死掉就重啟：
#   1. 橋接服務（node server.js，聽 127.0.0.1:8787）
#   2. SSH 反向隧道（把 VPS 的 10.87.213.1:8788 射到本機 8787）
#
# 由 Windows 排程工作在登入時啟動，見 install-task.ps1。
#
# 為什麼要自己看顧而不是靠排程工作的「失敗時重啟」：
# 排程工作只看得到「行程結束」，看不到「行程還在但隧道已經斷線」。
# SSH 在網路變動時可能卡住不退出，這裡用實際打 /health 來判斷死活。

$ErrorActionPreference = 'Continue'

$BridgeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# 紀錄檔位置不要只靠 $env:LOCALAPPDATA（E-26）。非互動情境下那個變數可能是空的，
# Join-Path 會產生相對路徑，檔案落到 C:\Windows\system32 然後因為沒有寫入權限
# 而整支無聲死掉。這裡照 scripts\push-codex-usage.ps1 的同一套逐級退回。
$LocalApp = [Environment]::GetFolderPath('LocalApplicationData')
if (-not $LocalApp) { $LocalApp = $env:LOCALAPPDATA }
if (-not $LocalApp -and $env:USERPROFILE) { $LocalApp = Join-Path $env:USERPROFILE 'AppData\Local' }
if (-not $LocalApp) { $LocalApp = $BridgeDir }
$LogDir = Join-Path $LocalApp 'costscale-bridge'
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$Log = Join-Path $LogDir 'supervisor.log'

# 閘道所在主機的 SSH 位址（例：root@203.0.113.10）。用使用者環境變數 COSTSCALE_VPS_SSH 設定。
$VpsHost = if ($env:COSTSCALE_VPS_SSH) { $env:COSTSCALE_VPS_SSH } else { 'root@your-vps.example.com' }
$BindAddr = '10.87.213.1'   # costscale_default 網路的閘道位址（＝VPS 主機）
$RemotePort = 8788
$LocalPort = 8787
$CheckIntervalSec = 30
# 隧道健檢每幾輪做一次。本機 /health 不生行程可以每輪跑；
# 隧道那個要起 ssh，降到 2 分鐘一次就夠——隧道斷掉時最多晚兩分鐘發現，
# 而閘道那端本來就有重試。
$TunnelCheckEvery = 4
# 連續幾次健檢失敗才發告警信。4 輪 x 30 秒 = 2 分鐘一次健檢，
# 5 次 = 約 10 分鐘。2026-08-23 有一次斷了 83 分鐘完全沒人知道，補這個。
$AlertAfterFails = 5

function Say($msg) {
    $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Write-Host $line
    Add-Content -Path $Log -Value $line -Encoding UTF8
}

# 環境變數從使用者範圍讀，因為排程工作啟動時不一定帶得到。
function LoadEnv {
    foreach ($k in @('CLAUDE_CODE_OAUTH_TOKEN', 'BRIDGE_TOKEN', 'BRIDGE_AGY')) {
        $v = [Environment]::GetEnvironmentVariable($k, 'User')
        if ($v) { Set-Item -Path "env:$k" -Value $v }
    }
}

function BridgeAlive {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$LocalPort/health" -UseBasicParsing -TimeoutSec 5
        return $r.StatusCode -eq 200
    } catch { return $false }
}

# 起一個外部行程但**保證不配置主控台視窗**（2026-08-22）。
#
# 起因：原本用 `& ssh ...` 直接呼叫，每 30 秒一次。實測（Win32_Process 監看）
# 那個 ssh.exe 會配置自己的主控台，在畫面上就是「隔一陣子閃一下黑窗」，
# 而且會搶走鍵盤焦點——User 打字打到一半被打斷。
# PowerShell 的 -WindowStyle Hidden 是行程起來之後才隱藏，擋不住那一瞬間；
# 只有 ProcessStartInfo.CreateNoWindow 是在建立時就不給視窗。
# 參數千萬不要叫 $Args。$Args 是 PowerShell 的自動變數，函式一旦宣告了具名參數，
# 它就是空陣列——結果是 $psi.Arguments 永遠是空字串，ssh 收到零個參數、
# 印出用法說明、回 exit code 255。而呼叫端只看 Ok/Out，看起來就像「遠端沒回應」。
# 這支函式從寫出來就沒成功過一次：TunnelAlive 永遠回 false，於是隧道每 2 分鐘
# 被無條件砍掉重建（就是那個每隔幾分鐘閃一下的黑窗），ClearStaleForward 也從沒清到東西。
# 2026-08-23 查黑窗才發現。
function Invoke-Hidden {
    param([string]$File, [string[]]$ArgList, [int]$TimeoutSec = 20)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $File
    $psi.Arguments = ($ArgList -join ' ')
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    if (-not $p.WaitForExit($TimeoutSec * 1000)) {
        try { $p.Kill() } catch {}
        return @{ Ok = $false; Out = '' }
    }
    return @{ Ok = ($p.ExitCode -eq 0); Out = $p.StandardOutput.ReadToEnd() }
}

# 隧道死活不能只看行程在不在——SSH 可能還在但轉發已經斷。
# 從 VPS 端實際打一次 /health 才算數。
# 重試三次才判死。2026-08-23 踩過：健檢只做一次，VPS 忙的時候 ssh 逾時就誤判，
# 而誤判的代價是 ClearStaleForward 會把「正在正常運作的隧道」殺掉，
# 殺完 2 秒就重綁、埠還沒釋放又失敗，從此永久卡死。一次誤判＝一次長時間中斷。
function TunnelAlive {
    param([int]$Attempts = 3)
    for ($i = 1; $i -le $Attempts; $i++) {
        try {
            $remote = "curl -s -m 8 -o /dev/null -w '%{http_code}' http://${BindAddr}:${RemotePort}/health"
            $r = Invoke-Hidden -File 'ssh' -ArgList @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', $VpsHost, "`"$remote`"") -TimeoutSec 20
            if ($r.Out.Trim() -eq '200') { return $true }
        } catch { }
        if ($i -lt $Attempts) { Start-Sleep -Seconds 5 }
    }
    return $false
}

$bridgeProc = $null
$tunnelProc = $null
$tunnelErrSub = $null
$tunnelFails = 0

# 走 CostScale 既有的寄信設定（VPS 的 .env），不在本機另外放 SMTP 帳密。
function SendAlert($subject, $body) {
    try {
        $payload = @{ subject = $subject; body = $body } | ConvertTo-Json -Compress
        $tmp = Join-Path $env:TEMP ("bridge-alert-" + [guid]::NewGuid().ToString('N') + ".json")
        [System.IO.File]::WriteAllText($tmp, $payload, (New-Object System.Text.UTF8Encoding($false)))
        Invoke-Hidden -File 'scp' -ArgList @('-q', "`"$tmp`"", "${VpsHost}:/tmp/bridge-alert.json") -TimeoutSec 30 | Out-Null
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue

        # 遠端指令落成 .sh 再送過去執行，不要塞進 ssh 的參數字串。（2026-08-26 修）
        # Invoke-Hidden 是把參數用空白 join 成「一整條命令列」交給 Windows，
        # 指令裡只要出現第二個雙引號，Windows 就在那裡把參數切開；ssh 收到被拆散的
        # 一串字，遠端 shell 再照空白重組。於是 -H "Authorization: Bearer $ALERT_CRON_TOKEN"
        # 被拆成 -H / Authorization: / Bearer / <token> 四段，curl 把後兩段當網址去打，
        # 真正那一發則少了授權標頭。2026-08-26 實測：依序打了 http://Bearer/（301）、
        # http://<token>/（DNS 不通）、http://application/json（404），端點回「驗證失敗」。
        # **也就是這條告警路徑從來沒有成功寄出過一封信。**
        #
        # 腳本一定要寫成 LF 換行——CRLF 會讓 bash 報 $'`r': command not found，
        # 而那個錯誤訊息看起來跟引號完全無關。
        $remote = @'
#!/bin/bash
set -u
cd /opt/costscale || exit 1
set -a; . ./.env; set +a
curl -s -m 30 -X POST -H "Authorization: Bearer $ALERT_CRON_TOKEN" -H "Content-Type: application/json" --data-binary @/tmp/bridge-alert.json http://127.0.0.1:3300/api/alerts/bridge
rm -f /tmp/bridge-alert.json /tmp/bridge-alert.sh
'@
        $shTmp = Join-Path $env:TEMP ("bridge-alert-" + [guid]::NewGuid().ToString('N') + ".sh")
        $lf = ($remote -replace "`r`n", "`n") + "`n"
        [System.IO.File]::WriteAllText($shTmp, $lf, (New-Object System.Text.UTF8Encoding($false)))
        Invoke-Hidden -File 'scp' -ArgList @('-q', "`"$shTmp`"", "${VpsHost}:/tmp/bridge-alert.sh") -TimeoutSec 30 | Out-Null
        Remove-Item $shTmp -Force -ErrorAction SilentlyContinue
        $r = Invoke-Hidden -File 'ssh' -ArgList @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', $VpsHost, 'bash', '/tmp/bridge-alert.sh') -TimeoutSec 40
        Say "告警信送出結果：$($r.Out.Trim())"
    } catch {
        Say "送告警信失敗：$($_.Exception.Message)"
    }
}

function StartBridge {
    # 重啟 supervisor 會失去對舊 node 的控制權，舊的還佔著 8787，
    # 新的就會 EADDRINUSE 當場死掉——實際留下 5 個殘存 node（2026-08-23）。
    # 已經有健康的橋接在服務就直接沿用，不要再起一個。
    if (BridgeAlive) {
        Say '橋接服務已在執行（沿用現有的，不重複啟動）'
        return
    }
    Say '啟動橋接服務'
    $script:bridgeProc = Start-Process node `
        -ArgumentList 'server.js' `
        -WorkingDirectory $BridgeDir `
        -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LogDir 'bridge.out.log') `
        -RedirectStandardError  (Join-Path $LogDir 'bridge.err.log')
}

# 強制中止本機的 ssh 之後，VPS 端的 sshd 不會立刻釋放轉發埠。
# 新的隧道會因為 ExitOnForwardFailure 而立刻退出，然後每 30 秒重試一次、
# 每次都失敗——實測踩過，日誌只寫「隧道不通，重建」看不出原因。
# 所以重建前先請 VPS 清掉殘留的轉發。
function ClearStaleForward {
    # 2026-08-23 第二版。第一版有兩個洞，都會讓「以為清乾淨了」而其實沒有：
    #
    # 1. 時序：StopProc 殺掉本機 ssh 之後，VPS 那端要一會兒才會登記 session 已死。
    #    立刻探測會回「沒人佔用」，等真的開始綁定時對方才把埠掛上去，於是綁定失敗。
    #    → 先等 3 秒再探，而且要連續兩次都回空才算數。
    # 2. 誤判：探測用的 ssh 自己失敗時 Out 也是空字串，跟「埠是空的」長得一模一樣。
    #    → 只有 ssh 真的成功（Ok）才採信空結果，否則當成未知、繼續重試。
    try {
        $probe = "ss -tlnp 2>/dev/null | grep ':$RemotePort' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u | tr '\n' ' '"
        Start-Sleep -Seconds 3
        $freeStreak = 0
        for ($round = 1; $round -le 6; $round++) {
            $r = Invoke-Hidden -File 'ssh' -ArgList @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', $VpsHost, "`"$probe`"") -TimeoutSec 20
            if (-not $r.Ok) {
                Say "探測 $RemotePort 埠時 ssh 失敗，這一輪不採信（第 $round 輪）"
                Start-Sleep -Seconds 4
                continue
            }
            $pids = ($r.Out).Trim()
            if (-not $pids) {
                $freeStreak++
                if ($freeStreak -ge 2) {
                    if ($round -gt 1) { Say "殘留轉發已清除（第 $round 輪）" }
                    return
                }
                Start-Sleep -Seconds 3
                continue
            }
            $freeStreak = 0
            # 前兩輪好好講，之後直接 -9。
            $sig = if ($round -le 2) { '' } else { '-9 ' }
            $kill = "for p in $pids; do kill $sig" + "`$" + "p 2>/dev/null; done"
            Invoke-Hidden -File 'ssh' -ArgList @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', $VpsHost, "`"$kill`"") -TimeoutSec 20 | Out-Null
            Say "清掉佔用 $RemotePort 的殘留轉發 pid $pids（第 $round 輪$(if ($sig) { '，強制' })）"
            Start-Sleep -Seconds 4
        }
        Say "警告：$RemotePort 埠始終沒有確認釋放，這一輪的隧道大概會綁不上"
    } catch {
        Say "清理殘留轉發時發生錯誤：$($_.Exception.Message)"
    }
}

function StartTunnel {
    ClearStaleForward
    Say '啟動 SSH 反向隧道'
    # ExitOnForwardFailure：綁定失敗就直接退出，不要假裝連上了。
    # ServerAliveInterval/CountMax：對方沒回應就主動斷開，交給下一輪重連。
    #
    # 為什麼不用 Start-Process -WindowStyle Hidden：那是行程起來「之後」才隱藏，
    # 每次重建都會閃一下黑窗（第四十四節記過同一個坑）。
    # CreateNoWindow 是建立當下就不給視窗，才真的不閃。
    # 代價是 stderr 要自己汲取——不讀的話緩衝區滿了會把 ssh 卡住。
    $errFile = Join-Path $LogDir 'tunnel.err.log'
    # 每次啟動先清空：底下判讀「最後一行」時，要的是這一輪的錯誤，不是上一輪的。
    Set-Content -Path $errFile -Value '' -Encoding UTF8

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'ssh'
    $psi.Arguments = @(
        '-N',
        '-o', 'BatchMode=yes',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-R', "${BindAddr}:${RemotePort}:127.0.0.1:${LocalPort}",
        $VpsHost
    ) -join ' '
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardError = $true

    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi
    $p.EnableRaisingEvents = $true

    # 事件訂閱要記下來，重啟時取消。長跑的腳本重建上百次，不取消會一直累積。
    $sub = Register-ObjectEvent -InputObject $p -EventName ErrorDataReceived -MessageData $errFile -Action {
        if ($EventArgs.Data) {
            Add-Content -Path $Event.MessageData -Value $EventArgs.Data -Encoding UTF8
        }
    }

    $p.Start() | Out-Null
    $p.BeginErrorReadLine()
    $script:tunnelProc = $p
    $script:tunnelErrSub = $sub
}

function StopProc($p, $name) {
    if ($name -eq 'tunnel' -and $script:tunnelErrSub) {
        try { Unregister-Event -SubscriptionId $script:tunnelErrSub.Id -ErrorAction SilentlyContinue } catch {}
        $script:tunnelErrSub = $null
    }
    if ($p -and -not $p.HasExited) {
        Say "重啟前先停掉舊的 $name"
        try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch {}
    }
}

LoadEnv
if (-not $env:BRIDGE_TOKEN) {
    Say '未設定 BRIDGE_TOKEN，無法啟動。請先執行 scripts\set-claude-token.ps1 之後的設定步驟。'
    exit 1
}

Say '=== 常駐管理程式啟動 ==='
StartBridge
Start-Sleep -Seconds 3
StartTunnel

$loop = 0
while ($true) {
    Start-Sleep -Seconds $CheckIntervalSec
    $loop++

    if (-not (BridgeAlive)) {
        Say '橋接服務沒有回應，重啟'
        StopProc $bridgeProc 'bridge'
        StartBridge
        Start-Sleep -Seconds 3
        # 橋接重啟後隧道指向的埠會斷一下，一併重建比較乾淨。
        StopProc $tunnelProc 'tunnel'
        StartTunnel
        continue
    }

    if (($loop % $TunnelCheckEvery) -ne 0) { continue }

    if (-not (TunnelAlive)) {
        $script:tunnelFails++
        # 連續失敗時把 ssh 的錯誤帶出來，不要只留「不通」兩個字。
        $why = ''
        $errLog = Join-Path $LogDir 'tunnel.err.log'
        if (Test-Path $errLog) {
            $last = (Get-Content $errLog -Tail 1 -ErrorAction SilentlyContinue)
            if ($last) { $why = "：$last" }
        }
        Say "隧道不通，重建（連續第 $tunnelFails 次）$why"
        StopProc $tunnelProc 'tunnel'
        StartTunnel
        # 只在跨過門檻的那一次發信，不要每輪都寄。
        if ($tunnelFails -eq $AlertAfterFails) {
            SendAlert "CostScale 橋接隧道持續不通" @"
橋接的 SSH 反向隧道連續 $tunnelFails 次健檢失敗，閘道的 sub-* 模型現在應該全部不可用。

最後一筆 ssh 錯誤：$why

本機日誌：$Log
排查起點：VPS 上 ss -tlnp | grep $RemotePort，看是不是有死掉的 sshd 還綁著那個埠。
"@
        }
    } elseif ($tunnelFails -gt 0) {
        Say "隧道恢復（先前連續失敗 $tunnelFails 次）"
        if ($tunnelFails -ge $AlertAfterFails) {
            SendAlert "CostScale 橋接隧道已恢復" "隧道在連續失敗 $tunnelFails 次後恢復正常。"
        }
        $script:tunnelFails = 0
    }
}
