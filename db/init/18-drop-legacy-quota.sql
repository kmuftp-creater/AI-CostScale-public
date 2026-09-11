-- 移除被 quota_pools 取代的三張舊表（2026-08-22，C-8，User 核准）
--
-- 這三張表是 Phase 1 設計的「一把金鑰對一條額度規則」那一套。
-- 2026-08-20 免費額度計數改以「金鑰池」為單位實作（09-quota-pools.sql），
-- 原因寫在該檔開頭：閘道的實際結構對不回金鑰（OpenRouter 100 個模型共用一個
-- 部署 id、Groq 的部署數是金鑰數的兩倍、閘道刻意不外露金鑰值）。
--
-- 從那時起這三張表就一列資料都沒有，也沒有任何程式讀寫它們
-- （2026-08-22 實查：dashboard 與 scripts 全無引用，正式機三張表皆 0 列）。
-- 留著的唯一效果是讓後來的人以為那是還在用的東西，所以刪掉。
--
-- 刪除順序由外鍵決定：counters → rules → keys。
-- **刻意不加 CASCADE**：真有意料外的相依時要讓它報錯，
-- 而不是安靜地把別的東西一起帶走。
DROP TABLE IF EXISTS costscale.quota_counters;
DROP TABLE IF EXISTS costscale.quota_rules;
DROP TABLE IF EXISTS costscale.upstream_keys;
