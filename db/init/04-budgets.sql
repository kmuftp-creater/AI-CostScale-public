-- Phase 4：預算與告警
-- budgets 表在 01 已建立最小欄位，這裡補齊實際需要的部分。
-- 全部用 IF NOT EXISTS／DO 區塊，讓既有資料庫重跑也安全。

ALTER TABLE costscale.budgets ADD COLUMN IF NOT EXISTS label       TEXT;
ALTER TABLE costscale.budgets ADD COLUMN IF NOT EXISTS include_gcp BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE costscale.budgets ADD COLUMN IF NOT EXISTS enabled     BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE costscale.budgets ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE costscale.budgets ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now();

-- 一個全域預算、每個軟體最多一筆。用部分唯一索引表達，避免重複設定互相打架。
CREATE UNIQUE INDEX IF NOT EXISTS budgets_one_global
  ON costscale.budgets ((scope)) WHERE scope = 'global';
CREATE UNIQUE INDEX IF NOT EXISTS budgets_one_per_app
  ON costscale.budgets (app_id) WHERE scope = 'app';

-- app 範圍必須有 app_id，global 範圍必須沒有。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'budgets_scope_app_id_ck'
  ) THEN
    ALTER TABLE costscale.budgets ADD CONSTRAINT budgets_scope_app_id_ck
      CHECK ((scope = 'app' AND app_id IS NOT NULL)
          OR (scope = 'global' AND app_id IS NULL));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'budgets_alert_pct_ck'
  ) THEN
    ALTER TABLE costscale.budgets ADD CONSTRAINT budgets_alert_pct_ck
      CHECK (alert_pct BETWEEN 1 AND 100);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'budgets_monthly_limit_ck'
  ) THEN
    ALTER TABLE costscale.budgets ADD CONSTRAINT budgets_monthly_limit_ck
      CHECK (monthly_limit > 0);
  END IF;
END $$;

-- 告警事件。period 存該月的 1 號，用來讓同一個月同一個等級只發一次。
CREATE TABLE IF NOT EXISTS costscale.budget_alerts (
  id         BIGSERIAL PRIMARY KEY,
  budget_id  INT NOT NULL REFERENCES costscale.budgets(id) ON DELETE CASCADE,
  period     DATE NOT NULL,
  level      TEXT NOT NULL CHECK (level IN ('warn','over')),
  spend_usd  NUMERIC(16,6) NOT NULL,
  limit_usd  NUMERIC(16,6) NOT NULL,
  pct        NUMERIC(6,2)  NOT NULL,
  fired_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  emailed_at TIMESTAMPTZ,
  email_error TEXT,
  UNIQUE (budget_id, period, level)
);
CREATE INDEX IF NOT EXISTS budget_alerts_fired_idx ON costscale.budget_alerts (fired_at DESC);
