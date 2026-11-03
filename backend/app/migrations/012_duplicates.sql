-- 012_duplicates.sql - find-and-merge duplicates: pairs someone said aren't
-- duplicates, and a log of every merge (with a snapshot of the removed record).
CREATE TABLE duplicate_dismissals (
    entity_type   text NOT NULL CHECK (entity_type IN ('account', 'prospect')),
    id_a          uuid NOT NULL,
    id_b          uuid NOT NULL,
    dismissed_by  uuid REFERENCES users(id),
    dismissed_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (entity_type, id_a, id_b),
    CHECK (id_a < id_b)
);

CREATE TABLE merge_log (
    id           bigserial PRIMARY KEY,
    entity_type  text NOT NULL CHECK (entity_type IN ('account', 'prospect')),
    kept_id      uuid NOT NULL,
    kept_name    text NOT NULL,
    merged_id    uuid NOT NULL,
    merged_name  text NOT NULL,
    snapshot     jsonb NOT NULL,     -- the removed record as it was
    moved        jsonb NOT NULL,     -- what was moved onto the kept record
    merged_by    uuid REFERENCES users(id),
    merged_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX merge_log_at_idx ON merge_log(merged_at DESC);
