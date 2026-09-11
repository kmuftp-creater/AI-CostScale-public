#!/bin/bash
# 在一次性 python 容器裡執行 GCP 用量抓取（VPS 本身沒有 pip，避免污染主機環境）
set -e
cd /opt/costscale
DB_PASSWORD=$(grep "^DB_PASSWORD=" .env | cut -d= -f2)
GCP_PROJECT=$(grep -m1 "^GCP_PROJECT=" .env | cut -d= -f2-)
LLM_KEY=$(grep "^LITELLM_MASTER_KEY=" .env | cut -d= -f2-)
docker run --rm \
  --network costscale_default \
  -v /opt/costscale/scripts:/scripts:ro \
  -v /root/vertex-sa.json:/sa.json:ro \
  -e GOOGLE_APPLICATION_CREDENTIALS=/sa.json \
  -e GCP_PROJECT="${GCP_PROJECT:?請在 .env 設 GCP_PROJECT}" \
  -e GCP_FETCH_DAYS=${GCP_FETCH_DAYS:-7} \
  -e DATABASE_URL="postgresql://costscale:${DB_PASSWORD}@db:5432/costscale" \
  -e LITELLM_BASE_URL="http://litellm:4000" \
  -e LITELLM_MASTER_KEY="${LLM_KEY}" \
  python:3.12-slim \
  sh -c "pip install --quiet cryptography 'psycopg[binary]' && python /scripts/fetch-gcp-usage.py"
