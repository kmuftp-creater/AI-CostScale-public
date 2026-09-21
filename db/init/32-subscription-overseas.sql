-- 訂閱是不是海外交易（2026-09-22，待辦 C12）
--
-- 起因：信用卡帳單上這一行——
--     07/27  OPENAI *CHATGPT SUBSCR  US OPENAI.COM  TWD 690   TWD 690
--     07/27  國外交易服務費                                    TWD  10
-- **幣別是台幣，一樣收 1.5% 國外交易服務費**，因為收單商家在海外。
--
-- 而程式一路寫的是「`currency == 'TWD'` 就不換匯也不加手續費」，
-- 那句註解（scripts/fetch-fx.py）說「本來就是台幣，不需要換匯也不該加手續費」——
-- **前半對、後半錯**。換不換匯看幣別，收不收服務費看商家在不在海外，
-- 那是兩件事，被當成同一件事了。
--
-- ## 為什麼是可為 NULL 的三態，不是 boolean 預設 false
--
--   TRUE  ＝ 已確認是海外交易（帳單上看得到「國外交易服務費」那一行）
--   FALSE ＝ 已確認是本地交易
--   NULL  ＝ **還沒確認**
--
-- 這一晚反覆踩的就是「不知道」被寫成「否」之後就再也分不出來。
-- Google One 正是這個情況：年繳、12/28 才扣款，而系統 8/21 才上線，
-- 到現在零筆扣款紀錄，帳單上有沒有那一行**沒有人看過**。
-- 預設 false 的話它會長得跟「已確認是本地交易」一模一樣。
--
-- 計算時 NULL 視同不收（不要憑空生出一筆費用），但畫面上要標「未確認」。
--
-- ## 回填：只填定義上必然為真的
--
-- 幣別不是台幣，就必然是海外交易——這是定義不是判斷，所以放在 migration 裡。
-- 台幣的那幾筆要看帳單，那是人工判斷，走 scripts/oneoff/。

ALTER TABLE costscale.subscriptions
  ADD COLUMN IF NOT EXISTS overseas BOOLEAN;

UPDATE costscale.subscriptions
   SET overseas = TRUE
 WHERE overseas IS NULL
   AND currency <> 'TWD';

COMMENT ON COLUMN costscale.subscriptions.overseas IS
  '這筆訂閱刷卡時算不算海外交易（決定收不收國外交易服務費 settings.fx_markup_pct）。'
  'TRUE＝帳單上看得到「國外交易服務費」那一行；FALSE＝確認是本地交易；NULL＝還沒確認。'
  '不要把 NULL 當 FALSE 存——「不知道」與「不收」是兩件事。'
  '非台幣計價必然為 TRUE；台幣計價要看收單商家在不在海外（例如 OpenAI 以台幣計價但照樣收）。';
