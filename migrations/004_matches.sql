-- Who won. Additive and safe to run more than once — unlike 002, this one
-- creates a table rather than altering one, so there is no "duplicate column"
-- failure to shrug off.
--
--   npx wrangler d1 execute siab-db --remote --file=./migrations/004_matches.sql
--
-- Rounds that already exist get no matchups. The mixer creates them from here
-- on, so mix a fresh round to start recording results — backfilling pairings
-- for rounds already played would invent matches nobody agreed to.

CREATE TABLE IF NOT EXISTS matches (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  poll_id     TEXT NOT NULL,
  round_id    TEXT NOT NULL,
  side_a      INTEGER NOT NULL,
  side_b      INTEGER NOT NULL,
  winner      INTEGER,
  team_a      TEXT NOT NULL,
  team_b      TEXT NOT NULL,
  reported_by TEXT,
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER
);

CREATE INDEX IF NOT EXISTS matches_round ON matches(round_id);
CREATE INDEX IF NOT EXISTS matches_poll  ON matches(poll_id, seq);
