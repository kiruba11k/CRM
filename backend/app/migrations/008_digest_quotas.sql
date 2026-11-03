-- 008_digest_quotas.sql - daily digest emails, stale-deal alerts settings
-- (kept in app_settings.reminders) and quarterly sales targets.

-- Each user can turn their own digest email off.
ALTER TABLE users ADD COLUMN digest_enabled boolean NOT NULL DEFAULT true;

-- One digest per user per local day; a failed send is retried a few times.
CREATE TABLE digest_log (
    id           bigserial PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    digest_date  date NOT NULL,
    status       text NOT NULL CHECK (status IN ('sending', 'sent', 'failed', 'skipped')),
    attempts     integer NOT NULL DEFAULT 1,
    detail       text,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, digest_date)
);

-- Quarterly target per salesperson and currency (period like 2026-Q4).
-- Currencies are never added together (§2.3), so each has its own target.
CREATE TABLE quotas (
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period      text NOT NULL CHECK (period ~ '^[0-9]{4}-Q[1-4]$'),
    currency    text NOT NULL,
    amount      numeric(14, 2) NOT NULL CHECK (amount > 0),
    updated_by  uuid REFERENCES users(id),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, period, currency)
);
