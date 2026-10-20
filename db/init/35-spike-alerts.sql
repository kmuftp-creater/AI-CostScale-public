-- 單日花費暴增警示（2026-10-21）
--
-- 起因：只有「每月預算」告警時，某個軟體某天突然暴衝（程式寫錯一直重試、
-- 迴圈沒有出口），要等月預算用到門檻才會發現，那時可能已經燒了好幾天。
-- 閘道又剛改吃有限的贈金帳號，一次失控就可能把贈金燒光。
--
-- 判定：今天（台北日）到目前為止的花費 ≥ 前 7 天每日平均 × 倍數，
-- 而且今天至少花了最低金額（否則一天 US$0.01 的軟體花到 US$0.03 就算暴增）。
-- 今天還沒過完就拿來比，所以只會晚報、不會誤報。
--
-- 門檻存在 costscale.settings（spike_multiplier、spike_min_usd），預算頁可改。
-- 這張表只記「哪個軟體哪天已經報過」，一天一個軟體最多寄一封。

CREATE TABLE IF NOT EXISTS costscale.spike_alerts (
  id            SERIAL PRIMARY KEY,
  app_id        INT NOT NULL REFERENCES costscale.apps(id) ON DELETE CASCADE,
  day           DATE NOT NULL,
  spend_usd     NUMERIC(14,6) NOT NULL,
  baseline_usd  NUMERIC(14,6) NOT NULL,
  multiplier    NUMERIC(6,2) NOT NULL,
  fired_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  emailed_at    TIMESTAMPTZ,
  email_error   TEXT,
  UNIQUE (app_id, day)
);

CREATE INDEX IF NOT EXISTS idx_spike_alerts_day ON costscale.spike_alerts (day DESC);

INSERT INTO costscale.settings (key, value) VALUES ('spike_multiplier', '3')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO costscale.settings (key, value) VALUES ('spike_min_usd', '0.5')
  ON CONFLICT (key) DO NOTHING;
