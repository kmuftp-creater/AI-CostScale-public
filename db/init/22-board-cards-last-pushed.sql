-- 看板卡片的「最後一次收到推送」時間（2026-08-23，C-8）
--
-- 原本只有 pushed_at，而且是 COALESCE(舊值, 新值)——只在第一次推送時寫入、
-- 之後永不更新。於是看不出一張卡是「還在被推」還是「早就沒人推了」。
--
-- 這不是理論問題：auto-line 與 260708-Auto-Line 兩張卡的 host 與 path 完全相同，
-- 看起來是改名之後舊卡沒清，但因為查不到「最後一次收到推送」，
-- 無法確定是不是另一台電腦還在推舊名字（第四十七節 C-7）。
--
-- 兩個欄位語意不同，都要留：
--   pushed_at       這張卡是什麼時候第一次出現的
--   last_pushed_at  還有沒有人在推
--
-- 刻意不回填。把 last_pushed_at 設成 pushed_at 會讓「最後推送」看起來是很久以前，
-- 那是憑空捏造的事實。留 NULL、介面顯示「尚未收到新推送」，
-- 之後只要那台電腦還在推就會自己補上——沒補上的那些，本身就是答案。

ALTER TABLE costscale.board_cards
  ADD COLUMN IF NOT EXISTS last_pushed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_board_cards_last_pushed
  ON costscale.board_cards (last_pushed_at DESC NULLS LAST);

COMMENT ON COLUMN costscale.board_cards.pushed_at IS
  '第一次收到推送的時間，之後不再更動。';
COMMENT ON COLUMN costscale.board_cards.last_pushed_at IS
  '最後一次收到推送的時間，每次推送都更新。NULL = 這個欄位加上之後還沒收過推送。';
