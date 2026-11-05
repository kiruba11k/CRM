-- 020_custom_fields_automations.sql - CRM review P2 (5 Nov 2026):
-- custom properties on companies, contacts and deals; simple workflow
-- automation rules; the action type of each completed action.

CREATE TABLE custom_fields (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity      text NOT NULL CHECK (entity IN ('accounts', 'prospects', 'opportunities')),
    key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
    label       text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
    type        text NOT NULL CHECK (type IN ('text', 'number', 'date', 'select', 'checkbox')),
    options     text[] NOT NULL DEFAULT '{}',
    position    integer NOT NULL DEFAULT 0,
    active      boolean NOT NULL DEFAULT true,
    created_by  uuid REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (entity, key)
);

-- One row per filled-in value; the value is kept as text in a canonical form
-- (ISO date, plain number, "true"/"false").
CREATE TABLE custom_values (
    field_id    uuid NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
    record_id   uuid NOT NULL,
    value       text NOT NULL,
    updated_by  uuid REFERENCES users(id),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (field_id, record_id)
);
CREATE INDEX custom_values_record_idx ON custom_values(record_id);

CREATE TABLE automations (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    entity        text NOT NULL CHECK (entity IN ('prospect', 'opportunity')),
    trigger       text NOT NULL CHECK (trigger IN ('created', 'stage_changed', 'status_changed')),
    trigger_value text,                 -- the stage / status it moves to; NULL = any
    action        text NOT NULL CHECK (action IN ('set_next_action', 'assign_owner', 'add_to_list', 'log_note')),
    params        text NOT NULL DEFAULT '{}',   -- JSON
    active        boolean NOT NULL DEFAULT true,
    run_count     integer NOT NULL DEFAULT 0,
    last_run_at   timestamptz,
    created_by    uuid REFERENCES users(id),
    created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE activities ADD COLUMN action_code text;
