-- 兩本帳的 BigQuery 帳單匯出，合併後的逐日費用（2026-08-21）
--
-- 與 gcp_usage 的差別，不要混用：
--   gcp_usage     來自 Cloud Monitoring，是「用量」（呼叫次數、token），金額靠價目表估算。
--   billing_daily 來自帳單匯出，是「費用」，金額是 Google 實際計價的結果。
-- 兩者對同一段用量會有不同數字，這是資料源不同造成的，不是誰算錯。介面要分開呈現。
--
-- 三個查證過的前提（2026-08-21 實查兩張匯出表）：
--   1. 幣別是 TWD 不是 USD。兩個帳單帳戶都以台幣計價，所以這張表不經匯率換算。
--      需要匯率的是訂閱月費與閘道的 USD 計價，不是這裡。
--   2. 兩張表的 project.id 完全沒有交集，所以不需要跨表去重。
--      但仍以 source 分列保存，將來任一專案換帳單帳戶時才看得出斷點。
--   3. service='Invoice' 是發票層級的調整與稅金（Billing Adjustment、Tax），
--      與明細列是同一筆錢的兩種表示。抓取時排除，否則總額會灌水。

CREATE TABLE IF NOT EXISTS costscale.billing_daily (
  id         BIGSERIAL PRIMARY KEY,
  -- 'vertex'（vertex-billing）或 'aistudio'（aistudio-billing）。哪一本帳。
  source     TEXT NOT NULL,
  day        DATE NOT NULL,
  project_id TEXT NOT NULL,
  -- 歸戶結果。兩套規則：Vertex 讀 client_id 標籤，AI Studio 只能靠專案。
  -- 取不到就是 '(未標示)'，不要猜，也不要丟掉。
  client_id  TEXT NOT NULL,
  service    TEXT NOT NULL,
  sku        TEXT NOT NULL,
  currency   TEXT NOT NULL,
  -- 三個金額都存。gross 是未扣抵免額的原價，credit 是抵免（負值），net = gross + credit。
  -- 試用額度期間 net 恆為零，只看 net 會誤以為沒花錢；只看 gross 又不是實際支出。
  -- 比照 budgets 的處理：兩種數字一律都算出來給人看。
  gross      NUMERIC(16,6) NOT NULL DEFAULT 0,
  credit     NUMERIC(16,6) NOT NULL DEFAULT 0,
  net        NUMERIC(16,6) NOT NULL DEFAULT 0,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, day, project_id, client_id, service, sku)
);

CREATE INDEX IF NOT EXISTS idx_billing_daily_day ON costscale.billing_daily(day DESC);
CREATE INDEX IF NOT EXISTS idx_billing_daily_client ON costscale.billing_daily(client_id, day DESC);

-- 匯出水位。這張表存在的理由：帳單匯出會回填，資料不是從啟用日往後長，
-- 而是從過去往現在補。2026-08-21 實測到 Vertex 那份一小時內從 8/05 補到 8/08。
-- 沒有這個水位，介面會拿一份還沒補完的資料算「本月花費」，顯示一個偏低但看起來正常的數字。
-- 那是最危險的狀態，所以 max_usage_day 必須顯示在介面上。
CREATE TABLE IF NOT EXISTS costscale.billing_export_state (
  source          TEXT PRIMARY KEY,
  -- 匯出端最後一次寫入的時間。停止前進代表匯出斷了。
  max_export_time TIMESTAMPTZ,
  -- 資料目前補到哪一天。這一天之後的費用還沒進來，不是沒花錢。
  max_usage_day   DATE,
  rows_seen       BIGINT NOT NULL DEFAULT 0,
  -- 被排除的發票層級金額，記下來才知道排除了什麼、排除得對不對。
  excluded_gross  NUMERIC(16,6) NOT NULL DEFAULT 0,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE costscale.billing_daily IS
  '兩本帳的 BigQuery 帳單匯出合併後的逐日費用。幣別 TWD，已排除 Invoice 層級列。';
COMMENT ON TABLE costscale.billing_export_state IS
  '帳單匯出的水位。max_usage_day 之後的費用尚未進來，介面必須顯示，否則本月花費會偏低而不自知。';
