# AI CostScale Dashboard

AI 用量與成本管理中心，Next.js App Router + TypeScript。Phase 1：閘道與儀表板骨架。

## 本機開發

1. 安裝依賴：

   ```bash
   npm install
   ```

2. 在 `dashboard/` 下建立 `.env.local`（不進版本控制），內容參考：

   ```bash
   # PostgreSQL：DB_PASSWORD 讀專案根目錄 .env
   DATABASE_URL=postgresql://costscale:<DB_PASSWORD>@127.0.0.1:5442/costscale

   # LiteLLM 閘道（本機開發時容器對外開在 4000）
   LITELLM_BASE_URL=http://127.0.0.1:4000
   LITELLM_MASTER_KEY=<與根目錄 .env 的 LITELLM_MASTER_KEY 一致>

   # Auth.js（Google OAuth 白名單制）
   AUTH_SECRET=<與根目錄 .env 的 AUTH_SECRET 一致，或自行產生>
   AUTH_GOOGLE_ID=
   AUTH_GOOGLE_SECRET=
   AUTH_ALLOWED_EMAILS=you@example.com

   # 本機開發可跳過登入；正式環境必須設為 0 或移除
   AUTH_DISABLED=1
   ```

   注意：本機的 PostgreSQL 埠是 `5442`（`docker-compose.yml` 把容器內 `5432` 映射到主機 `127.0.0.1:5442`，避開本機其他專案占用的 `5433`）。

3. 啟動開發伺服器：

   ```bash
   npm run dev
   ```

   開啟 <http://localhost:3000>。`AUTH_DISABLED=1` 時免登入即可瀏覽。

## 建置

```bash
npm run build
npm run start
```

## Docker

```bash
docker build -t ai-costscale-dashboard .
docker run -p 3000:3000 --env-file ../.env ai-costscale-dashboard
```

正式部署由專案根目錄的 `docker-compose.yml` 統一管理（`dashboard` 服務屬於 `full` profile）。

## 目錄結構重點

- `app/globals.css`：設計系統 token 與元件樣式（深色「琥珀鑄場」／亮色「湛藍商務」），對照專案根目錄 `design.md` 與 `design/theme-E-琥珀鑄場.html`。
- `app/(app)/`：登入後的七個主要頁面，共用 `components/AppShell.tsx` 版面。
- `app/login/`：登入頁（未套用 AppShell）。
- `app/api/`：管理 API 與 OTLP 接收端點。
- `lib/db.ts`：PostgreSQL 查詢層，所有查詢對資料庫不可用都會降級為空結果。
- `lib/litellm.ts`：LiteLLM 管理 API 包裝（簽發／撤銷虛擬金鑰）。
- `proxy.ts`：Next.js 16 的 `middleware.js` 已重新命名為 `proxy.js`，此檔沿用新慣例，負責 session 導轉（`AUTH_DISABLED=1` 時放行）。
