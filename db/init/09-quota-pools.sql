-- 免費額度計數：改以「金鑰池」為單位（2026-08-20）
--
-- 為什麼不用 01 建的 upstream_keys ＋ quota_rules ＋ quota_counters：
-- 那套假設「一把金鑰對一條規則」，但閘道的實際結構對不上——
--   1. OpenRouter 的 100 個直通模型共用同一個部署 id，不是 100 把金鑰
--   2. Groq 的 3 把金鑰各自對應 groq-large 與 groq-fast 兩個模型，
--      部署數是金鑰數的兩倍
--   3. 閘道刻意不外露金鑰值，能對回的只有部署 id，對不回環境變數名稱
-- 硬套會愈做愈扭曲。而使用者真正要問的是「這池免費額度還剩多少」，
-- 不是「第三把金鑰剩多少」，所以以池為單位才對得上需求。
--
-- 舊的三張表原本保留不動，2026-08-22 確認從未寫入任何資料後刪除（14-drop-legacy-quota.sql）。

CREATE TABLE IF NOT EXISTS costscale.quota_pools (
  id            SERIAL PRIMARY KEY,
  -- 閘道上的 model_name，例如 gemini-flash-free。同名的多個部署＝同一池的多把金鑰。
  model_name    TEXT NOT NULL UNIQUE,
  provider      TEXT NOT NULL,
  -- 這池有幾把金鑰。由 /model/info 數同名部署得出，可手動覆寫。
  key_count     INT  NOT NULL DEFAULT 1 CHECK (key_count >= 1),
  -- 每把金鑰的每日上限。null 代表未知，介面顯示「未設定」而不是猜一個數字。
  limit_rpd     INT,
  limit_tpd     BIGINT,
  -- default = 系統帶入的參考值，未經確認；user = 使用者依實際額度填入。
  -- 這個欄位存在的理由：不讓沒確認過的預設值在介面上長得像官方數字。
  source        TEXT NOT NULL DEFAULT 'default' CHECK (source IN ('default','user')),
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  note          TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quota_pools_enabled_idx ON costscale.quota_pools (enabled);

COMMENT ON TABLE costscale.quota_pools IS
  '免費／限額金鑰池。用量一律只計經本閘道消耗的部分，不等於供應商端的實際剩餘。';
