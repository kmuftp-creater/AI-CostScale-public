-- Phase 5 A 案 A1：看板資料落地（2026-08-22）
--
-- 來源是 App Hub 的 Cloudflare KV（namespace OVERRIDES）。它不是關聯式資料，
-- 是三種 JSON 文件加三個設定鍵，所以這裡的設計原則是**先保真、再正規化**：
--   1. 常查詢、要排序的欄位拉成欄（name、status、category、pushed_at…）
--   2. 形狀自由的部分留 JSONB（cycles、links、apps、tags）
--   3. 每列都存 raw（原始 KV 值原封不動）——遷移對帳的最後防線，
--      欄位對映若有遺漏，資料還在 raw 裡，不會丟
--
-- act:*（GitHub 活動快取，TTL 6 小時）刻意不遷：那是暫態快取，
-- A4 的同步排程會重建，遷了反而帶進過期資料。
--
-- config:tracked／config:categories／config:apps 三個設定鍵
-- 存進 costscale.settings（board_tracked、board_categories、board_apps），
-- 值維持 JSON 陣列字串——與 KV 相同形狀，讀寫端最不容易搬錯。

CREATE TABLE IF NOT EXISTS costscale.board_cards (
  -- 沿用 KV 鍵當主鍵（draft:d_xxx、push:your-repo），逐筆對帳時兩邊同名。
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL CHECK (source IN ('draft', 'pushed')),
  name        TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  -- planned / in-progress / done。看板的三欄就是這個欄位。
  status      TEXT NOT NULL DEFAULT 'planned'
              CHECK (status IN ('planned', 'in-progress', 'done')),
  category    TEXT NOT NULL DEFAULT '',
  host        TEXT NOT NULL DEFAULT '',
  path        TEXT NOT NULL DEFAULT '',
  summary     TEXT NOT NULL DEFAULT '',
  progress    TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  apps        JSONB NOT NULL DEFAULT '[]',
  links       JSONB NOT NULL DEFAULT '[]',
  cycles      JSONB NOT NULL DEFAULT '[]',
  tags        JSONB NOT NULL DEFAULT '[]',
  -- 原始資料的 updatedAt 是字串日期（本機 status.json 寫什麼就是什麼），
  -- 不強轉 timestamptz——轉失敗會丟資料，而它只用來顯示與排序。
  updated_at  TEXT NOT NULL DEFAULT '',
  pushed_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ,
  raw         JSONB NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_board_cards_status ON costscale.board_cards (status, name);

-- 手動「標記完成／退回」的狀態覆寫，蓋在 GitHub repo 的 status.json 之上。
-- repo 是 full_name（your-org/your-repo）。
CREATE TABLE IF NOT EXISTS costscale.board_overrides (
  repo        TEXT PRIMARY KEY,
  status      TEXT NOT NULL CHECK (status IN ('planned', 'in-progress', 'done')),
  end_date    DATE,
  raw         JSONB NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- GitHub repo 的活動快取（A2 起由 CostScale 自己維護，取代 KV 的 act:*）。
-- A1 先建表不灌資料；同步排程在 A4。
CREATE TABLE IF NOT EXISTS costscale.board_activity (
  repo          TEXT PRIMARY KEY,
  last_activity DATE,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE costscale.board_cards IS
  '專案看板卡片（App Hub 併入，A1 遷移）。raw 是原始 KV 值，對帳與補漏用，不可省。';
COMMENT ON TABLE costscale.board_overrides IS
  '看板的手動狀態覆寫，優先於 GitHub status.json 的狀態。';
