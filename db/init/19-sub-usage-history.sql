-- 訂閱額度的歷史軌跡（2026-08-22，D-3）
--
-- sub_usage 只存最新值（13 檔的設計，當時需求只是「還剩多少」）。
-- 三家都上線之後，「照這個用法幾號會用完」變成答得出來的問題，
-- 但那需要斜率，斜率需要歷史。所以另立一張 append-only 表，
-- 不動 sub_usage——「目前值」與「軌跡」是兩種讀法，混在一張表會兩頭不討好。
--
-- 每次抓取都寫一列，包含「沒變化」的點：沒變化本身就是速率資訊，
-- 只記變化點會讓斜率在平緩期算不出來。
-- 15 分鐘一次、七個視窗，一天約 672 列，保留 30 天約兩萬列，體積不是問題。
-- 逾期清理由抓取腳本順手做，不另設排程。
--
-- 讀取端要注意：視窗重置時 used_percent 會驟降，
-- 算斜率只能用同一個週期內的點（以 used 驟降處為界），跨界會算出負速率。

CREATE TABLE IF NOT EXISTS costscale.sub_usage_history (
  id                BIGSERIAL PRIMARY KEY,
  provider          TEXT NOT NULL,
  window_label      TEXT NOT NULL,
  used_percent      NUMERIC(5,2) NOT NULL CHECK (used_percent BETWEEN 0 AND 100),
  remaining_percent NUMERIC(5,2) NOT NULL CHECK (remaining_percent BETWEEN 0 AND 100),
  reset_at          TIMESTAMPTZ,
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sub_usage_history_lookup
  ON costscale.sub_usage_history (provider, window_label, fetched_at DESC);

COMMENT ON TABLE costscale.sub_usage_history IS
  '訂閱額度的逐次抓取紀錄，append-only，保留 30 天。燃燒速率與用完預測從這裡算。';
