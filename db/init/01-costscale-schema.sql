-- AI CostScale 擴充資料表（LiteLLM 自建的表不在此檔）
CREATE SCHEMA IF NOT EXISTS costscale;

CREATE TABLE IF NOT EXISTS costscale.apps (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  vkey_id     TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- upstream_keys／quota_rules／quota_counters 曾經在這裡（2026-08-22 移除，C-8）。
-- 那是「一把金鑰對一條額度規則」的舊設計，對不上閘道的實際結構，
-- 免費額度計數已改以金鑰池為單位，見 09-quota-pools.sql 開頭的三點理由。
-- 三張表從未寫入任何資料，正式機的刪除動作在 14-drop-legacy-quota.sql。

CREATE TABLE IF NOT EXISTS costscale.subscriptions (
  id            SERIAL PRIMARY KEY,
  service       TEXT NOT NULL,
  plan          TEXT,
  monthly_fee   NUMERIC NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  billing_day   INT NOT NULL CHECK (billing_day BETWEEN 1 AND 28),
  status        TEXT NOT NULL DEFAULT 'active',
  note          TEXT
);

CREATE TABLE IF NOT EXISTS costscale.otel_usage (
  id            BIGSERIAL PRIMARY KEY,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  source        TEXT NOT NULL,
  model         TEXT,
  input_tokens  BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read    BIGINT NOT NULL DEFAULT 0,
  cache_write   BIGINT NOT NULL DEFAULT 0,
  reasoning     BIGINT NOT NULL DEFAULT 0,
  raw_attrs     JSONB
);
CREATE INDEX IF NOT EXISTS otel_usage_received_idx ON costscale.otel_usage (received_at);

CREATE TABLE IF NOT EXISTS costscale.budgets (
  id            SERIAL PRIMARY KEY,
  scope         TEXT NOT NULL CHECK (scope IN ('global','app')),
  app_id        INT REFERENCES costscale.apps(id),
  monthly_limit NUMERIC NOT NULL,
  alert_pct     INT NOT NULL DEFAULT 80
);

CREATE TABLE IF NOT EXISTS costscale.settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO costscale.settings (key, value) VALUES ('fx_usd_twd', '32.5')
  ON CONFLICT (key) DO NOTHING;
