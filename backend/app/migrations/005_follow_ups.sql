-- 005_follow_ups.sql - §6.1 time-specific follow-ups in Google Calendar.
-- A next action can carry a time and an "add to my calendar" choice; the
-- CRM then keeps one follow-up event per record in the owner's calendar.
-- Meetings also record which calendar their event lives in.

ALTER TABLE prospects
    ADD COLUMN next_action_time time,
    ADD COLUMN next_action_time_zone text,
    ADD COLUMN next_action_in_calendar boolean NOT NULL DEFAULT false;
ALTER TABLE opportunities
    ADD COLUMN next_action_time time,
    ADD COLUMN next_action_time_zone text,
    ADD COLUMN next_action_in_calendar boolean NOT NULL DEFAULT false;

ALTER TABLE meetings
    ADD COLUMN kind text NOT NULL DEFAULT 'meeting' CHECK (kind IN ('meeting', 'follow_up')),
    ADD COLUMN follow_up_active boolean NOT NULL DEFAULT false,
    ADD COLUMN calendar_id text;
-- At most one live follow-up event per record: updates move it, never add another.
CREATE UNIQUE INDEX meetings_one_follow_up ON meetings(entity_type, entity_id) WHERE follow_up_active;
