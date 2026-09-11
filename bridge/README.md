# 訂閱橋接服務

把本機已登入的 CLI 包成 OpenAI 相容端點，讓 VPS 上的閘道能借用訂閱額度。

## 支援狀態（2026-08-21 實測）

| 模型名稱 | CLI | 狀態 |
|---|---|---|
| `sub-claude` | Claude Code | **可用**，in=3 out=6（回一句話） |
| `sub-codex` | Codex CLI | **可用**，但 in=25,340（固定開銷大） |
| `sub-gemini` | Antigravity（`agy`） | **可用**，in=16,487 out=179 |
| `sub-imagegen` | Codex CLI 內建 `image_gen` | **可用**（產圖），in=53,174 out=210 |

### 產圖：`sub-imagegen`

端點不同，是 `POST /v1/images/generations`，不是 `/v1/chat/completions`。

```bash
curl -H "Authorization: Bearer $BRIDGE_TOKEN" -H "Content-Type: application/json"   -d '{"model":"sub-imagegen","prompt":"一隻橘色的貓坐在窗台上曬太陽，水彩風格"}'   http://127.0.0.1:8787/v1/images/generations
# → {"created":..., "data":[{"b64_json":"..."}], "usage":{...}}
```

實測 40.6 秒、2.7 MB PNG、1198×1313。四件事要先知道：

1. **不能指定模型。** 內建工具不公開影像模型名稱，所以拿不到 `gpt-image-2`。
   要指定模型就得用 API 金鑰，那條路不經橋接（2026-08-21 User 裁決不做）。
2. **不能控制尺寸。** 要求 1024×1024 會回 1254×1254。帶 `size` 直接回 400，
   不會默默忽略——默默忽略會讓呼叫端以為拿到了指定尺寸。
3. **只回 `b64_json`，只支援 `n=1`。** 橋接沒有對外網址可以放圖；
   `n>1` 等於多次完整呼叫，每次固定開銷約 5 萬 token，會把序列佇列卡住。
4. **與 `sub-codex` 是同一個 Codex 週額度池**，速率計數合併。
   `BRIDGE_RPM_IMAGE` 預設 2，比文字的 4 更緊，因為固定開銷是兩倍。

圖檔取自 `~/.codex/generated_images/<thread_id>/`，`thread_id` 來自 `--json` 的
第一個事件，不解析任何自然語言。回傳後只刪本次呼叫建立的那一個目錄——
**絕不掃整個 `generated_images`**，裡面還有你自己互動時產生的圖。
`BRIDGE_IMAGE_CLEANUP=0` 可關閉清理供除錯。

### 改圖與多圖合成：`POST /v1/images/edits`

帶 1 至 4 張輸入圖，可以做換裝、場景合成、「把 A 圖的東西放進 B 圖」。
同一個模型名、同一個額度池，一樣免費。

```bash
curl -H "Authorization: Bearer $BRIDGE_TOKEN" -H "Content-Type: application/json"   -d '{"model":"sub-imagegen",
       "prompt":"把第二張圖的紅色圓形當成夕陽放進第一張圖的窗景，其餘保持原樣",
       "image":["<base64>","<base64>"]}'   http://127.0.0.1:8787/v1/images/edits
```

**兩種格式都收。** OpenAI 原生的 `multipart/form-data`（閘道代理時送的就是這種），
以及上面那種 JSON 的 base64 陣列（自家專案直打橋接時比較好寫）。

一開始只做 JSON，那個判斷錯了：**LiteLLM 代理不了 JSON**，
它內部呼叫 `aimage_edit` 需要 `image` 這個檔案參數，收到 JSON 直接拋
`TypeError` 回 500，結果就是改圖只能在 VPS 內網直打橋接。
所以還是補上了 multipart，但範圍收窄成只處理 LiteLLM 送的那種形狀——
不支援巢狀 multipart、不支援 base64 傳輸編碼、不做串流。

**回應的 `usage` 必須用 images 端點那一套欄位名**，不是聊天端點那一套。
`input_tokens`／`output_tokens`／`total_tokens`／`input_tokens_details` 缺一不可，
LiteLLM 會用 pydantic 驗 `ImageResponse`。這個錯特別難查，因為
**它發生在橋接已經做完工作之後**——額度花掉了、圖也產好了，呼叫端只拿到 500。

