-- 019_lists_company_size.sql - CRM review, round 2 (5 Nov 2026):
-- company size on accounts, and static lists of records ("add to a list").
ALTER TABLE accounts ADD COLUMN company_size text;

CREATE TABLE record_lists (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity      text NOT NULL CHECK (entity IN ('accounts', 'prospects', 'opportunities')),
    name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    owner_id    uuid REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX record_lists_name_idx ON record_lists(entity, lower(name));

CREATE TABLE record_list_members (
    list_id     uuid NOT NULL REFERENCES record_lists(id) ON DELETE CASCADE,
    record_id   uuid NOT NULL,
    added_by    uuid REFERENCES users(id),
    added_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (list_id, record_id)
);
CREATE INDEX record_list_members_record_idx ON record_list_members(record_id);
