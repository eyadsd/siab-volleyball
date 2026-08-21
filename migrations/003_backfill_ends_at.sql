-- One-off backfill for the two games that predate automatic expiry.
--
--   npx wrangler d1 execute siab-db --remote --file=./migrations/003_backfill_ends_at.sql
--
-- Migration 002 deliberately left ends_at NULL on existing rows so nothing
-- already on the board would disappear unannounced. These two games have
-- since been played, so they get real end times and are swept on the next
-- API request, exactly like any game posted from now on.
--
-- Times are Europe/Budapest (CEST, UTC+2), the zone the games were played in.
--   fd554646-b86  Fri 2026-08-21 19:00-21:00  -> ends 21:00 CEST
--   ac2afa00-867  Fri 2026-08-21 21:00-22:30  -> ends 22:30 CEST (90 min)

UPDATE polls SET ends_at = 1787338800000, duration_min = 120 WHERE id = 'fd554646-b86';
UPDATE polls SET ends_at = 1787344200000, duration_min = 90  WHERE id = 'ac2afa00-867';
