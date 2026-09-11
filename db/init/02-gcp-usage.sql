-- GCP 直連用量（未經閘道的 Vertex 呼叫），由 Cloud Monitoring 定時抓取
CREATE TABLE IF NOT EXISTS costscale.gcp_usage (
  id           BIGSERIAL PRIMARY KEY,
  project_id   TEXT NOT NULL,
  model        TEXT NOT NULL,
  day          DATE NOT NULL,
  invocations  BIGINT NOT NULL DEFAULT 0,
  tokens       BIGINT NOT NULL DEFAULT 0,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, model, day)
);
CREATE INDEX IF NOT EXISTS idx_gcp_usage_day ON costscale.gcp_usage(day DESC);
