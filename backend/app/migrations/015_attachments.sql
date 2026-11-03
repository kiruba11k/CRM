-- 015_attachments.sql - files and links on deals (and accounts).
-- File contents live in their own table, so they can move to object storage
-- later without touching the metadata.
CREATE TABLE attachments (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type   text NOT NULL CHECK (entity_type IN ('opportunity', 'account')),
    entity_id     uuid NOT NULL,
    kind          text NOT NULL DEFAULT 'Other',
    title         text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    url           text CHECK (url ~ '^https://'),          -- links (e.g. Google Drive)
    filename      text,                                    -- uploads
    content_type  text,
    size_bytes    integer,
    note          text CHECK (char_length(note) <= 300),
    uploaded_by   uuid REFERENCES users(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    CHECK ((url IS NULL) <> (filename IS NULL))
);
CREATE INDEX attachments_entity_idx ON attachments(entity_type, entity_id, created_at DESC);

CREATE TABLE attachment_blobs (
    attachment_id  uuid PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
    content        bytea NOT NULL
);
