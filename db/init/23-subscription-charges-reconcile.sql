-- 訂閱扣款的對帳欄位（2026-08-25，D-2）
--
-- 起因：`subscription_charges` 存的是「牌告匯率 × (1 + fx_markup_pct/100)」
-- 算出來的**預期**台幣金額。但 `fx_markup_pct` 預設 1.5 是**猜的**——
-- 信用卡外幣扣款走的是發卡組織匯率再加銀行手續費，各家不同，
-- 而且發卡組織匯率本身就不等於牌告匯率。
--
-- 存了預期值卻不跟實際入帳比對，等於只做了一半：
-- 帳面永遠是「照假設算出來的數字」，而沒有人知道那個假設偏多少。
--
-- 這裡只加兩欄，不動任何既有欄位：
--   actual_twd    信用卡帳單上的實際入帳金額，人工填。NULL＝尚未對帳。
--   reconciled_at 填入時間。用來分辨「還沒對」與「對過但金額剛好相同」。
--
-- 刻意不存「差額」與「反推的手續費率」：那兩個都是 actual_twd 與既有欄位
-- 的函數，存起來就會有兩份可能不一致的真相。查詢時算即可。

ALTER TABLE costscale.subscription_charges
  ADD COLUMN IF NOT EXISTS actual_twd    NUMERIC(16,2),
  ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ;

-- 對帳金額必須是正數。0 或負數一定是填錯，不是「這期沒扣款」——
-- 沒扣款的話這一列根本不會存在。
ALTER TABLE costscale.subscription_charges
  DROP CONSTRAINT IF EXISTS subscription_charges_actual_twd_check;
ALTER TABLE costscale.subscription_charges
  ADD CONSTRAINT subscription_charges_actual_twd_check
  CHECK (actual_twd IS NULL OR actual_twd > 0);

COMMENT ON COLUMN costscale.subscription_charges.actual_twd IS
  '信用卡帳單上的實際入帳台幣金額，人工填。NULL 表示尚未對帳。'
  '與 amount_twd（依牌告匯率＋假設手續費率算出的預期值）的差額，'
  '反推得出該卡真實的外幣交易成本，用來校正 settings.fx_markup_pct。';
COMMENT ON COLUMN costscale.subscription_charges.reconciled_at IS
  '對帳填入的時間。用來分辨「還沒對帳」與「對過而且金額剛好相同」。';
