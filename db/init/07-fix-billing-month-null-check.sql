-- 修 06 的約束漏洞（2026-08-20 實測抓到）。
--
-- 原本寫成：
--   CHECK ((billing_cycle='yearly'  AND billing_month BETWEEN 1 AND 12)
--       OR (billing_cycle='monthly' AND billing_month IS NULL))
--
-- 年繳且 billing_month 為 NULL 時：
--   第一支 → TRUE AND NULL      → NULL
--   第二支 → FALSE AND ...      → FALSE
--   整體   → NULL OR FALSE      → NULL
--
-- PostgreSQL 的 CHECK **只在結果明確為 FALSE 時才擋，NULL 一律放行**。
-- 於是「年繳但沒指定扣款月份」這種壞資料寫得進去，而且完全沒有錯誤訊息。
-- 補上顯式的 IS NOT NULL，讓 AND 直接短路成 FALSE。
--
-- 通則：CHECK 裡只要有可為 NULL 的欄位，就要先寫 IS NOT NULL／IS NULL，
-- 不能只靠 BETWEEN、=、> 這類比較運算子——它們碰到 NULL 回的是 NULL 不是 FALSE。

-- 先清掉可能已經寫進去的壞資料（年繳卻沒有扣款月份，補成 1 月）。
UPDATE costscale.subscriptions
   SET billing_month = 1
 WHERE billing_cycle = 'yearly' AND billing_month IS NULL;

ALTER TABLE costscale.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_billing_month_ck;
ALTER TABLE costscale.subscriptions ADD CONSTRAINT subscriptions_billing_month_ck
  CHECK ((billing_cycle = 'yearly'
          AND billing_month IS NOT NULL
          AND billing_month BETWEEN 1 AND 12)
      OR (billing_cycle = 'monthly'
          AND billing_month IS NULL));
