-- 013_pipeline_snapshots.sql - one row per day, stage and currency with the
-- open, non-nurtured pipeline at that moment, for the trend on Reports.
CREATE TABLE pipeline_snapshots (
    snap_date   date NOT NULL,
    stage       text NOT NULL,
    currency    text NOT NULL,
    deals       integer NOT NULL,
    unweighted  numeric(16, 2) NOT NULL,
    weighted    numeric(16, 2) NOT NULL,
    taken_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (snap_date, stage, currency)
);
-- Days with no open deals still get a row, so "zero" isn't "missing".
