# AI CostScale dashboard — 多階段建置，最終產出 next build standalone 輸出。

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# 建置時 next/font/google 要連 fonts.googleapis.com 下載字型，暫時連不上會讓建置失敗。
# 最多試 3 次，成功就立刻結束；建置內容不變，只是不必人工重跑。
RUN for i in 1 2 3; do npm run build && exit 0; echo "建置失敗（第 $i 次），5 秒後重試" >&2; sleep 5; done; exit 1

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
# 說明頁在執行時讀 content/manual.md。runner 階段預設只帶 standalone 與 static，
# 少了這一行，說明頁在容器裡會讀不到檔案（本機開發看起來卻正常）。
COPY --from=builder /app/content ./content
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
