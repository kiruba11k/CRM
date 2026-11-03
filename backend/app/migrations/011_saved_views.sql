-- 011_saved_views.sql - named filter sets people save on list pages.
CREATE TABLE saved_views (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    page        text NOT NULL CHECK (page IN ('prospects', 'accounts', 'pipeline')),
    name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    filters     jsonb NOT NULL DEFAULT '{}',
    shared      boolean NOT NULL DEFAULT false,   -- visible to the whole team
    position    integer NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_id, page, name)
);
CREATE INDEX saved_views_page_idx ON saved_views(page, owner_id);

-- Each person's default view per page (theirs or a shared one).
CREATE TABLE saved_view_defaults (
    user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    page     text NOT NULL,
    view_id  uuid NOT NULL REFERENCES saved_views(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, page)
);
