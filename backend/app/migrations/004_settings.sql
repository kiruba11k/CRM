-- 004_settings.sql - admin-editable controlled lists, stage probabilities,
-- reminder settings, the shared launch checklist and a settings audit log.
-- Lists are seeded from app/domain.py defaults on first start.

CREATE TABLE list_options (
    list_key    text NOT NULL,
    value       text NOT NULL CHECK (char_length(value) BETWEEN 1 AND 80),
    position    integer NOT NULL DEFAULT 0,
    active      boolean NOT NULL DEFAULT true,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (list_key, value)
);

-- Stage probabilities and reminder settings, as JSON per key.
CREATE TABLE app_settings (
    key         text PRIMARY KEY,
    value       jsonb NOT NULL,
    updated_by  uuid REFERENCES users(id),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE launch_checklist (
    item_key    text PRIMARY KEY,
    done        boolean NOT NULL DEFAULT false,
    note        text,
    updated_by  uuid REFERENCES users(id),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settings_changes (
    id          bigserial PRIMARY KEY,
    area        text NOT NULL,
    summary     text NOT NULL,
    changed_by  uuid REFERENCES users(id),
    changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX settings_changes_at_idx ON settings_changes(changed_at DESC);
