-- 017_slack.sql - Slack notifications through incoming webhooks.
CREATE TABLE slack_channels (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name               text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    webhook_encrypted  text NOT NULL,                 -- encrypted with CRM_TOKEN_KEY
    webhook_hint       text NOT NULL,                 -- last characters, to tell webhooks apart
    events             text[] NOT NULL DEFAULT '{}',
    active             boolean NOT NULL DEFAULT true,
    last_daily_date    date,
    last_ok_at         timestamptz,
    last_error         text,
    created_by         uuid REFERENCES users(id),
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE slack_log (
    id          bigserial PRIMARY KEY,
    channel_id  uuid REFERENCES slack_channels(id) ON DELETE CASCADE,
    event       text NOT NULL,
    ok          boolean NOT NULL,
    message     text NOT NULL,
    at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX slack_log_at_idx ON slack_log(at DESC);
