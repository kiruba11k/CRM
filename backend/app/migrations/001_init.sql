-- 001_init.sql - Accounts, Prospects/Contacts, Opportunities, Next Actions.
-- Controlled-list values are enforced in app/domain.py (so the lists can
-- become admin-editable without a migration); the CHECKs here only guard
-- the fixed v2 rules: stages, statuses, risk ratings, the 50-char "Other".

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email       text NOT NULL UNIQUE CHECK (email = lower(email)),
    name        text NOT NULL DEFAULT '',
    role        text NOT NULL DEFAULT 'salesperson' CHECK (role IN ('salesperson', 'manager', 'admin')),
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name          text NOT NULL,
    name_key      text NOT NULL UNIQUE,
    country       text NOT NULL,
    region        text,
    industry      text,
    owner_id      uuid REFERENCES users(id),
    status        text NOT NULL DEFAULT 'Target',
    website       text,
    linkedin_url  text,
    notes         text,
    hubspot_id    text UNIQUE,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE prospects (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name            text NOT NULL,
    account_id           uuid REFERENCES accounts(id),
    job_title            text,
    email                text,
    phone                text,
    linkedin_url         text,
    owner_id             uuid REFERENCES users(id),
    status               text NOT NULL DEFAULT 'New'
                         CHECK (status IN ('New', 'Contacted', 'Engaged', 'Qualified', 'Nurture', 'Disqualified')),
    disqualified_reason  text,
    source               text,
    next_action_code     text CHECK (next_action_code ~ '^(0[1-9]|1[0-8])$'),
    next_action_other    text CHECK (char_length(next_action_other) <= 50),
    next_action_due      date,
    last_activity_at     timestamptz,
    notes                text,
    hubspot_id           text UNIQUE,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prospects_account_idx ON prospects(account_id);
CREATE INDEX prospects_owner_due_idx ON prospects(owner_id, next_action_due);
CREATE UNIQUE INDEX prospects_email_uniq ON prospects(lower(email)) WHERE email IS NOT NULL AND email <> '';

CREATE TABLE opportunities (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                        text NOT NULL,
    account_id                  uuid NOT NULL REFERENCES accounts(id),
    primary_contact_id          uuid REFERENCES prospects(id),
    owner_id                    uuid NOT NULL REFERENCES users(id),
    stage                       text NOT NULL CHECK (stage IN (
                                  'Lead identified', 'Qualified', 'Discovery / scoping', 'Solution design',
                                  'Proposal submitted', 'Negotiation', 'Verbal commitment', 'Won', 'Lost')),
    estimated_value             numeric(14, 2),
    currency                    char(3) NOT NULL DEFAULT 'USD',
    expected_close              date,
    geography                   text NOT NULL,
    service_line                text,
    deal_source                 text,
    risk_rating                 text NOT NULL DEFAULT 'Unassessed'
                                CHECK (risk_rating IN ('Unassessed', 'Low', 'Medium', 'High')),
    high_risk_reason            text,
    risk_mitigation             text,
    on_nurture                  boolean NOT NULL DEFAULT false,
    nurture_reason              text,
    nurture_until               date,
    nurture_owner_id            uuid REFERENCES users(id),
    nurture_next_action_code    text CHECK (nurture_next_action_code ~ '^(0[1-9]|1[0-8])$'),
    nurture_next_action_other   text CHECK (char_length(nurture_next_action_other) <= 50),
    next_action_code            text CHECK (next_action_code ~ '^(0[1-9]|1[0-8])$'),
    next_action_other           text CHECK (char_length(next_action_other) <= 50),
    next_action_due             date,
    proposal_due                date,
    delivery_lead               text,
    effort_estimate             text,
    actual_value                numeric(14, 2),
    won_date                    date,
    lost_date                   date,
    lost_reason                 text,
    lost_notes                  text,
    hubspot_id                  text UNIQUE,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT closed_not_nurtured CHECK (NOT (on_nurture AND stage IN ('Won', 'Lost')))
);
CREATE INDEX opportunities_account_idx ON opportunities(account_id);
CREATE INDEX opportunities_owner_due_idx ON opportunities(owner_id, next_action_due);

-- Multi-person assignment for the internal database-build and proposal teams.
CREATE TABLE opportunity_team (
    opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES users(id),
    team            text NOT NULL CHECK (team IN ('database_build', 'proposal')),
    PRIMARY KEY (opportunity_id, user_id, team)
);

-- Timeline: completed actions, notes, logged calls/meetings, conversions.
CREATE TABLE activities (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type  text NOT NULL CHECK (entity_type IN ('account', 'prospect', 'opportunity')),
    entity_id    uuid NOT NULL,
    kind         text NOT NULL,
    summary      text NOT NULL,
    occurred_at  timestamptz NOT NULL DEFAULT now(),
    created_by   uuid REFERENCES users(id)
);
CREATE INDEX activities_entity_idx ON activities(entity_type, entity_id, occurred_at DESC);

-- §8.3 stage-change and key-field history.
CREATE TABLE record_history (
    id           bigserial PRIMARY KEY,
    entity_type  text NOT NULL,
    entity_id    uuid NOT NULL,
    field        text NOT NULL,
    old_value    text,
    new_value    text,
    changed_by   uuid REFERENCES users(id),
    changed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX record_history_entity_idx ON record_history(entity_type, entity_id, changed_at DESC);
