-- 009_gmail_autolog.sql - log emails with known prospects automatically.
-- Uses the gmail.metadata scope: sender, recipients, subject and date only;
-- message bodies are never read or stored.

ALTER TABLE calendar_connections
    ADD COLUMN gmail_enabled    boolean NOT NULL DEFAULT false,
    ADD COLUMN gmail_history_id text,
    ADD COLUMN gmail_synced_at  timestamptz,
    ADD COLUMN gmail_error      text;

ALTER TABLE activities
    ADD COLUMN gmail_message_id text,
    ADD COLUMN gmail_thread_id  text,
    ADD COLUMN email_direction  text CHECK (email_direction IN ('in', 'out'));
-- The same email is logged once per record, however often sync sees it.
CREATE UNIQUE INDEX activities_gmail_once ON activities(entity_type, entity_id, gmail_message_id) WHERE gmail_message_id IS NOT NULL;
CREATE INDEX activities_gmail_msg_idx ON activities(gmail_message_id) WHERE gmail_message_id IS NOT NULL;

-- Emails someone removed from the CRM: never logged again.
CREATE TABLE gmail_exclusions (
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id  text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, message_id)
);
