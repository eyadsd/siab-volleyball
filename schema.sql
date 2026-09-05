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
  created_at  INTEGER NOT NULL,

  -- SHA-256 of the game's own passcode, salted with the poll id. Whoever
  -- posts a game sets this and can then run it; the site-wide
  -- ADMIN_PASSCODE overrides it everywhere. NULL means admin-only, which
  -- is what games created before per-game passcodes existed look like.
  host_hash   TEXT,

  -- How long the game runs, so "it's over" is a real moment rather than a
  -- guess. Used to compute ends_at.
  duration_min INTEGER NOT NULL DEFAULT 120,

  -- Epoch ms the game finishes. Rows past this (plus a grace period) are
  -- deleted on the next API request. NULL for date-TBD games, which stay
  -- on the board until someone removes them by hand.
  ends_at     INTEGER
);

CREATE INDEX IF NOT EXISTS polls_ends ON polls(ends_at);

CREATE TABLE IF NOT EXISTS rsvps (
  -- seq is the fairness guarantee: a strictly increasing signup counter.
  -- Timestamps tie when two people submit in the same millisecond, and a
  -- tie-break on a random id would hand out waitlist places arbitrarily.
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  poll_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL,   -- lowercased, for case-insensitive dedupe
  skill       TEXT NOT NULL,   -- B | BI | I | UI | A
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

-- One row per pairing inside a round. Two sides make one matchup; four sides
-- make six, because with several sides up you play each other side in turn
-- rather than all at once. winner NULL means "not recorded" and is ignored
-- everywhere — you are never required to fill them all in, and a night that
-- only got through half its pairings still counts for the half it played.
--
-- team_a and team_b are snapshots for the same reason rounds.teams is one: a
-- player leaving later must not rewrite a result. They also let a decided
-- matchup outlive the poll, which the expiry sweep deletes an hour after the
-- game ends. A played night has to leave something behind.
CREATE TABLE IF NOT EXISTS matches (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  poll_id     TEXT NOT NULL,
  round_id    TEXT NOT NULL,
  side_a      INTEGER NOT NULL,   -- team index within the round
  side_b      INTEGER NOT NULL,   -- always greater than side_a, so a pairing appears once
  winner      INTEGER,            -- side_a | side_b | NULL
  team_a      TEXT NOT NULL,      -- JSON: [{id,name,skill}]
  team_b      TEXT NOT NULL,
  reported_by TEXT,               -- 'anyone' | 'host' | 'admin'
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER
);

CREATE INDEX IF NOT EXISTS matches_round ON matches(round_id);
CREATE INDEX IF NOT EXISTS matches_poll  ON matches(poll_id, seq);
