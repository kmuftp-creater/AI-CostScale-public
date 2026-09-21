-- 手動補一筆訂閱扣款（2026-09-21）
--
-- 起因（User）：「升級是補差額，我有可能是這個月想從 5X 升級成 10X，
-- 我升級時手動輸入費用，如果不調整，下個月就是之前的訂閱價」。
--
-- 在這之前，扣款紀錄**只能**由主機端排程在 billing_day 那天產生，
-- 介面唯一能做的是填「實際入帳金額」做對帳。所以升級當下補的差額
-- 根本沒有地方記——帳面會少一筆真的付出去的錢。
--
-- 兩個欄位：
--   source  'auto'＝排程凍結的，'manual'＝人工補的。要分得出來，
--           因為這兩種的可信度不同：自動那筆的匯率是當天抓的，
--           人工那筆是事後補的，可能隔了幾天。
--   note    補這筆的理由（「5X 升 10X 補差額」）。不寫的話三個月後沒人知道這筆是什麼。
ALTER TABLE costscale.subscription_charges
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS note   TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'subscription_charges_source_check'
       AND conrelid = 'costscale.subscription_charges'::regclass
  ) THEN
    ALTER TABLE costscale.subscription_charges
      ADD CONSTRAINT subscription_charges_source_check CHECK (source IN ('auto', 'manual'));
  END IF;
END $$;

-- 唯一性從「整張表」縮小到「只管自動入帳」。
--
-- 原本的 UNIQUE (sub_id, charged_on) 是為了讓排程同一天重跑不會重複凍結，
-- 那個保證要留著。但它同時也擋住了「同一天補一筆差額」，
-- 而升級日剛好等於扣款日並不是罕見情況。
--
-- **改成部分唯一索引之後，入帳腳本的 ON CONFLICT 必須跟著帶同樣的 WHERE**，
-- 否則 PostgreSQL 找不到對應的唯一約束會直接報錯，每月自動凍結會整個壞掉。
-- scripts/fetch-fx.py 已同步修改，兩邊要一起看。
ALTER TABLE costscale.subscription_charges
  DROP CONSTRAINT IF EXISTS subscription_charges_sub_id_charged_on_key;

CREATE UNIQUE INDEX IF NOT EXISTS subscription_charges_auto_uniq
  ON costscale.subscription_charges (sub_id, charged_on)
  WHERE source = 'auto';

COMMENT ON COLUMN costscale.subscription_charges.source IS
  'auto＝排程在 billing_day 凍結的；manual＝人工補的（升級差額、漏記的一筆）。';
COMMENT ON COLUMN costscale.subscription_charges.note IS
  '人工補這筆的理由。自動入帳不會寫。';
