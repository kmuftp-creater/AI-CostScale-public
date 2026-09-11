-- 每個軟體可用哪些訂閱，以及兩種提醒（2026-08-21）
--
-- 設計要點：
-- 1. 可複選。一個軟體可以新聞摘要走 Gemini、產圖走 Codex，
--    所以是「允許清單」不是「單選來源」。
-- 2. 允許清單只決定「能不能打」，不決定「什麼時候打」——
--    後者由專案端的程式決定要呼叫哪個模型名稱。
-- 3. 實際的擋人動作發生在閘道的虛擬金鑰白名單，這張表是「意圖」，
--    要靠同步動作寫到閘道去。兩邊可能不同步，所以介面要顯示同步狀態。

-- 軟體允許使用的訂閱模型。一列一個組合。
CREATE TABLE IF NOT EXISTS costscale.app_subscriptions (
  app_id     INT  NOT NULL REFERENCES costscale.apps(id) ON DELETE CASCADE,
  -- 閘道上的訂閱模型名稱，例如 sub-claude。
  -- 刻意存名稱而不是外鍵：閘道的模型清單不在這個資料庫裡。
  sub_model  TEXT NOT NULL CHECK (sub_model LIKE 'sub-%'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, sub_model)
);

-- 軟體層級的備註與複查日。
-- 複查日的用途：像某個試穿專案這種「現在只有自己用、開賣後必須關掉訂閱」的情況，
-- 靠人記得是不可靠的。填一個日期，到期前一週儀表板會跳橫幅。
ALTER TABLE costscale.apps ADD COLUMN IF NOT EXISTS sub_note   TEXT;
ALTER TABLE costscale.apps ADD COLUMN IF NOT EXISTS review_at  DATE;

-- 閘道同步狀態：這張表寫完之後有沒有真的推到閘道的金鑰白名單。
-- 分開記錄是因為推送可能失敗（閘道不通、金鑰不存在），
-- 而「設定看起來對但實際沒生效」是最危險的狀態，必須看得出來。
ALTER TABLE costscale.apps ADD COLUMN IF NOT EXISTS acl_synced_at TIMESTAMPTZ;
ALTER TABLE costscale.apps ADD COLUMN IF NOT EXISTS acl_error     TEXT;

COMMENT ON TABLE costscale.app_subscriptions IS
  '軟體允許使用的訂閱模型（可複選）。實際擋人在閘道的虛擬金鑰白名單，本表為意圖來源。';
COMMENT ON COLUMN costscale.apps.review_at IS
  '訂閱設定的複查日。到期前一週儀表板顯示提醒，避免「開賣前要關掉」這種事被遺忘。';
COMMENT ON COLUMN costscale.apps.acl_synced_at IS
  '最後一次成功把允許清單推到閘道的時間。為 null 或早於設定變更時間代表尚未生效。';
