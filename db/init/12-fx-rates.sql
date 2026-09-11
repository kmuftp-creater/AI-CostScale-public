-- 匯率自動抓取與扣款當時匯率凍結（2026-08-21）
--
-- 起因：settings.fx_usd_twd 是手動填的 32.5，會過期而且沒有人會記得改。
--
-- 一個必須先講清楚的範圍限制：
-- 兩本帳的 GCP 帳單匯出是以 **TWD** 計價的（2026-08-21 實查 currency 欄，
-- 1247 列全部是 TWD），所以 billing_daily 不需要換匯。
-- 需要換匯的只有兩處：訂閱月費／年費（多為 USD），以及閘道 LiteLLM 的 USD 計價。
--
-- 為什麼要保留歷史匯率：
-- 不保留的話，回頭看 7 月的台幣金額會被 8 月的匯率改寫，跟信用卡帳單永遠對不起來，
-- 而且對不起來時分不清是匯率造成的還是漏記造成的。
-- 規則：已發生的扣款用當時匯率、寫進去就不再重算；未來的預估用最新匯率，介面標成估算。

-- 每日匯率。一天一組幣別一列，重跑同一天會覆蓋。
CREATE TABLE IF NOT EXISTS costscale.fx_rates (
  day        DATE NOT NULL,
  base       TEXT NOT NULL,
  quote      TEXT NOT NULL,
  rate       NUMERIC(16,6) NOT NULL CHECK (rate > 0),
  -- 來源要記。換來源時匯率會出現一個小跳動，沒有這欄會看成資料錯誤。
  source     TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, base, quote)
);

-- 訂閱的扣款紀錄。這張表是「當時匯率」唯一的存放處。
-- 原本系統沒有這張表，訂閱頁是拿 fee × 當下匯率即時算的，
-- 所以歷史金額會隨匯率浮動——那正是要修掉的問題。
CREATE TABLE IF NOT EXISTS costscale.subscription_charges (
  id         BIGSERIAL PRIMARY KEY,
  sub_id     INT NOT NULL REFERENCES costscale.subscriptions(id) ON DELETE CASCADE,
  charged_on DATE NOT NULL,
  -- 下面五欄一律是扣款當下的快照，不跟著 subscriptions 或 fx_rates 變動。
  -- 訂閱之後改月費、改幣別，都不該動到已經發生的帳。
  fee        NUMERIC(16,6) NOT NULL,
  currency   TEXT NOT NULL,
  -- 幣別為 TWD 時 fx_rate 記 1、markup_pct 記 0，不是留 NULL。
  -- 留 NULL 會讓下游每個查詢都要處理空值，而 1 在算式上就是正確答案。
  fx_rate    NUMERIC(16,6) NOT NULL CHECK (fx_rate > 0),
  fx_source  TEXT NOT NULL,
  -- 信用卡外幣扣款走的是發卡組織匯率再加銀行手續費，不是牌告匯率。
  -- 不加這一層，帳面會系統性低估約 1.5%。
  markup_pct NUMERIC(6,3) NOT NULL DEFAULT 0,
  amount_twd NUMERIC(16,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sub_id, charged_on)
);

CREATE INDEX IF NOT EXISTS idx_sub_charges_date
  ON costscale.subscription_charges(charged_on DESC);

-- 手續費率。預設 1.5%，是常見的國外交易手續費，實際依發卡行調整。
INSERT INTO costscale.settings (key, value) VALUES ('fx_markup_pct', '1.5')
  ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE costscale.fx_rates IS
  '每日匯率。訂閱與閘道的 USD 計價用；GCP 帳單匯出本身即為 TWD，不經此表。';
COMMENT ON TABLE costscale.subscription_charges IS
  '訂閱扣款紀錄。fx_rate 是扣款當天的匯率快照，寫入後不重算，否則歷史台幣金額會被新匯率改寫。';
COMMENT ON COLUMN costscale.settings.value IS
  'fx_usd_twd 在自動抓取上線後降為備援：fx_rates 取不到資料時才用它。';
