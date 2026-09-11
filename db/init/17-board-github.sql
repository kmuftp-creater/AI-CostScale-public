-- Phase 5 A2：GitHub 側看板資料的快取（2026-08-22）
--
-- App Hub 的做法是每次請求即時打 GitHub API，再用 KV 快取活動時間，
-- 受 Cloudflare 免費方案「每請求 50 個子請求」的限制。
-- 併入後改成**排程同步、頁面只讀資料庫**：看板變快，GitHub 掛了看板也不掛，
-- 只是資料舊（synced_at 會顯示）。
--
-- 一列一個 tracked repo。status_json 是 repo 裡 doc/status.json 的原文，
-- 看板頁自己解析——不在同步端攤平，讓同步端保持「搬運工」的單純角色。

CREATE TABLE IF NOT EXISTS costscale.board_github (
  repo          TEXT PRIMARY KEY,       -- full_name（your-org/your-repo）
  name          TEXT NOT NULL,          -- repo 短名
  description   TEXT NOT NULL DEFAULT '',
  html_url      TEXT NOT NULL DEFAULT '',
  repo_created  DATE,
  repo_pushed   TIMESTAMPTZ,
  status_json   JSONB,                  -- doc/status.json 原文；null = repo 沒有這個檔
  last_activity DATE,                   -- 最近一次程式碼提交日（分支彙總）
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE costscale.board_github IS
  '看板的 GitHub 側資料快取，由 sync-board-github.py 排程更新。頁面只讀這裡，不打 GitHub。';
