-- SIAB schema. Safe to re-run.

CREATE TABLE IF NOT EXISTS polls (
  id          TEXT PRIMARY KEY,
  title       TEXT    NOT NULL,
  date        TEXT,
  time        TEXT,
  location    TEXT,
  cap         INTEGER NOT NULL,
  notes       TEXT,
  closed      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rsvps (
  -- seq is the fairness guarantee: a strictly increasing signup counter.
  -- Timestamps tie when two people submit in the same millisecond, and a
  -- tie-break on a random id would hand out waitlist places arbitrarily.
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  poll_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL,   -- lowercased, for case-insensitive dedupe
  skill       TEXT NOT NULL,   -- B | I | A
  created_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS rsvps_unique ON rsvps(poll_id, name_key);
CREATE INDEX IF NOT EXISTS rsvps_order ON rsvps(poll_id, seq);

-- One row per mix. Rounds are a record of what was actually played, so a
-- player leaving later doesn't rewrite earlier rounds. The mixer reads
-- this table to avoid repeating pairings and to rotate the bench.
CREATE TABLE IF NOT EXISTS rounds (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  poll_id     TEXT NOT NULL,
  team_count  INTEGER NOT NULL,
  teams       TEXT NOT NULL,   -- JSON: [[{id,name,skill}]]
  bench       TEXT NOT NULL,   -- JSON: [{id,name,skill}]
  gap         INTEGER NOT NULL,
  fresh_pairs INTEGER NOT NULL,
  repeats     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS rounds_order ON rounds(poll_id, seq);
