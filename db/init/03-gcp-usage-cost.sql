-- GCP 直連用量補上輸入／輸出分列與金額估算（2026-08-20）
ALTER TABLE costscale.gcp_usage ADD COLUMN IF NOT EXISTS input_tokens  BIGINT NOT NULL DEFAULT 0;
ALTER TABLE costscale.gcp_usage ADD COLUMN IF NOT EXISTS output_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE costscale.gcp_usage ADD COLUMN IF NOT EXISTS est_cost      NUMERIC(16,8) NOT NULL DEFAULT 0;
