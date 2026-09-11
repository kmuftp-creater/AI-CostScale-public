-- 訂閱制 CLI 的「逐 session 用量」（2026-08-23，D-2／C-9）
--
-- 為什麼不塞進 otel_usage：
--   otel_usage 是「每收到一批 OTLP 就 insert 一列」的流水帳，欄位語意是增量。
--   Codex 沒有可用的 OTLP token 資料（2026-08-23 實測：logs／metrics／traces
--   三種都接過，payload 裡完全沒有 token 欄位），只能改讀它自己的 session 檔
--   ~/.codex/sessions/年/月/日/rollout-*.jsonl。那裡面的 total_token_usage 是
--   **該 thread 的累計值**，而且 session 還在跑的時候會一直長大。
--   累計值用 insert 會愈加愈多，必須以 session 為單位覆寫，語意跟 otel_usage 相反，
--   所以另立一張表，不要硬塞。
--
-- 一個 rollout 檔＝一列。同一個 session 重複回報就覆蓋，跑幾次都不會重複計算。

CREATE TABLE IF NOT EXISTS costscale.cli_session_usage (
  source        TEXT NOT NULL,
  -- rollout 檔的 thread id（session_meta 的 payload.id），檔名裡也有。
  session_id    TEXT NOT NULL,
  model         TEXT,
  -- session 開始時間，取自 session_meta 的 timestamp。
  started_at    TIMESTAMPTZ NOT NULL,
  -- 最後一個 token_count 事件的時間。用來判斷這個 session 還活著沒有。
  last_event_at TIMESTAMPTZ NOT NULL,

  input_tokens        BIGINT NOT NULL DEFAULT 0,
  cached_input_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens  BIGINT NOT NULL DEFAULT 0,
  output_tokens       BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens    BIGINT NOT NULL DEFAULT 0,
  total_tokens        BIGINT NOT NULL DEFAULT 0,

  -- Codex Desktop 會為每個子代理開一個 thread，數量遠多於人自己開的對話。
  -- 這兩欄留著才分得出「我自己打的」與「子代理自動跑的」。
  originator    TEXT,
  thread_source TEXT,

  -- token_count 事件同時帶訂閱額度用量（rate_limits.primary），順手收下來。
  -- 這是供應商自己回報的百分比，比我們自己算的可靠。
  quota_used_pct       DOUBLE PRECISION,
  quota_window_minutes INT,
  quota_resets_at      TIMESTAMPTZ,
  plan_type            TEXT,

  -- 哪一台電腦回報的。多台機器共用同一個 Codex 帳號時要分得出來。
  host          TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (source, session_id)
);

CREATE INDEX IF NOT EXISTS cli_session_usage_last_event_idx
  ON costscale.cli_session_usage (last_event_at DESC);

COMMENT ON TABLE costscale.cli_session_usage IS
  '訂閱制 CLI 逐 session 的累計 token。以 session 為單位覆寫，不是流水帳——'
  '來源檔的數字本身就是累計值，用 insert 會重複計算。';
