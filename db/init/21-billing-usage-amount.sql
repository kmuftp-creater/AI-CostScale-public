-- 帳單匯出的「用量」欄位（2026-08-23）
--
-- 為什麼要加：AI Studio（Gemini API）那本帳沒有 Vertex 那種
-- aiplatform.googleapis.com/publisher/online_serving/token_count 監控指標，
-- 而服務帳戶也只在 Vertex 專案裡有監控權限，所以 gcp_usage 一直只有
-- your-gcp-project 一個專案。
--
-- BigQuery 帳單匯出裡的 usage.amount 對 token 類的 SKU 就是 token 數，
-- 兩本帳都有，用同一支既有的抓取腳本就拿得到，不必再開權限。
--
-- 單位字面上是 "requests"，那是 Google 對「可計費單位個數」的統稱，
-- 不是請求次數：Gemini 3.1 Flash Lite 文字輸入 30 天 1,140 萬，
-- 同期實際請求只有一千多次（2026-08-23 實測）。
--
-- 限制：只涵蓋「有計費」的用量。AI Studio 免費層不進帳單匯出，
-- 那五把免費金鑰的 token 在這裡看不到，只能看閘道自己記的。

ALTER TABLE costscale.billing_daily
  ADD COLUMN IF NOT EXISTS usage_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usage_unit   TEXT;

COMMENT ON COLUMN costscale.billing_daily.usage_amount IS
  '帳單記的可計費單位個數。token 類 SKU 即為 token 數，不是請求次數。';
