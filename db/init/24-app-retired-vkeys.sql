-- 記住每個軟體換掉的舊虛擬金鑰（2026-08-26）。
--
-- 起因：做「重新簽發」時發現一個會靜靜出錯的後果——
-- 歸戶是拿 apps.vkey_id 去比對 LiteLLM_SpendLogs.api_key，
-- 換一把金鑰之後，舊 token 的歷史紀錄還在，但對不回任何軟體，
-- 於是那個專案過去的花費會從排行榜上消失、跑進「未歸戶」那一列。
--
-- 沒有錯誤訊息、數字加起來也還是對的，只是歸錯地方——
-- 這種錯不會有人發現。所以換金鑰時要把舊的記下來，歸戶時一起比對。
--
-- 用陣列而不是另開一張表：一個軟體換金鑰的次數是個位數，
-- 為了個位數的列開一張表、多一次 join，代價比省下來的多。

ALTER TABLE costscale.apps
  ADD COLUMN IF NOT EXISTS retired_vkey_ids text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN costscale.apps.retired_vkey_ids IS
  '這個軟體用過但已撤銷的虛擬金鑰雜湊，最舊的在前。歸戶時要連同 vkey_id 一起比對。';
