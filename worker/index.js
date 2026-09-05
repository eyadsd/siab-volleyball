/**
 * SIAB API — Cloudflare Worker + D1
 *
 * Every mutating route returns the full fresh state so the client never
 * has to guess. Roster/waitlist split is derived from RSVP order, so
 * promotion off the waitlist is automatic — there is no "promote" step
 * to get wrong.
 *
 * Two levels of authority:
 *
 *   - Anyone can post a game, and sets their own passcode for it. That
 *     passcode manages that one game and nothing else.
 *   - ADMIN_PASSCODE (a Cloudflare secret) manages every game, including
 *     ones whose host passcode nobody remembers.
 */

import { mixRound } from "./balance.js";

const SKILLS = new Set(["B", "BI", "I", "UI", "A"]);

/** How long after a game ends before it's swept off the board. */
const GRACE_MS = 60 * 60 * 1000;
const DEFAULT_DURATION = 120;
const MAX_DURATION = 720;
/** Nothing can pin itself on the board longer than this. */
const MAX_FUTURE_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const MIN_PASSCODE = 4;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const bad = (msg, status = 400) => json({ error: msg }, status);
const uid = () => crypto.randomUUID().slice(0, 12);
const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ");
const has = (body, k) => Object.prototype.hasOwnProperty.call(body, k);

/** Constant-time string compare so a passcode can't be timed out byte by byte. */
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * Host passcodes are stored hashed, salted with the poll id. They're
 * low-value and get shared around a group chat, but a leaked database
 * still shouldn't hand over a list of passcodes people reuse elsewhere.
 * The poll id as salt means the same passcode on two games hashes
 * differently.
 */
