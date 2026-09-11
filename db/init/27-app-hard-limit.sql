-- 軟體的每月硬上限（2026-09-10）
--
-- 起因：預算頁（04-budgets.sql）只會告警——每小時算一次、超過就寄信，
-- 但請求照樣放行。一個專案半夜寫錯迴圈，會一路燒到有人看到信為止。
-- User 裁決：超過就拒絕。
--
-- 做法不是自己寫攔截：LiteLLM 的虛擬金鑰本身就有 max_budget／budget_duration，
-- 超過時閘道直接回錯誤、不會轉發給供應商。這裡只記「使用者設了多少」，
-- 真正執行的是閘道。
--
-- 為什麼還要在這邊存一份：重新簽發金鑰（rotate-key）會換成一把全新的金鑰，
-- 新金鑰上什麼限制都沒有。不存的話，換一次鑰上限就默默消失了。
--
-- 單位是美元，因為閘道記帳與比對都用美元。畫面上一律同時顯示台幣，
-- 並寫明台幣是按當下匯率換算的參考值——匯率會動，美元上限不會。

ALTER TABLE costscale.apps
  ADD COLUMN IF NOT EXISTS hard_limit_usd numeric(12, 4);

COMMENT ON COLUMN costscale.apps.hard_limit_usd IS
  '每月硬上限（美元）。NULL＝不設限。實際執行在 LiteLLM 虛擬金鑰的 max_budget（budget_duration=1mo）；'
  '這裡存一份是為了重新簽發金鑰時能套回新金鑰。';
