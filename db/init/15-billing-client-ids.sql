-- 一個軟體可以有多個歷史帳單標籤（2026-08-21）
--
-- 起因：`app-a-old` 與 `app-a` 是**同一個專案**。
-- 它改過很多次名字，因為 Meta 不允許申請同名的應用程式，
-- 最後才定案 app-a／App A。
-- 舊版程式送出的 client_id 標籤留在帳單裡，所以同一個軟體在
-- GCP 帳單上會出現兩組以上的標籤值。
--
-- 上一版把 billing_client_id 設計成單一欄位，那個假設是錯的。
-- 改成陣列。改名不是特例——只要專案改過名，舊標籤就會一直留在歷史帳單裡，
-- 而歷史帳單是不會被追溯改寫的。

ALTER TABLE costscale.apps ADD COLUMN IF NOT EXISTS billing_client_ids TEXT[];

-- 從舊的單值欄位搬過來，不遺失既有設定。
UPDATE costscale.apps
   SET billing_client_ids = ARRAY[billing_client_id]
 WHERE billing_client_id IS NOT NULL
   AND (billing_client_ids IS NULL OR cardinality(billing_client_ids) = 0);

CREATE INDEX IF NOT EXISTS idx_apps_billing_clients
  ON costscale.apps USING GIN (billing_client_ids);

COMMENT ON COLUMN costscale.apps.billing_client_ids IS
  'GCP 帳單 labels 的 client_id 值，可多個。專案改過名時舊標籤仍留在歷史帳單裡，所以是陣列不是單值。';
COMMENT ON COLUMN costscale.apps.billing_client_id IS
  '已停用，由 billing_client_ids 取代。保留只為了回溯，程式不再讀它。';
