-- 003_calendar.sql - Google Calendar + Meet sync (§6) and shared booking links.
-- Each user authorises their own calendar; the refresh token is stored
-- encrypted. Meetings live in the CRM first and are pushed to Google; the
-- stored event ID means an update changes that event and never adds another.

CREATE TABLE calendar_connections (
    user_id                  uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    google_email             text NOT NULL,
    refresh_token_encrypted  text NOT NULL,
    scopes                   text NOT NULL DEFAULT '',
    status                   text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'needs_reconnect')),
    connected_at             timestamptz NOT NULL DEFAULT now(),
    last_sync_at             timestamptz,
    last_error               text
);

CREATE TABLE meetings (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type    text CHECK (entity_type IN ('account', 'prospect', 'opportunity')),
    entity_id      uuid,
    owner_id       uuid NOT NULL REFERENCES users(id),
    title          text NOT NULL,
    description    text,
    starts_at      timestamptz NOT NULL,
    ends_at        timestamptz NOT NULL CHECK (ends_at > starts_at),
    time_zone      text NOT NULL DEFAULT 'UTC',
    attendees      text[] NOT NULL DEFAULT '{}',
    add_meet       boolean NOT NULL DEFAULT true,
    reminder_15    boolean NOT NULL DEFAULT true,
    reminder_day   boolean NOT NULL DEFAULT false,
    google_event_id text,
    html_link      text,
    meet_url       text,
    sync_status    text NOT NULL DEFAULT 'pending'
                   CHECK (sync_status IN ('pending', 'synced', 'failed', 'not_connected', 'cancelled')),
    sync_error     text,
    synced_at      timestamptz,
    cancelled      boolean NOT NULL DEFAULT false,
    created_by     uuid REFERENCES users(id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meetings_owner_start_idx ON meetings(owner_id, starts_at);
CREATE INDEX meetings_entity_idx ON meetings(entity_type, entity_id);

CREATE TABLE calendar_sync_log (
    id          bigserial PRIMARY KEY,
    meeting_id  uuid REFERENCES meetings(id) ON DELETE CASCADE,
    user_id     uuid REFERENCES users(id),
    action      text NOT NULL,
    ok          boolean NOT NULL,
    message     text NOT NULL,
    at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calendar_sync_log_at_idx ON calendar_sync_log(at DESC);

-- Google Calendar appointment-schedule links, shared with the team.
CREATE TABLE booking_links (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id    uuid NOT NULL REFERENCES users(id),
    name        text NOT NULL,
    url         text NOT NULL,
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);
