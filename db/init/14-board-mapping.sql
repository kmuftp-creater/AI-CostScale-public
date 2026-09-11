-- 專案名對應表（2026-08-21，Phase 5 B 段前置）
--
-- 為什麼需要：CostScale 這邊的 apps.name 是**虛擬金鑰的別名**
-- （myapp、app-a、app-b、app-d），
-- App Hub 看板那邊的專案名是**資料夾名**（260101-my-app 這類）。
-- 兩者對不起來，沒有對應表就無法把花費掛到專案卡上。
--
-- 還有第二層對不起來的，設計文件當初沒寫到：
-- GCP 帳單的 client_id 標籤又是另一組字串（實查有 myapp_main、app-a、
-- app-b、app-a-old、admin_test）。myapp_main 對不上 apps.name 的
-- myapp，而 app-a-old 根本不在 apps 裡。
-- 靠前綴猜是不可靠的，所以也做成一個明填的欄位。

-- 看板上的專案名（資料夾名）。空的代表這個軟體不出現在看板的花費顯示裡。
ALTER TABLE costscale.apps ADD COLUMN IF NOT EXISTS board_project_name TEXT;

-- GCP 帳單 labels 裡的 client_id 值。空的代表帳單那側無法歸到這個軟體，
-- 介面上會落在「(未標示)」，這是刻意的——寧可顯示未歸戶，不要猜錯歸戶。
ALTER TABLE costscale.apps ADD COLUMN IF NOT EXISTS billing_client_id TEXT;

CREATE INDEX IF NOT EXISTS idx_apps_billing_client
  ON costscale.apps(billing_client_id) WHERE billing_client_id IS NOT NULL;

COMMENT ON COLUMN costscale.apps.board_project_name IS
  'App Hub 看板上的專案名（資料夾名）。與 apps.name 是兩套命名，必須明填不可推導。';
COMMENT ON COLUMN costscale.apps.billing_client_id IS
  'GCP 帳單 labels 的 client_id 值。與 apps.name 也是兩套命名，例如 myapp 對應 myapp_main。';
