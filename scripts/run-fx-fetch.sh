#!/bin/bash
# 在一次性 python 容器裡抓匯率並凍結當日訂閱扣款
# （VPS 沒有 pip，沿用 run-gcp-fetch.sh 的做法）
set -e
cd /opt/costscale
DB_PASSWORD=$(grep "^DB_PASSWORD=" .env | cut -d= -f2)
docker run --rm \
  --network costscale_default \
  -v /opt/costscale/scripts:/scripts:ro \
  -e DATABASE_URL="postgresql://costscale:${DB_PASSWORD}@db:5432/costscale" \
  python:3.12-slim \
  sh -c "pip install --quiet 'psycopg[binary]' && python /scripts/fetch-fx.py"
