-- 014_email_domains.sql - Gmail auto-logging by company domain.
-- Extra email domains for an account (when people's addresses differ from
-- the website), and the external addresses on an auto-logged email so the
-- account page can suggest people to add as prospects.
ALTER TABLE accounts ADD COLUMN email_domains text CHECK (char_length(email_domains) <= 300);
ALTER TABLE activities ADD COLUMN email_addresses text[];
