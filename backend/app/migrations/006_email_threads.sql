-- 006_email_threads.sql - §6.2 Gmail threads a user explicitly links to a
-- record. Only the thread reference, the Gmail link, a short label and who
-- linked it are stored: never message bodies, and nothing is ingested
-- automatically.

CREATE TABLE email_threads (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type  text NOT NULL CHECK (entity_type IN ('account', 'prospect', 'opportunity')),
    entity_id    uuid NOT NULL,
    thread_ref   text NOT NULL CHECK (thread_ref ~ '^[A-Za-z0-9:_-]{8,128}$'),
    url          text NOT NULL CHECK (url LIKE 'https://mail.google.com/%'),
    label        text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
    linked_by    uuid REFERENCES users(id),
    linked_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (entity_type, entity_id, thread_ref)
);
CREATE INDEX email_threads_entity_idx ON email_threads(entity_type, entity_id, linked_at DESC);
