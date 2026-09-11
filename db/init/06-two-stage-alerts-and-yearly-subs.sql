-- 三項調整（2026-08-20 User 提出）
--   1. 警示分兩段：接近上限、嚴重、超標
--   2. 訂閱支援年費
--   3. 預算的 GCP 併計改成「判定依據」，兩種數字一律都算出來給人看

-- ── 1. 兩段警示門檻 ──────────────────────────────────────────────
-- alert_pct 改名成 warn_pct，語意才對得上；另加 critical_pct。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'costscale' AND table_name = 'budgets' AND column_name = 'alert_pct'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'costscale' AND table_name = 'budgets' AND column_name = 'warn_pct'
  ) THEN
    ALTER TABLE costscale.budgets RENAME COLUMN alert_pct TO warn_pct;
  END IF;
END $$;

ALTER TABLE costscale.budgets ADD COLUMN IF NOT EXISTS critical_pct INT NOT NULL DEFAULT 95;

-- 舊的 alert_pct 約束跟著改名，重建成新的兩段約束。
ALTER TABLE costscale.budgets DROP CONSTRAINT IF EXISTS budgets_alert_pct_ck;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budgets_pct_ck') THEN
    ALTER TABLE costscale.budgets ADD CONSTRAINT budgets_pct_ck
      CHECK (warn_pct BETWEEN 1 AND 100
         AND critical_pct BETWEEN 1 AND 100
         -- 嚴重門檻必須高於警示門檻，否則兩段會互相蓋掉
         AND critical_pct > warn_pct);
  END IF;
END $$;

-- 告警等級多一個 critical。
ALTER TABLE costscale.budget_alerts DROP CONSTRAINT IF EXISTS budget_alerts_level_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_alerts_level_ck') THEN
    ALTER TABLE costscale.budget_alerts ADD CONSTRAINT budget_alerts_level_ck
      CHECK (level IN ('warn','critical','over'));
  END IF;
END $$;

-- ── 2. 訂閱年費 ─────────────────────────────────────────────────
-- monthly_fee 這個名字在支援年費後會騙人：年繳時它存的是年費。
-- 改名成 fee，並用 billing_cycle 說明它是哪一個週期的金額。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'costscale' AND table_name = 'subscriptions' AND column_name = 'monthly_fee'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'costscale' AND table_name = 'subscriptions' AND column_name = 'fee'
  ) THEN
    ALTER TABLE costscale.subscriptions RENAME COLUMN monthly_fee TO fee;
  END IF;
END $$;

ALTER TABLE costscale.subscriptions
  ADD COLUMN IF NOT EXISTS billing_cycle TEXT NOT NULL DEFAULT 'monthly';
-- 年繳需要知道是哪個月扣款；月繳時為 NULL。
ALTER TABLE costscale.subscriptions
  ADD COLUMN IF NOT EXISTS billing_month INT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_cycle_ck') THEN
    ALTER TABLE costscale.subscriptions ADD CONSTRAINT subscriptions_cycle_ck
      CHECK (billing_cycle IN ('monthly','yearly'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_billing_month_ck') THEN
    ALTER TABLE costscale.subscriptions ADD CONSTRAINT subscriptions_billing_month_ck
      CHECK ((billing_cycle = 'yearly'  AND billing_month BETWEEN 1 AND 12)
          OR (billing_cycle = 'monthly' AND billing_month IS NULL));
  END IF;
END $$;
