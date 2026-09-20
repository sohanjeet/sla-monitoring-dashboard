-- PostgreSQL persistence model for normalized monitoring reports.
-- Each upload is a separate dataset: supplied source files overlap in time and
-- must not be deduplicated across uploads.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE datasets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_filename TEXT NOT NULL CHECK (btrim(source_filename) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (btrim(name) <> '')
);

-- The cleaning contract rejects malformed rows, invalid HTTP statuses, and
-- later exact duplicates. Keeping the original row here makes those decisions
-- reviewable without polluting the clean-report table.
CREATE TABLE import_rejections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id UUID NOT NULL REFERENCES datasets(id) ON DELETE RESTRICT,
  source_row_number INTEGER NOT NULL CHECK (source_row_number > 0),
  rejection_reason TEXT NOT NULL CHECK (btrim(rejection_reason) <> ''),
  raw_record JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, source_row_number, rejection_reason)
);

CREATE TABLE monitoring_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id UUID NOT NULL REFERENCES datasets(id) ON DELETE RESTRICT,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  observed_at TIMESTAMPTZ NOT NULL,
  status_code SMALLINT NOT NULL CHECK (status_code BETWEEN 100 AND 599),
  latency_ms NUMERIC(14, 3),
  agent TEXT NOT NULL CHECK (btrim(agent) <> ''),
  region TEXT NOT NULL CHECK (btrim(region) <> ''),

  -- Original evidence retained where normalization or a quality decision matters.
  source_row_number INTEGER NOT NULL CHECK (source_row_number > 0),
  raw_timestamp TEXT NOT NULL CHECK (btrim(raw_timestamp) <> ''),
  -- Blank is meaningful here (a missing latency); NULL would defeat the exact
  -- duplicate key because PostgreSQL treats NULL values as distinct.
  raw_latency TEXT NOT NULL,
  latency_unit TEXT NOT NULL CHECK (latency_unit IN ('ms', 's')),

  -- A report can retain valid status evidence even when latency is unusable.
  latency_quality TEXT NOT NULL DEFAULT 'valid'
    CHECK (latency_quality IN ('valid', 'missing_latency', 'invalid_negative_latency')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (
    (latency_quality = 'valid' AND latency_ms IS NOT NULL AND latency_ms >= 0)
    OR (latency_quality IN ('missing_latency', 'invalid_negative_latency') AND latency_ms IS NULL)
  ),
  UNIQUE (dataset_id, source_row_number),

  -- An exact duplicate is defined by the normalized instant plus the original
  -- report evidence. This deliberately permits different reports for one
  -- service/time slot (for later conflict-aware slot aggregation).
  UNIQUE (dataset_id, service_id, observed_at, status_code, raw_latency, latency_unit, agent, region)
);

-- Import-scoped queries can use these indexes. Dashboard requests span stored
-- datasets, so they also need an observed-time-leading index below.
CREATE INDEX monitoring_checks_dataset_observed_at_idx
  ON monitoring_checks (dataset_id, observed_at);

CREATE INDEX monitoring_checks_dataset_service_observed_at_idx
  ON monitoring_checks (dataset_id, service_id, observed_at);

CREATE INDEX monitoring_checks_observed_at_service_agent_idx
  ON monitoring_checks (observed_at, service_id, agent, source_row_number, dataset_id, id);

CREATE INDEX import_rejections_dataset_idx
  ON import_rejections (dataset_id);
