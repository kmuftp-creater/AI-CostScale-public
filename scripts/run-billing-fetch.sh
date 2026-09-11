#!/bin/bash
# 在一次性 python 容器裡抓兩本帳的 BigQuery 帳單匯出
#（VPS 本身沒有 pip，沿用 run-gcp-fetch.sh 的做法，不污染主機環境）
set -e
cd /opt/costscale
DB_PASSWORD=$(grep "^DB_PASSWORD=" .env | cut -d= -f2)
BQ_JOB_PROJECT=$(grep -m1 "^BQ_JOB_PROJECT=" .env | cut -d= -f2-)
docker run --rm \
  --network costscale_default \
  -v /opt/costscale/scripts:/scripts:ro \
  -v /root/vertex-sa.json:/sa.json:ro \
  -e GOOGLE_APPLICATION_CREDENTIALS=/sa.json \
  -e BQ_JOB_PROJECT="${BQ_JOB_PROJECT:?請在 .env 設 BQ_JOB_PROJECT}" \
  -e BILLING_FETCH_DAYS=${BILLING_FETCH_DAYS:-45} \
  -e DATABASE_URL="postgresql://costscale:${DB_PASSWORD}@db:5432/costscale" \
  python:3.12-slim \
  sh -c "pip install --quiet cryptography 'psycopg[binary]' && python /scripts/fetch-billing-bq.py"
