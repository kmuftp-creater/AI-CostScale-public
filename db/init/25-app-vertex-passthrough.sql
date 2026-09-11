-- 標記哪些軟體需要 Vertex 直通（2026-08-26）。
--
-- 起因：金鑰白名單原本用萬用樣式（gemini-*、groq-*、vertex_ai/* …），
-- 而 LiteLLM 的 /v1/models 是**原樣回傳白名單**，再把 vertex_ai/* 展開成
-- Vertex 型錄的全部內容。結果每個專案後台的「讀取可用模型」下拉會出現
-- 96 筆，其中 91 筆是 vertex_ai/claude-* 這種打不到的東西，
-- 而真正能用的部署名（groq-fast、gemini-flash-free…）一個都不在裡面。
--
-- 修法是把白名單換成明確的部署名。但 vertex_ai/* 不能一律拿掉——
-- 那是 Vertex 直通（passthrough）在用的，某個試穿專案的規格書裡有。
-- 直通的模型名是 Google 型錄那一整套，列不完，只能維持萬用。
--
-- 所以改成逐軟體標記：只有真的要直通的才保留 vertex_ai/*，
-- 其餘拿到乾淨的明確清單。實查 nginx 紀錄，直通最後一次被呼叫是 2026-08-23。

ALTER TABLE costscale.apps
  ADD COLUMN IF NOT EXISTS vertex_passthrough boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN costscale.apps.vertex_passthrough IS
  '這個軟體是否需要 Vertex 直通（/vertex_ai/... 路徑）。true 才會在金鑰白名單裡保留 vertex_ai/*；'
  '保留的代價是該軟體的 /v1/models 會多出上百筆展開的 Vertex 型錄。';

-- 需要直通的軟體，到「應用程式」頁或直接 UPDATE costscale.apps SET vertex_passthrough = true WHERE name = '<軟體名>';
