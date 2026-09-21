-- 扣款紀錄的方案名快照（2026-09-21，選項 C）
--
-- 起因（User，2026-09-21）：Claude 從 5x 升到 20x，Anthropic 收了 US$158.61 的
-- 差額，續約日從每月 7 號改成 10/21。把訂閱那一列的 plan 改成「20x」之後，
-- 扣款歷史裡 9/7 那筆 **5x 的扣款**會跟著顯示成 20x 方案——
-- 那是這個專案反覆踩的同一個坑：**名字說謊**。
--
-- `subscription_charges` 本來就是一張快照表：fee、currency、fx_rate、markup_pct
-- 全部是扣款當下的值，寫進去就不再跟著 `subscriptions` 變。
-- 唯獨「這筆錢買的是哪一個方案」漏了，只能回頭 JOIN 現況表，於是就會說謊。
-- 這裡補上那一欄，理由與那五欄完全相同。
--
-- **刻意不回填既有資料。** 舊資料裡沒有方案名這件事本身是事實；
-- 猜一個填進去，帳面就會有一個看起來像紀錄、實際是推測的值，
-- 而且分不出哪些是推測的。畫面上 NULL 顯示成「—」，
-- 「不知道」與「20x」是兩件事，不能混。
-- 要回填特定幾列請用一次性的 UPDATE，並在開發全紀錄裡留下是誰、依據什麼填的。
ALTER TABLE costscale.subscription_charges
  ADD COLUMN IF NOT EXISTS plan TEXT;

COMMENT ON COLUMN costscale.subscription_charges.plan IS
  '扣款當下的方案名快照（例：5x、20x）。NULL＝這筆紀錄產生時還沒有這一欄，或訂閱本來就沒填方案。'
  '不要改用 JOIN costscale.subscriptions.plan 取代它——那是現況值，會讓歷史扣款顯示成現在的方案。';
