-- Only needed if you already deployed the single-mix version.
-- Additive and safe to run more than once.
--
--   npx wrangler d1 execute siab-db --remote --file=./migrations/001_rounds.sql
--
-- The old polls.teams column is left in place and simply ignored; any teams
-- stored there are not carried over, so just mix round 1 again.

CREATE TABLE IF NOT EXISTS rounds (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  poll_id     TEXT NOT NULL,
  team_count  INTEGER NOT NULL,
  teams       TEXT NOT NULL,
  bench       TEXT NOT NULL,
  gap         INTEGER NOT NULL,
  fresh_pairs INTEGER NOT NULL,
  repeats     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS rounds_order ON rounds(poll_id, seq);
