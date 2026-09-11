-- 1 小時快取寫入分開記（2026-09-10）
--
-- 起因：Anthropic 的快取寫入有兩種價，5 分鐘 TTL 是 1.25 倍輸入價、
-- 1 小時 TTL 是 2 倍。原本只收 cache_creation_input_tokens 總數、
-- 一律按 5 分鐘價算。
--
-- 2026-09-10 實測本機最近 300 個 Claude Code session 檔的 usage.cache_creation：
--   claude-opus-5     1 小時佔 99.8%
--   claude-opus-4-8   1 小時佔 98.9%
--   claude-fable-5    1 小時佔 99.4%
--   claude-sonnet-5   1 小時佔 0%
-- 所以不能用一個固定倍率修正，只能逐列記下來。
-- 只修寫入價的部分，「若走 API 要付多少」就低估了 US$7,388。
--
-- 語意：cache_write_tokens 仍是**寫入總數**（不改它，舊報表照常能用）；
-- 這一欄是總數裡屬於 1 小時的那一部分，5 分鐘的＝總數減這一欄。
-- 舊資料這一欄是 0，也就是照舊按 5 分鐘價算，重新全掃一次就會補上。

ALTER TABLE costscale.cli_session_usage
  ADD COLUMN IF NOT EXISTS cache_write_1h_tokens BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN costscale.cli_session_usage.cache_write_1h_tokens IS
  'cache_write_tokens 之中屬於 1 小時 TTL 的部分（Claude Code 的 usage.cache_creation.ephemeral_1h_input_tokens）。'
  '5 分鐘 TTL 的部分＝cache_write_tokens − 這一欄。Codex 沒有這個概念，恆為 0。';