實測（2026-08-21，兩張輸入圖）：

| 項目 | 結果 |
|---|---|
| 耗時 | 66.7 秒（比純產圖的 40 秒久） |
| token | in 91,573 ／ out 692（輸入圖要進 token，比純產圖的 53k 高） |
| 輸出 | 2.57 MB，1199×1312，構圖與輸入圖一致 |
| 沙箱 | `-s read-only` 下正常，輸入圖用 `-i` 帶入 |

輸入圖寫成暫存檔放在工作目錄，**呼叫結束無論成敗都刪**——那可能是人像。
檔案型別認的是檔頭（PNG／JPEG／WebP），不信呼叫端宣稱的型別。
單張解碼後上限 10 MB，body 上限 48 MB。

### Gemini：要在 Antigravity 裡裝 CLI

`@google/gemini-cli` 這條路走不通——它回 `IneligibleTierError`，個人版訂閱已不支援。
正確的是 **Antigravity 的 `agy`**，但它不隨 Antigravity 安裝一起出現，
要在 Antigravity 裡執行 CLI 設定才會裝到 `%LOCALAPPDATA%\agy\bin\agy.exe`。

註：`GEMINI_API_KEY` 能讓 gemini CLI 動起來，但那是 **API 計費**，
繞一圈還是花錢，橋接的意義完全消失。`childEnv()` 會強制清掉這個變數。

## 這三個是 agent，不是文字模型

**這是包裝時最容易錯的一點。** 它們預設會使用工具（讀檔、執行指令）。
實測時 agy 為了回答一句 `Reply with exactly: ...` 自己決定要跑 `agy --help`，
被權限擋下來才發現——「它想用工具」是常態，不是例外。

而呼叫端（例如 app-b）會把外部新聞內容送進來摘要，那是**不可信輸入**。
內容裡藏的提示注入就能在這台電腦上執行指令。

所以三家一律關到最緊：

| CLI | 限制方式 |
|---|---|
| claude | `--permission-mode plan`（唯讀，不能改檔不能執行指令） |
| codex | `-s read-only` |
| agy | `--sandbox --disable-slash-commands` |
| 產圖 | `-s read-only`（實測產圖不需要放寬沙箱），描述另用標記框住 |

**不要為了讓某個功能動起來就加 `--dangerously-*` 開關。**

## 三個參數陷阱（實測踩過）

1. **claude 的 `--tools ""` 用不了。** 空字串在 Windows 的 shell 模式下會被吃掉，
   CLI 回 `option '--tools <tools...>' argument missing`。改用 `--permission-mode plan`。
2. **agy 的 `--print` 會吃掉下一個參數當 prompt。**
   `--print --output-format json` 會讓它以為 prompt 是 `--output-format`，
   然後跑 `agy --help` 想搞懂那是什麼。prompt 必須是 `--print` 的值。
3. **prompt 放 argv 還是 stdin，取決於執行檔類型。**
   `.cmd` 包裝（claude、codex）必須 `shell: true`（Node 直接 spawn `.cmd` 會 EINVAL），
   而 shell 模式下 argv 會被 cmd.exe 再解析一次 → 一律走 stdin。
   真正的 `.exe`（agy）可以 `shell: false` 直接 spawn → argv 才安全。

## 成本差異很大

回同一句話的輸入 token：claude 3、gemini 16,487、codex 25,351。
後兩家每次呼叫都載入大量上下文。批次任務跑 100 次，
claude 幾乎不佔額度，codex 會吃掉 250 萬 token。
`BRIDGE_RPM_CODEX` 預設 4 次／分就是為此。

## 啟動

```bash
# 必要：沒有 token 會拒絕啟動
set BRIDGE_TOKEN=<自訂的長亂數>
node server.js
```

