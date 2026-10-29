-- 002_hubspot_import.sql - HubSpot import runs, re-sync bookkeeping and the
-- "Needs cleanup" queue. Imported records that break a CRM rule are kept,
-- with the reasons listed here, instead of being dropped or silently fixed.

ALTER TABLE accounts      ADD COLUMN hubspot_synced_at timestamptz, ADD COLUMN cleanup_reasons text[] NOT NULL DEFAULT '{}';
ALTER TABLE prospects     ADD COLUMN hubspot_synced_at timestamptz, ADD COLUMN cleanup_reasons text[] NOT NULL DEFAULT '{}';
ALTER TABLE opportunities ADD COLUMN hubspot_synced_at timestamptz, ADD COLUMN cleanup_reasons text[] NOT NULL DEFAULT '{}';
ALTER TABLE activities    ADD COLUMN hubspot_id text UNIQUE;

CREATE INDEX accounts_cleanup_idx      ON accounts(owner_id)      WHERE cardinality(cleanup_reasons) > 0;
CREATE INDEX prospects_cleanup_idx     ON prospects(owner_id)     WHERE cardinality(cleanup_reasons) > 0;
CREATE INDEX opportunities_cleanup_idx ON opportunities(owner_id) WHERE cardinality(cleanup_reasons) > 0;

CREATE TABLE import_runs (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source       text NOT NULL DEFAULT 'hubspot',
    started_by   uuid REFERENCES users(id),
    started_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz,
    status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'interrupted')),
    message      text,
    options      jsonb NOT NULL DEFAULT '{}',
    progress     jsonb NOT NULL DEFAULT '{}',
    counts       jsonb NOT NULL DEFAULT '{}',
    errors       jsonb NOT NULL DEFAULT '[]',
    error_count  integer NOT NULL DEFAULT 0
);
-- At most one import running at a time.
CREATE UNIQUE INDEX import_runs_one_running ON import_runs(source) WHERE status = 'running';
