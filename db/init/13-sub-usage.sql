-- 訂閱剩餘額度（2026-08-21）
--
-- 為什麼需要這張表：quota_pools 那套是給「API 金鑰的每日請求數」用的，
-- 上限要 User 自己填（第二十四節）。訂閱不一樣——上游會直接告訴你用掉幾 %，
-- 不需要任何人手填，所以另立一張，不要硬塞進 quota_pools。
--
-- 資料由橋接代查後經 SSH 隧道給 VPS 取用，來源依供應商而異（見下方 provider 欄註解）。
-- 橋接那端**只讀 auth.json、永不回寫**：回寫會撞上 refresh-token 重用偵測，
-- 連帶作廢整個帳號的 session。
--
-- 本表只存最新一筆。歷史軌跡與燃燒速率在 15-sub-usage-history.sql（2026-08-22 加）。

CREATE TABLE IF NOT EXISTS costscale.sub_usage (
  -- 三家都有（2026-08-22 補齊，見全紀錄 C-5 與第三十五節）：
  --   codex       —— ChatGPT 的 wham/usage 端點。
  --   antigravity —— agy 的 /usage 斜線指令，print 模式會回結構化 JSON 且不花 token。
  --                  它有兩組配額：Gemini 群組是 sub-gemini 打的池，
  --                  Claude+GPT 群組是 Antigravity 自帶的第三方模型額度，
  --                  **與 Claude Code 訂閱無關**，不可當成 sub-claude 的餘額。
  --   claude      —— 不是用量端點（那要 user:profile 範圍，長效權杖沒有，403），
  --                  而是推論回應的 anthropic-ratelimit-unified-* 表頭。
  --                  查一次＝打一次 max_tokens=1 的極小請求，吃一點 5h 視窗額度。
  -- 查不到就是沒有那一列，介面顯示「—」，不要補一個看起來像資料的 0。
  provider          TEXT NOT NULL,
  -- '5h'、'Weekly' 之類。**不能靠 primary／secondary 的位置判斷是哪一種**：
  -- 實測本帳號 primary_window 就是 604800 秒（七天）而 secondary 為 null，
  -- 照位置標會把週限畫成 5 小時額度，面板上看起來等一下就回血，實際要等好幾天。
  window_label      TEXT NOT NULL,
  window_seconds    INT,
  used_percent      NUMERIC(5,2) NOT NULL CHECK (used_percent BETWEEN 0 AND 100),
  remaining_percent NUMERIC(5,2) NOT NULL CHECK (remaining_percent BETWEEN 0 AND 100),
  -- 額度重置的時間。介面要顯示這個，否則「只剩 14%」看不出是急事還是小事。
  reset_at          TIMESTAMPTZ,
  plan              TEXT,
  limit_reached     BOOLEAN NOT NULL DEFAULT false,
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, window_label)
);

COMMENT ON TABLE costscale.sub_usage IS
  '訂閱的剩餘額度，上游直接回報，不需 User 手填上限。只存最新值。';
COMMENT ON COLUMN costscale.sub_usage.window_label IS
  '額度視窗名稱，由 limit_window_seconds 換算，不可依 primary/secondary 位置推斷。';
COMMENT ON COLUMN costscale.sub_usage.fetched_at IS
  '最後一次抓到的時間。過舊代表橋接或隧道不通，介面要標示，不要顯示成當前值。';