async function hashHostKey(pollId, passcode) {
  const data = new TextEncoder().encode(`siab:${pollId}:${passcode}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isAdmin(request, env) {
  const key = request.headers.get("x-siab-key");
  if (!key || !env.ADMIN_PASSCODE) return false;
  return safeEqual(key, env.ADMIN_PASSCODE);
}

/** Does this request get to run this specific game? */
async function canManage(request, env, poll) {
  if (isAdmin(request, env)) return true;
  if (!poll || !poll.host_hash) return false;
  const key = request.headers.get("x-siab-poll-key");
  if (!key) return false;
  return safeEqual(await hashHostKey(poll.id, key), poll.host_hash);
}

/**
 * When the game is over, as epoch ms.
 *
 * The client sends `endsAt` computed in the organizer's own timezone,
 * which is the only place the real timezone is known — date and time are
 * stored as bare strings with no offset. The UTC fallback is for API
 * callers that don't send one; it errs late, which only means a finished
 * game lingers a couple of hours longer.
 */
function computeEndsAt(endsAt, date, time, durationMin) {
  if (!date) return null;
  const explicit = Number(endsAt);
  if (Number.isFinite(explicit) && explicit > 0)
    return Math.min(Math.round(explicit), Date.now() + MAX_FUTURE_MS);
  const start = Date.parse(`${date}T${time || "00:00"}:00Z`);
  if (!Number.isFinite(start)) return null;
  return start + durationMin * 60000;
}

/**
 * Drop games that finished more than the grace period ago, along with
 * their RSVPs and rounds. Runs on every API request — the SELECT is
 * indexed and usually matches nothing, and there is no cron on the free
 * tier to do it on a schedule.
 */
async function purgeExpired(env) {
  const stale = await env.DB.prepare(
    `SELECT id FROM polls WHERE ends_at IS NOT NULL AND ends_at < ?`
  ).bind(Date.now() - GRACE_MS).all();

  const ids = stale.results.map((r) => r.id);
  if (!ids.length) return;

  const marks = ids.map(() => "?").join(",");
  await env.DB.batch([
    // Decided matchups outlive the game they were played in — they're the
    // only record a finished night leaves behind. Undecided ones were never
    // played, so they go with everything else.
    env.DB.prepare(
      `DELETE FROM matches WHERE winner IS NULL AND poll_id IN (${marks})`
    ).bind(...ids),
    env.DB.prepare(`DELETE FROM rounds WHERE poll_id IN (${marks})`).bind(...ids),
    env.DB.prepare(`DELETE FROM rsvps  WHERE poll_id IN (${marks})`).bind(...ids),
    env.DB.prepare(`DELETE FROM polls  WHERE id      IN (${marks})`).bind(...ids),
  ]);
}

/** Full board state: polls newest-relevant first, each with ordered RSVPs. */
async function readState(env) {
  const [polls, rsvps, rounds, matches] = await Promise.all([
    env.DB.prepare(
      `SELECT id,title,date,time,location,cap,notes,closed,created_at,
              duration_min,ends_at,host_hash
         FROM polls ORDER BY closed ASC, COALESCE(date,'9999-12-31') ASC, created_at DESC`
    ).all(),
    env.DB.prepare(
      `SELECT id,poll_id,name,skill,created_at FROM rsvps ORDER BY seq ASC`
    ).all(),
    env.DB.prepare(
      `SELECT id,poll_id,team_count,teams,bench,gap,fresh_pairs,repeats,created_at
         FROM rounds ORDER BY seq ASC`
    ).all(),
    // Matchups for games still on the board. The stored team snapshots are
    // left behind on purpose — the client already has the same players in
    // round.teams, and /state is polled every 20 seconds by every open tab.
    env.DB.prepare(
      `SELECT id,round_id,side_a,side_b,winner FROM matches
        WHERE poll_id IN (SELECT id FROM polls) ORDER BY seq ASC`
    ).all(),
  ]);

  const byPoll = new Map();
  for (const r of rsvps.results) {
    if (!byPoll.has(r.poll_id)) byPoll.set(r.poll_id, []);
    byPoll.get(r.poll_id).push({ id: r.id, name: r.name, skill: r.skill, at: r.created_at });
  }

  const matchesByRound = new Map();
  for (const m of matches.results) {
    if (!matchesByRound.has(m.round_id)) matchesByRound.set(m.round_id, []);
    matchesByRound.get(m.round_id).push({
      id: m.id, sideA: m.side_a, sideB: m.side_b, winner: m.winner,
    });
  }

  // Oldest first, so index 0 is round 1.
  const roundsByPoll = new Map();
  for (const r of rounds.results) {
    if (!roundsByPoll.has(r.poll_id)) roundsByPoll.set(r.poll_id, []);
    roundsByPoll.get(r.poll_id).push({
      id: r.id,
      teamCount: r.team_count,
      teams: JSON.parse(r.teams),
      bench: JSON.parse(r.bench),
      gap: r.gap,
      freshPairs: r.fresh_pairs,
      repeats: r.repeats,
      matches: matchesByRound.get(r.id) || [],
      at: r.created_at,
    });
  }

  return {
    polls: polls.results.map((p) => ({
      id: p.id,
      title: p.title,
      date: p.date,
      time: p.time,
      location: p.location,
      cap: p.cap,
      notes: p.notes,
      closed: !!p.closed,
      createdAt: p.created_at,
      durationMin: p.duration_min ?? DEFAULT_DURATION,
      endsAt: p.ends_at,
      // The hash never leaves the server; the client only needs to know
      // whether there is a host passcode worth prompting for.
      hasHost: !!p.host_hash,
      rsvps: byPoll.get(p.id) || [],
      rounds: roundsByPoll.get(p.id) || [],
    })),
  };
}

const ok = async (env, extra) => json({ ...(await readState(env)), ...extra });

async function getPoll(env, id) {
  return env.DB.prepare(`SELECT * FROM polls WHERE id=?`).bind(id).first();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, "");
    const method = request.method;

    let body = {};
    if (method !== "GET" && method !== "HEAD") {
      body = await request.json().catch(() => ({}));
    }

    try {
      await purgeExpired(env);

      /* ---- board ------------------------------------------------ */
      if (path === "/state" && method === "GET") return ok(env);

      /* ---- admin sign in ---------------------------------------- */
      if (path === "/admin/verify" && method === "POST") {
        if (!env.ADMIN_PASSCODE)
          return bad("No admin passcode is set on the server yet.", 503);
        if (!safeEqual(String(body.passcode ?? ""), env.ADMIN_PASSCODE))
          return bad("That passcode doesn't match.", 401);
        return json({ ok: true });
      }

      /* ---- post a game — open to anyone ------------------------- */
      if (path === "/polls" && method === "POST") {
        const title = norm(body.title);
        const cap = Number(body.cap);
        const passcode = String(body.hostPasscode ?? "");

        if (title.length < 2) return bad("Give the game a name players will recognize.");
        if (!Number.isInteger(cap) || cap < 2 || cap > 60)
          return bad("Player cap has to be a whole number between 2 and 60.");
        if (passcode.length < MIN_PASSCODE)
          return bad(
            `Set a passcode of at least ${MIN_PASSCODE} characters — it's what lets you run this game later.`
          );

        const duration = has(body, "durationMin") ? Number(body.durationMin) : DEFAULT_DURATION;
        if (!Number.isInteger(duration) || duration < 15 || duration > MAX_DURATION)
          return bad(`Length has to be between 15 and ${MAX_DURATION} minutes.`);

        const id = uid();
        const date = norm(body.date) || null;
        const time = norm(body.time) || null;

        await env.DB.prepare(
          `INSERT INTO polls
             (id,title,date,time,location,cap,notes,closed,created_at,
              host_hash,duration_min,ends_at)
           VALUES (?,?,?,?,?,?,?,0,?,?,?,?)`
        )
          .bind(
            id, title, date, time, norm(body.location) || null, cap,
            norm(body.notes) || null, Date.now(),
            await hashHostKey(id, passcode), duration,
            computeEndsAt(body.endsAt, date, time, duration)
          )
          .run();

        // The client files its host key under this id, so it has to know it.
        return ok(env, { created: id });
      }

      /* ---- prove you hold a game's passcode --------------------- */
      const unlockMatch = path.match(/^\/polls\/([\w-]+)\/unlock$/);
      if (unlockMatch && method === "POST") {
        const poll = await getPoll(env, unlockMatch[1]);
        if (!poll) return bad("That game is gone.", 404);
        if (!poll.host_hash)
          return bad("This game has no passcode of its own — only an admin can run it.", 403);
        if (!safeEqual(await hashHostKey(poll.id, String(body.passcode ?? "")), poll.host_hash))
          return bad("That passcode doesn't match this game.", 401);
        return json({ ok: true });
      }

      /* ---- edit / delete a game --------------------------------- */
      const pollMatch = path.match(/^\/polls\/([\w-]+)$/);
      if (pollMatch && (method === "DELETE" || method === "PATCH")) {
        const id = pollMatch[1];
        const poll = await getPoll(env, id);
        if (!poll) return bad("That game is gone.", 404);
        if (!(await canManage(request, env, poll)))
          return bad("You need this game's passcode, or the admin one.", 401);

        if (method === "DELETE") {
          await env.DB.batch([
            // Results that were actually recorded stand. Removing a game is
            // housekeeping, not a claim that the volleyball never happened.
            env.DB.prepare(`DELETE FROM matches WHERE poll_id=? AND winner IS NULL`).bind(id),
            env.DB.prepare(`DELETE FROM rounds WHERE poll_id=?`).bind(id),
            env.DB.prepare(`DELETE FROM rsvps WHERE poll_id=?`).bind(id),
            env.DB.prepare(`DELETE FROM polls WHERE id=?`).bind(id),
          ]);
          return ok(env);
        }

        // PATCH. Only the fields actually sent are touched, so editing the
        // start time doesn't quietly blank the notes.
        const sets = [];
        const vals = [];
        const put = (col, v) => { sets.push(`${col}=?`); vals.push(v); };

        if (has(body, "closed") && typeof body.closed === "boolean")
          put("closed", body.closed ? 1 : 0);

        if (has(body, "title")) {
          const title = norm(body.title);
          if (title.length < 2) return bad("Give the game a name players will recognize.");
          put("title", title);
        }

        if (has(body, "cap")) {
          const cap = Number(body.cap);
          if (!Number.isInteger(cap) || cap < 2 || cap > 60)
            return bad("Player cap has to be a whole number between 2 and 60.");
          // Past rounds are a record of what was played, so they stand.
          put("cap", cap);
        }

        if (has(body, "location")) put("location", norm(body.location) || null);
        if (has(body, "notes")) put("notes", norm(body.notes) || null);

        // Date, time and length all feed ends_at, so touching any of them
        // means recomputing expiry from the full post-edit picture.
        const touchesSchedule =
          has(body, "date") || has(body, "time") ||
          has(body, "durationMin") || has(body, "endsAt");

        let date = poll.date;
        let time = poll.time;
        let duration = poll.duration_min ?? DEFAULT_DURATION;

        if (has(body, "date")) { date = norm(body.date) || null; put("date", date); }
        if (has(body, "time")) { time = norm(body.time) || null; put("time", time); }
        if (has(body, "durationMin")) {
          duration = Number(body.durationMin);
          if (!Number.isInteger(duration) || duration < 15 || duration > MAX_DURATION)
            return bad(`Length has to be between 15 and ${MAX_DURATION} minutes.`);
          put("duration_min", duration);
        }
        if (touchesSchedule) put("ends_at", computeEndsAt(body.endsAt, date, time, duration));

        if (!sets.length) return bad("Nothing to change.");

        vals.push(id);
        await env.DB.prepare(`UPDATE polls SET ${sets.join(",")} WHERE id=?`).bind(...vals).run();
        return ok(env);
      }

      /* ---- RSVP in / out ---------------------------------------- */
      const rsvpMatch = path.match(/^\/polls\/([\w-]+)\/rsvps$/);
      if (rsvpMatch) {
        const pollId = rsvpMatch[1];
        const poll = await getPoll(env, pollId);
        if (!poll) return bad("That game is gone.", 404);

        if (method === "POST") {
          if (poll.closed) return bad("Voting is closed for this game.");
          const name = norm(body.name);
          const skill = String(body.skill ?? "");
          if (name.length < 2) return bad("Enter the name your teammates know you by.");
          if (name.length > 40) return bad("That name is too long — 40 characters max.");
          if (!SKILLS.has(skill)) return bad("Pick a skill level.");

          try {
            await env.DB.prepare(
              `INSERT INTO rsvps (id,poll_id,name,name_key,skill,created_at) VALUES (?,?,?,?,?,?)`
            ).bind(uid(), pollId, name, name.toLowerCase(), skill, Date.now()).run();
          } catch (e) {
            // The UNIQUE index is what actually prevents double-booking under
            // a race, not a read-then-write check.
            if (String(e).includes("UNIQUE"))
              return bad(`${name} is already on this list. Add a last initial if there are two of you.`, 409);
            throw e;
          }
            return ok(env);
        }

        if (method === "DELETE") {
          const name = norm(body.name).toLowerCase();
          if (!name) return bad("Type your name first.");
          const res = await env.DB.prepare(
            `DELETE FROM rsvps WHERE poll_id=? AND name_key=?`
          ).bind(pollId, name).run();
          if (!res.meta.changes) return bad("No RSVP under that name. Check the spelling.", 404);
            return ok(env);
        }
      }

      /* ---- organizer removes a player --------------------------- */
      const kickMatch = path.match(/^\/polls\/([\w-]+)\/rsvps\/([\w-]+)$/);
      if (kickMatch && method === "DELETE") {
        const poll = await getPoll(env, kickMatch[1]);
        if (!poll) return bad("That game is gone.", 404);
        if (!(await canManage(request, env, poll)))
          return bad("You need this game's passcode, or the admin one.", 401);
        await env.DB.prepare(`DELETE FROM rsvps WHERE poll_id=? AND id=?`)
          .bind(kickMatch[1], kickMatch[2]).run();
        return ok(env);
      }

      /* ---- rounds: mix, undo, clear ----------------------------- */
      const roundsMatch = path.match(/^\/polls\/([\w-]+)\/rounds$/);
      if (roundsMatch && (method === "POST" || method === "DELETE")) {
        const pollId = roundsMatch[1];
        const poll = await getPoll(env, pollId);
        if (!poll) return bad("That game is gone.", 404);
        if (!(await canManage(request, env, poll)))
          return bad("You need this game's passcode, or the admin one.", 401);

        // Wipe the whole session and start over.
        if (method === "DELETE") {
          // Starting the session over does say the rounds never happened, so
          // their results go too — decided or not.
          await env.DB.batch([
            env.DB.prepare(`DELETE FROM matches WHERE poll_id=?`).bind(pollId),
            env.DB.prepare(`DELETE FROM rounds WHERE poll_id=?`).bind(pollId),
          ]);
          return ok(env);
        }

        const n = Number(body.teamCount);
        if (!Number.isInteger(n) || n < 2 || n > 6) return bad("Pick between 2 and 6 sides.");

        const roster = await env.DB.prepare(
          `SELECT id,name,skill FROM rsvps WHERE poll_id=? ORDER BY seq ASC LIMIT ?`
        ).bind(pollId, poll.cap).all();

        const maxSide = Math.floor(roster.results.length / n);
        if (maxSide < 1)
          return bad(`You need at least ${n} players on the roster for ${n} sides.`);

        // Side size is optional: leaving it out puts as many on court as fit.
        let perTeam = null;
        if (body.perTeam !== undefined && body.perTeam !== null) {
          perTeam = Number(body.perTeam);
          if (!Number.isInteger(perTeam) || perTeam < 1 || perTeam > 12)
            return bad("Players a side has to be a whole number between 1 and 12.");
          if (perTeam > maxSide)
            return bad(
              `${n} sides of ${perTeam} needs ${n * perTeam} players — the roster has ${roster.results.length}.`
            );
        }

        // Previous rounds drive both the pairing memory and bench rotation.
        const prev = await env.DB.prepare(
          `SELECT teams,bench FROM rounds WHERE poll_id=? ORDER BY seq ASC`
        ).bind(pollId).all();

        const history = prev.results.map((r) => ({
          teams: JSON.parse(r.teams),
          bench: JSON.parse(r.bench),
        }));

        const round = mixRound(roster.results, n, perTeam, history);

        const roundId = uid();
        const now = Date.now();

        // Every pair of sides is a matchup waiting for a result: two sides
        // make one, four make six. With more than two sides up you play each
        // other side in turn rather than all at once, and there's no telling
        // in advance how many of those you'll get through — so they're
        // written undecided and are free to stay that way.
        const matchups = [];
        for (let i = 0; i < round.teams.length; i++) {
          for (let j = i + 1; j < round.teams.length; j++) {
            matchups.push(
              env.DB.prepare(
                `INSERT INTO matches
                   (id,poll_id,round_id,side_a,side_b,winner,team_a,team_b,
                    reported_by,created_at,decided_at)
                 VALUES (?,?,?,?,?,NULL,?,?,NULL,?,NULL)`
              ).bind(
                uid(), pollId, roundId, i, j,
                JSON.stringify(round.teams[i]), JSON.stringify(round.teams[j]), now
              )
            );
          }
        }

        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO rounds
               (id,poll_id,team_count,teams,bench,gap,fresh_pairs,repeats,created_at)
             VALUES (?,?,?,?,?,?,?,?,?)`
          ).bind(
            roundId, pollId, n,
            JSON.stringify(round.teams), JSON.stringify(round.bench),
            round.gap, round.freshPairs, round.repeats, now
          ),
          ...matchups,
        ]);

        return ok(env);
      }

      /* ---- undo a single round ---------------------------------- */
      const oneRound = path.match(/^\/polls\/([\w-]+)\/rounds\/([\w-]+)$/);
      if (oneRound && method === "DELETE") {
        const poll = await getPoll(env, oneRound[1]);
        if (!poll) return bad("That game is gone.", 404);
        if (!(await canManage(request, env, poll)))
          return bad("You need this game's passcode, or the admin one.", 401);
        const res = await env.DB.prepare(`DELETE FROM rounds WHERE poll_id=? AND id=?`)
          .bind(oneRound[1], oneRound[2]).run();
        if (!res.meta.changes) return bad("That round is already gone.", 404);
        // Undo means it didn't happen, so its results don't either.
        await env.DB.prepare(`DELETE FROM matches WHERE round_id=?`).bind(oneRound[2]).run();
        return ok(env);
      }

      /* ---- record who won a matchup ----------------------------- */
      //
      // Deliberately open at the front: anyone looking at the page can settle
      // a matchup nobody has recorded yet, because whoever just finished
      // playing is usually not whoever is holding the passcode. Changing or
      // clearing a result that's already down needs the game's passcode —
      // otherwise the last person to tap wins every argument.
      const matchup = path.match(/^\/polls\/([\w-]+)\/matches\/([\w-]+)$/);
      if (matchup && method === "PUT") {
        const [, pollId, matchId] = matchup;
        const poll = await getPoll(env, pollId);
        if (!poll) return bad("That game is gone.", 404);

        const match = await env.DB.prepare(
          `SELECT id,side_a,side_b,winner FROM matches WHERE id=? AND poll_id=?`
        ).bind(matchId, pollId).first();
        if (!match) return bad("That matchup is gone.", 404);

        if (!has(body, "winner")) return bad("Nothing to change.");
        const winner = body.winner === null ? null : Number(body.winner);
        if (winner !== null && winner !== match.side_a && winner !== match.side_b)
          return bad("Pick one of the two sides that played.");

        const manage = await canManage(request, env, poll);
        if (!manage && match.winner !== null)
          return bad("Someone already recorded this one. This game's passcode can change it.", 403);
        if (!manage && winner === null)
          return bad("Only whoever runs this game can clear a result.", 403);

        const by = isAdmin(request, env) ? "admin" : manage ? "host" : "anyone";
        await env.DB.prepare(
          `UPDATE matches SET winner=?, reported_by=?, decided_at=? WHERE id=?`
        ).bind(
          winner,
          winner === null ? null : by,
          winner === null ? null : Date.now(),
          matchId
        ).run();

        return ok(env);
      }

      return bad("No such endpoint.", 404);
    } catch (err) {
      console.error(err);
      return bad("Something broke on the server. Try again.", 500);
    }
  },
};
