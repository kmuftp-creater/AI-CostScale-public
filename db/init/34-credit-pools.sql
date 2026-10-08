-- GCP 贈金餘額與「剩多少就該換帳號」的警示線（2026-10-08）
--
-- 起因：GCP 帳號每月發的贈金（例如 Google Developer Program）用完之後，
-- 超出的部分會直接扣真錢。要在用完之前提醒「該換帳號了」。
--
-- 為什麼要自己算：GCP 的帳單匯出只有「這一天被抵掉多少」（billing_daily.credit），
-- 沒有「還剩多少」。剩餘餘額只在控制台的「抵免額」頁看得到，沒有 API 可以抓。
-- 所以用「某一天在控制台讀到的餘額」當錨點，之後每天扣掉帳單上的抵免額：
--
--     預估餘額 = anchor_balance_twd + 錨點日之後補記的贈金 − 錨點日起被抵掉的金額
--
-- 每月新發的贈金**不自動假設**：金額每個月可能不同（以美金換算），
-- 而且計畫哪天停了也不會有人通知。沒補記的時候預估值偏低，警示只會提早、
-- 不會晚到——晚到的代價是真的被扣錢，早到的代價只是多看一次控制台。
--
-- 這裡只放結構。哪個帳號、錨點餘額多少，是某天看控制台的判斷，
-- 用 INSERT 自己登記一列（billing_source 填 billing_daily.source 的值），
-- 不要放進 db/init（重建資料庫時不該重播）。

CREATE TABLE IF NOT EXISTS costscale.credit_pools (
  id                 SERIAL PRIMARY KEY,
  label              TEXT NOT NULL,
  -- 對應 billing_daily.source。一份帳單匯出＝一個帳單帳戶。
  billing_source     TEXT NOT NULL,
  console_url        TEXT,
  anchor_balance_twd NUMERIC(14,2) NOT NULL,
  -- 錨點餘額是「這一天開始之前」的餘額：這天（含）以後的抵免額都要扣。
  anchor_day         DATE NOT NULL,
  warn_below_twd     NUMERIC(14,2) NOT NULL DEFAULT 50,
  enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  -- 已經寄過警示的時間。校正或補記贈金時清掉，讓下一次跌破重新通知。
  alerted_at         TIMESTAMPTZ,
  alert_error        TEXT,
  note               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credit_pools_warn_ck CHECK (warn_below_twd >= 0)
);

CREATE TABLE IF NOT EXISTS costscale.credit_pool_grants (
  id          SERIAL PRIMARY KEY,
  pool_id     INT NOT NULL REFERENCES costscale.credit_pools(id) ON DELETE CASCADE,
  granted_on  DATE NOT NULL,
  amount_twd  NUMERIC(14,2) NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credit_pool_grants_amount_ck CHECK (amount_twd > 0)
);

CREATE INDEX IF NOT EXISTS idx_credit_pool_grants_pool
  ON costscale.credit_pool_grants (pool_id, granted_on);

COMMENT ON COLUMN costscale.credit_pools.anchor_balance_twd IS
  '某一天在 GCP 控制台「抵免額」頁讀到的剩餘總額（所有可用贈金相加）。校正時整筆覆寫。';
COMMENT ON COLUMN costscale.credit_pools.anchor_day IS
  '錨點日。這一天（含）起 billing_daily 的抵免額會從錨點餘額扣掉。';
COMMENT ON COLUMN costscale.credit_pool_grants.granted_on IS
  '贈金的開始日期（控制台「開始日期」欄）。早於錨點日的不計——已經含在錨點餘額裡。';
