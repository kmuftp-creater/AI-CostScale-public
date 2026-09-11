# 閃窗根治：隱藏桌面試過了，不通；真正有效的是「不讓 agy 查更新」

2026-09-01。這個資料夾是查證用的探針與失敗方案的原始碼，**沒有任何一支被橋接引用**。
上線的修法在 `bridge/server.js` 的 `agyUpdateGuard()`。

## 一、先講結論

| 方案 | 結果 |
|---|---|
| 隱藏桌面（`CreateDesktop` ＋ `STARTUPINFO.lpDesktop`） | **這台機器上不可用**。放到新建桌面的行程一律 `STATUS_DLL_INIT_FAILED`（`0xC0000142`） |
| `AGY_CLI_DISABLE_AUTO_UPDATE=1` | **無效**。設了照樣起 `--bg-updater`，4 輪 4 次 |
| **蓋掉 `last_check.timestamp` 的修改時間** | **有效**。8 輪 0 次 bg-updater、0 個視窗，額度資料照常 |

## 二、因果鏈（實測釘死）

```
agy 啟動
  → 判斷「該檢查更新了」（看 ~/.gemini/antigravity-cli/last_check.timestamp 的 mtime）
  → 起 agy --bg-updater --app_data_dir=antigravity-cli --gemini_dir=.gemini
  → 那個再起 agy --version
  → 黑窗是這一層開的
```

第八十一節寫「每 15 分鐘一次機會、實際頻率更低」，原因在這裡：
**機會＝那一趟的更新檢查到期了沒有**，不是隨機。

`AgyWindowProbe`（每 50 毫秒列舉可見的最上層視窗）：

| 條件 | 輪數 | bg-updater | ConsoleWindowClass 視窗 |
|---|---|---|---|
| 時間戳往回撥三天 | 8 | 8 | **8** |
| 時間戳蓋成現在 | 8 | 0 | **0** |

跑中的橋接實測（時間戳先往回撥三天，再打 `/usage`）：
agy 只出現一支 `--print /usage`，沒有孫行程，**0 個視窗**，
`antigravity` 四個額度視窗照常回來。呼叫結束後時間戳被還原成原值。

## 三、隱藏桌面為什麼不通

八種建法全部失敗，錯誤都一樣：

| 試法 | 結果 |
|---|---|
| `CreateDesktop(GENERIC_ALL)` ＋ 純名稱 | 失敗 |
| 同上 ＋ `WinSta0\` 前綴 | 失敗 |
| 逐項 `DESKTOP_*` 權限 ＋ 純名稱／前綴 | 失敗 |
| 明寫 DACL（`D:(A;;GA;;;WD)(A;;GA;;;SY)`） | 失敗 |
| 先讓自己的執行緒 `SetThreadDesktop` 附著再啟動 | 失敗 |
| 指名一個根本不存在的桌面 | 失敗（錯誤相同） |

受測程式換過三種：`agy.exe`（Go）、自寫的 .NET 程式、`notepad.exe`。
**連 notepad 都是 `0xC0000142`**，所以不是 agy 的問題，是這台機器上
「行程在新建桌面初始化 user32」這件事本身做不到。

本機的 `SharedSection` 是預設值 `1024,20480,768`，行程本身在 `WinSta0\Default`，
自己的執行緒 `SetThreadDesktop` 到新桌面是**成功**的——只有「新起的行程」失敗。
這台裝有 Symantec Endpoint Protection（`SepMasterService` 執行中），
而「把行程丟到隱藏桌面」正是端點防護會擋的手法之一。
**沒有實際驗證是不是 SEP 擋的**（要驗就得關掉防毒，不划算），
所以這一條寫成「相關」，不寫成「原因」。

## 四、檔案

原始碼留著，`.exe` 不進版控（`.gitignore`）。要重跑先編譯：

```bash
csc /nologo /target:exe /platform:anycpu /r:System.Management.dll /out:AgyWindowProbe.exe AgyWindowProbe.cs
```

`csc.exe` 在 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\`。

| 檔案 | 用途 |
|---|---|
| `AgyWindowProbe.cs` | **主要驗收工具**。`<輪數> force\|guard\|watch`，同時記行程與可見視窗 |
| `AgyUpdaterProbe.cs` | 只記行程，用來確認 bg-updater 起不起來 |
| `DesktopProbe.cs` | 直接跑 vs 走隱藏桌面包裝的 A／B 對照 |
| `DesktopTry.cs`／`2`／`3`／`4` | 隱藏桌面的八種建法 |
| `HiddenDesktopLauncher.cs` | 隱藏桌面包裝本體。**沒有被引用**，留作紀錄 |
| `ConsoleSpawner.cs` | 假的 agy：用 `CreateProcess` ＋ `CREATE_NEW_CONSOLE` 開窗 |

## 五、量測紀律（照第八十一節，這次又踩到一次）

- **`conhost` 出現不等於有視窗。** 要判斷有沒有閃，只能 `EnumWindows` ＋
  `IsWindowVisible`，看類別是不是 `ConsoleWindowClass`。掃行程只能給候選。
- **「沒看到視窗」不等於「修好了」。** 第一次的 A／B 用 `cmd /c start` 當孫行程，
  隱藏桌面那邊 0 個視窗——但那是因為 `start` 走 ShellExecute，在非互動桌面上
  **根本沒啟動**，孫行程沒跑，檔案也沒產生。要先證明「該做的事真的做了」，
  再看有沒有窗。
- **背景更新器不是每次都跑。** 不把 `last_check.timestamp` 往回撥就直接測，
  跑幾十輪也只會在第一輪看到一次，那樣的「沒看到」證明不了任何事。
