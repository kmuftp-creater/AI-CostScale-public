-- 訂閱的稅率（2026-09-21）
--
-- 起因：Anthropic 2026-09-21 的發票長這樣——
--     Max plan - 20x        US$200.00
--     VAT – Taiwan (5%)     US$7.55（對小計 US$151.06）
--     應付                  US$158.61
-- 也就是**每月實際扣的是 US$210，不是牌價 US$200**。
--
-- 系統原本沒有稅的概念，`fee` 一欄同時被當成「牌價」與「實付」。
-- 照牌價填會每月少記 US$10；照含稅填則畫面上的月費對不上官方任何一頁，
-- 三個月後沒人知道那個數字是怎麼來的。兩種都不行，所以把稅獨立成一欄。
--
-- **語意（整套算式只有這一條，改任何一處都要回來看）：**
--     原幣應付 = fee × (1 + tax_pct/100)
--     台幣預期 = 原幣應付 × fx_rate × (1 + markup_pct/100)
-- fee 一律是**未稅牌價**，tax_pct 是加在它上面的稅率，
-- markup_pct 是信用卡外幣交易成本——三者是三件不同的事，不要合併。
--
-- 為什麼 charges 也要存一份：跟 fee、fx_rate、plan 同一個理由。
-- 稅率會變（法規、供應商的稅務處理、換帳單國家），
-- 不存快照的話改一次稅率，所有歷史扣款的台幣金額就會被重算。
--
-- 預設 0 讓既有資料原樣成立：那些扣款當初就是按未稅金額記的，
-- tax_pct = 0 代入上面的算式會得到與現在完全相同的 amount_twd。
--
-- **人工補的那一筆（source = 'manual'）tax_pct 一律 0**，這是刻意的：
-- 人工補的金額填的是「信用卡實際被扣多少」，本來就含稅了，
-- 再乘一次稅率會重複計算。理由寫在 lib/db.ts 的 addManualCharge。

ALTER TABLE costscale.subscriptions
  ADD COLUMN IF NOT EXISTS tax_pct NUMERIC(6,3) NOT NULL DEFAULT 0;

ALTER TABLE costscale.subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_tax_pct_check;
ALTER TABLE costscale.subscriptions
  ADD CONSTRAINT subscriptions_tax_pct_check CHECK (tax_pct >= 0 AND tax_pct < 100);

ALTER TABLE costscale.subscription_charges
  ADD COLUMN IF NOT EXISTS tax_pct NUMERIC(6,3) NOT NULL DEFAULT 0;

ALTER TABLE costscale.subscription_charges
  DROP CONSTRAINT IF EXISTS subscription_charges_tax_pct_check;
ALTER TABLE costscale.subscription_charges
  ADD CONSTRAINT subscription_charges_tax_pct_check CHECK (tax_pct >= 0 AND tax_pct < 100);

COMMENT ON COLUMN costscale.subscriptions.tax_pct IS
  '加在 fee 上面的稅率（%）。例：台灣 VAT 填 5，fee 填未稅牌價 200，實付即 210。'
  '0＝牌價就是實付。不要把稅併進 fee，那會讓月費對不上供應商的官方價目。';
COMMENT ON COLUMN costscale.subscription_charges.tax_pct IS
  '扣款當下的稅率快照。台幣預期金額＝fee ×(1+tax_pct/100)× fx_rate ×(1+markup_pct/100)。'
  'source=manual 的列一律 0：人工補的金額填的是實際被扣的錢，已經含稅。';
