-- pct 原本是 NUMERIC(6,2)，上限 9999.99。
-- 實測時一筆 US$0.01 的預算對上 US$3.67 的實際花費，算出 36741.16%，
-- 直接 numeric field overflow：告警沒寫入、信沒寄出，
-- 唯一痕跡只有一行 console.warn。這種靜默失敗正是告警機制最不能有的。
-- 放寬到 NUMERIC(12,2)，容得下任何離譜的超標倍數。
ALTER TABLE costscale.budget_alerts
  ALTER COLUMN pct TYPE NUMERIC(12,2);
