-- 007_google_tasks.sql - §6.3 one-way CRM → Google Tasks.
-- A user who turns Tasks on gets a "LeadStrategus CRM" list; each open next
-- action they own (or nurture revisit) is mirrored as one task there.
-- Nothing is read back: the CRM stays the source of truth.

ALTER TABLE calendar_connections
    ADD COLUMN tasks_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN tasks_list_id text;

CREATE TABLE task_links (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type     text NOT NULL CHECK (entity_type IN ('prospect', 'opportunity')),
    entity_id       uuid NOT NULL,
    owner_id        uuid NOT NULL REFERENCES users(id),
    title           text NOT NULL,
    notes           text NOT NULL DEFAULT '',
    due             date NOT NULL,
    active          boolean NOT NULL DEFAULT true,
    tasklist_id     text,
    google_task_id  text,
    attempted       boolean NOT NULL DEFAULT false,
    sync_status     text NOT NULL DEFAULT 'pending'
                    CHECK (sync_status IN ('pending', 'synced', 'failed', 'not_connected', 'completed', 'removed')),
    sync_error      text,
    synced_at       timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
-- One live task per record: changes update it, never add another.
CREATE UNIQUE INDEX task_links_one_active ON task_links(entity_type, entity_id) WHERE active;
CREATE INDEX task_links_owner_idx ON task_links(owner_id) WHERE active;

ALTER TABLE calendar_sync_log ADD COLUMN task_link_id uuid REFERENCES task_links(id) ON DELETE CASCADE;
