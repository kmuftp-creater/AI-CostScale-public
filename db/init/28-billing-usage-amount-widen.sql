-- billing_daily.usage_amount 放寬精度（2026-09-21）
--
-- 症狀：GCP 帳單從 2026-09-13 之後就沒有再更新，畫面上顯示「資料尚未補齊，落後 8 天」。
-- 但 BigQuery 那邊資料其實到 9/20 都有——每晚的抓取**每一次都當掉**：
--
--   psycopg.errors.NumericValueOutOfRange: numeric field overflow
--   DETAIL: A field with precision 20, scale 6 must round to an absolute value less than 10^14.
--
-- 根因：`usage_amount NUMERIC(20,6)` 的整數部分只有 14 位。
-- 金額不會那麼大，但**用量不是金額**——GCP 的 usage_amount 依 SKU 而異，
-- 位元組、位元組秒這種單位輕易就破 10^14（例如 1 TB·月 ≈ 2.6e18 byte-seconds）。
-- 當初照著金額的尺度給精度，是把兩種數量級不同的東西套用同一個假設。
--
-- 改成不限精度的 NUMERIC。PostgreSQL 的 numeric 本來就支援任意精度，
-- 這裡不需要用精度當檢查——真正該擋的是「金額」，而金額有自己的欄位。
--
-- 一列壞掉會讓整批 INSERT 失敗（同一個交易），所以症狀是「完全不更新」
-- 而不是「少一列」。這種全有全無的失敗最容易被誤讀成「沒花錢」。
ALTER TABLE costscale.billing_daily
  ALTER COLUMN usage_amount TYPE NUMERIC;

COMMENT ON COLUMN costscale.billing_daily.usage_amount IS
  '該 SKU 的用量，單位看 usage_unit。刻意不限精度：位元組秒這類單位會破 NUMERIC(20,6) 的上限（2026-09-21）。';
