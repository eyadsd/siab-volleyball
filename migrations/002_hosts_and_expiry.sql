-- Per-game passcodes + automatic expiry.
--
--   npx wrangler d1 execute siab-db --remote --file=./migrations/002_hosts_and_expiry.sql
--
-- Unlike 001, this one is NOT re-runnable: SQLite has no
-- "ADD COLUMN IF NOT EXISTS", so a second run fails on "duplicate column
-- name". That failure is harmless — it means the migration already ran.
--
-- Existing games come out with host_hash NULL, which means only the
-- site-wide ADMIN_PASSCODE can manage them. Give one a passcode of its own
-- by editing it in the UI as admin, or leave it admin-only.
--
-- ends_at is left NULL for existing rows, so nothing already on the board
-- gets swept away by the expiry pass. Save a game once (any edit) and it
-- picks up an end time from its date, time, and duration.

ALTER TABLE polls ADD COLUMN host_hash TEXT;
ALTER TABLE polls ADD COLUMN duration_min INTEGER NOT NULL DEFAULT 120;
ALTER TABLE polls ADD COLUMN ends_at INTEGER;

CREATE INDEX IF NOT EXISTS polls_ends ON polls(ends_at);

-- Skill levels went from three to five (B | BI | I | UI | A). The three
-- original values are still valid, so stored RSVPs need no rewrite —
-- Beginner, Intermediate, and Advanced simply sit at 1, 3, and 5 on the
-- new scale instead of 1, 2, and 3.
