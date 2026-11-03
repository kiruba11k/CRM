-- 010_roles_people.sql - admin-defined roles with permissions, and people
-- added ahead of their first sign-in.

CREATE TABLE roles (
    key          text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
    name         text NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 2 AND 40),
    description  text NOT NULL DEFAULT '' CHECK (char_length(description) <= 200),
    permissions  text[] NOT NULL DEFAULT '{}',
    system       boolean NOT NULL DEFAULT false,   -- built in: can't be deleted or renamed
    position     integer NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO roles(key, name, description, permissions, system, position) VALUES
  ('admin', 'Admin', 'Full access, including people, roles and CRM settings.',
   ARRAY['edit_all', 'team_view', 'import_data', 'export_data', 'set_targets', 'manage_settings', 'manage_users'], true, 0),
  ('manager', 'Sales manager', 'Runs the team: edits and reassigns any record, sees the team view, sets targets.',
   ARRAY['edit_all', 'team_view', 'import_data', 'export_data', 'set_targets'], true, 1),
  ('project_manager', 'Project manager', 'Follows delivery across the pipeline: team view and exports, edits only their own records.',
   ARRAY['team_view', 'export_data'], false, 2),
  ('salesperson', 'Salesperson', 'Works their own prospects and deals; sees the shared pipeline.',
   ARRAY[]::text[], true, 3);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_fk FOREIGN KEY (role) REFERENCES roles(key) ON UPDATE CASCADE;
ALTER TABLE users
    ADD COLUMN title         text CHECK (char_length(title) <= 80),
    ADD COLUMN last_seen_at  timestamptz,
    ADD COLUMN added_by      uuid REFERENCES users(id);
