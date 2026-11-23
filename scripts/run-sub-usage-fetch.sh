#!/bin/bash
# 抓訂閱剩餘額度（經橋接的 /usage）
set -e
cd /opt/costscale
DB_PASSWORD=$(grep "^DB_PASSWORD=" .env | cut -d= -f2)
BRIDGE_TOKEN=$(grep "^BRIDGE_TOKEN=" .env | cut -d= -f2-)
docker run --rm \
  --network costscale_default \
  -v /opt/costscale/scripts:/scripts:ro \
  -e DATABASE_URL="postgresql://costscale:${DB_PASSWORD}@db:5432/costscale" \
  -e BRIDGE_URL="http://10.87.213.1:8788" \
  -e BRIDGE_TOKEN="${BRIDGE_TOKEN}" \
  python:3.12-slim \
  sh -c "pip install --quiet 'psycopg[binary]' && python /scripts/fetch-sub-usage.py"