| 環境變數 | 用途 | 預設 |
|---|---|---|
| `BRIDGE_TOKEN` | 呼叫端要帶的 Bearer token | 無，未設定則拒絕啟動 |
| `BRIDGE_PORT` | 監聽埠 | 8787 |
| `BRIDGE_TIMEOUT_MS` | 單次呼叫逾時 | 180000 |
| `BRIDGE_MAX_QUEUE` | 佇列上限，超過回 429 | 4 |
| `BRIDGE_RPM_CLAUDE` | Claude 每分鐘上限 | 10 |
| `BRIDGE_RPM_CODEX` | Codex 每分鐘上限 | 4 |
| `BRIDGE_RPM_GEMINI` | Gemini 每分鐘上限 | 10 |
| `BRIDGE_AGY` | `agy` 執行檔路徑（Windows 上通常不在 PATH） | `agy` |

`CLAUDE_CODE_OAUTH_TOKEN` 要在環境裡（用 `scripts/set-claude-token.ps1` 設定）。

## 四條不能改的規則

1. **只綁 127.0.0.1。** 對外一律經隧道。這行改成 `0.0.0.0` 等於把訂閱開放給整個區網，
   而這些 CLI 是能讀檔案的 agent。
2. **一定要 token。** 未設定就拒絕啟動，不是「先跑再說」。
3. **序列化執行、各家分開限速。** 訂閱的速率限制是全帳號共用的，
   打爆會連你自己在用的 CLI 一起被擋。
4. **prompt 一律走 stdin，不放 argv。** Windows 上這些 CLI 是 `.cmd` 包裝，
   Node 直接 spawn 會 EINVAL，只能 `shell: true`——而 shell 模式下 argv 會被
   cmd.exe 再解析一次。app-b 要摘要的是外部新聞內容，那是不可信輸入。

## 已知限制

- **支援 stream（2026-08-22 起），但三家的細緻度不同。**
  `sub-claude` 是逐字的 delta；`sub-gemini` 有 delta 但一次吐一大段；
  `sub-codex` 的 `exec --json` 根本沒有 delta 事件，所以整段答案當成一個 chunk 送出。
  不做假的切字——切了只是把等待時間換個樣子呈現。
  串流最後一定會多一個帶 `usage` 的 chunk（choices 為空陣列），閘道靠它記帳，
  不回的話經閘道的串流會全部記成 0 token。
  產圖與改圖仍然回 400：圖只有做完與沒做完兩種狀態。
- **多輪對話是有損的。** `messages` 被攤平成一段標了角色的文字，
  不是真正的多輪上下文。對批次與單輪任務足夠。
- **每次呼叫都要冷啟一個 process**，比直接打 API 慢。

## 命名為什麼是 sub- 前綴而不是 -sub 後綴

LiteLLM 金鑰的模型白名單**支援萬用比對**。原本叫 `gemini-sub` 時實測發現：
給某個軟體 `gemini-*` 的權限，會**連 `gemini-sub` 一起放行**——
等於在沒有任何錯誤訊息的情況下把 Gemini 訂閱送出去。

| 金鑰限制 | `gemini-3.1-flash-lite` | `claude-sub` | `gemini-sub` |
|---|---|---|---|
| 未限制 | 放行 | 放行 | 放行 |
| `gemini-*` | 放行 | 擋下 | **放行（意外）** |

改成 `sub-` 前綴後，供應商的萬用比對不會誤中，
而 `sub-*` 本身可以當成「所有訂閱」整組授權。

## 運維：家機關機後可能要重啟閘道

LiteLLM 把上游標成不健康之後，**光等冷卻不會恢復**。
實測隧道與橋接都已正常（VPS 打橋接回 200），閘道仍持續回
`no healthy deployments`，隔數分鐘也不會自己好，要
`docker compose ... restart litellm` 才會清掉。

所以家機關機一段時間再開之後，若訂閱模型打不通，先重啟閘道再排查。

## 額度守門（2026-08-22 起兩家都有）

| 變數 | 預設 | 作用 |
|---|---|---|
| `BRIDGE_CODEX_RESERVE_PCT` | 20 | Codex 剩餘量低於此百分比時，橋接的 codex 請求一律 429 |
| `BRIDGE_AGY_RESERVE_PCT` | 20 | 同上，但看的是 Antigravity 的 **Gemini 群組**視窗（Claude+GPT 池與 sub-gemini 無關） |

查不到用量時**放行**：橋接是給其他軟體用的服務，
因為一個查詢暫時失敗就整組停擺，代價比偶爾多用一點額度高。設 0 可停用。
