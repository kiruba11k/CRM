-- 018_outcomes_contacts.sql - CRM review (4 Nov 2026):
-- outcome captured when an action is completed, and extra buying contacts
-- on a deal (besides the primary contact).
ALTER TABLE activities ADD COLUMN outcome text;
CREATE INDEX activities_outcome_idx ON activities(outcome) WHERE outcome IS NOT NULL;

CREATE TABLE deal_contacts (
    opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
    prospect_id     uuid NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
    role            text CHECK (char_length(role) <= 60),       -- e.g. Decision maker, Champion
    added_by        uuid REFERENCES users(id),
    added_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (opportunity_id, prospect_id)
);
CREATE INDEX deal_contacts_prospect_idx ON deal_contacts(prospect_id);

-- Saved views on the new Deals table and Companies list.
ALTER TABLE saved_views DROP CONSTRAINT IF EXISTS saved_views_page_check;
ALTER TABLE saved_views ADD CONSTRAINT saved_views_page_check CHECK (page IN ('prospects', 'accounts', 'pipeline', 'deals'));
