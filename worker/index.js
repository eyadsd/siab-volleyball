/**
 * SIAB API — Cloudflare Worker + D1
 *
 * Every mutating route returns the full fresh state so the client never
 * has to guess. Roster/waitlist split is derived from RSVP order, so
 * promotion off the waitlist is automatic — there is no "promote" step
 * to get wrong.
 */

import { mixRound } from "./balance.js";

const SKILLS = new Set(["B", "I", "A"]);
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const bad = (msg, status = 400) => json({ error: msg }, status);
const uid = () => crypto.randomUUID().slice(0, 12);
const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ");

/** Constant-time string compare so the passcode can't be timed out byte by byte. */
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function isAdmin(request, env) {
  const key = request.headers.get("x-siab-key");
  if (!key || !env.ADMIN_PASSCODE) return false;
  return safeEqual(key, env.ADMIN_PASSCODE);
}

/** Full board state: polls newest-relevant first, each with ordered RSVPs. */
async function readState(env) {
  const [polls, rsvps, rounds] = await Promise.all([
    env.DB.prepare(
      `SELECT id,title,date,time,location,cap,notes,closed,created_at
         FROM polls ORDER BY closed ASC, COALESCE(date,'9999-12-31') ASC, created_at DESC`
    ).all(),
    env.DB.prepare(
      `SELECT id,poll_id,name,skill,created_at FROM rsvps ORDER BY seq ASC`
    ).all(),
    env.DB.prepare(
      `SELECT id,poll_id,team_count,teams,bench,gap,fresh_pairs,repeats,created_at
         FROM rounds ORDER BY seq ASC`
    ).all(),
  ]);

  const byPoll = new Map();
  for (const r of rsvps.results) {
    if (!byPoll.has(r.poll_id)) byPoll.set(r.poll_id, []);
    byPoll.get(r.poll_id).push({ id: r.id, name: r.name, skill: r.skill, at: r.created_at });
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
      rsvps: byPoll.get(p.id) || [],
      rounds: roundsByPoll.get(p.id) || [],
    })),
  };
}

const ok = async (env) => json(await readState(env));

async function getPoll(env, id) {
  return env.DB.prepare(`SELECT * FROM polls WHERE id=?`).bind(id).first();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, "");
    const method = request.method;
    const admin = isAdmin(request, env);

    let body = {};
    if (method !== "GET" && method !== "HEAD") {
      body = await request.json().catch(() => ({}));
    }

    const need = () => (admin ? null : bad("Organizer passcode required.", 401));

    try {
      /* ---- board ------------------------------------------------ */
      if (path === "/state" && method === "GET") return ok(env);

      /* ---- organizer sign in ------------------------------------ */
      if (path === "/admin/verify" && method === "POST") {
        if (!env.ADMIN_PASSCODE)
          return bad("No organizer passcode is set on the server yet.", 503);
        if (!safeEqual(String(body.passcode ?? ""), env.ADMIN_PASSCODE))
          return bad("That passcode doesn't match.", 401);
        return json({ ok: true });
      }

      /* ---- create a game ---------------------------------------- */
      if (path === "/polls" && method === "POST") {
        const guard = need();
        if (guard) return guard;

        const title = norm(body.title);
        const cap = Number(body.cap);
        if (title.length < 2) return bad("Give the game a name players will recognize.");
        if (!Number.isInteger(cap) || cap < 2 || cap > 60)
          return bad("Player cap has to be a whole number between 2 and 60.");

        await env.DB.prepare(
          `INSERT INTO polls (id,title,date,time,location,cap,notes,closed,created_at)
           VALUES (?,?,?,?,?,?,?,0,?)`
        )
          .bind(uid(), title, norm(body.date) || null, norm(body.time) || null,
                norm(body.location) || null, cap, norm(body.notes) || null, Date.now())
          .run();
        return ok(env);
      }

      /* ---- edit / delete a game --------------------------------- */
      const pollMatch = path.match(/^\/polls\/([\w-]+)$/);
      if (pollMatch) {
        const guard = need();
        if (guard) return guard;
        const id = pollMatch[1];

        if (method === "DELETE") {
          await env.DB.batch([
            env.DB.prepare(`DELETE FROM rounds WHERE poll_id=?`).bind(id),
            env.DB.prepare(`DELETE FROM rsvps WHERE poll_id=?`).bind(id),
            env.DB.prepare(`DELETE FROM polls WHERE id=?`).bind(id),
          ]);
          return ok(env);
        }

        if (method === "PATCH") {
          const poll = await getPoll(env, id);
          if (!poll) return bad("That game is gone.", 404);
          if (typeof body.closed === "boolean") {
            await env.DB.prepare(`UPDATE polls SET closed=? WHERE id=?`)
              .bind(body.closed ? 1 : 0, id).run();
          }
          if (body.cap !== undefined) {
            const cap = Number(body.cap);
            if (!Number.isInteger(cap) || cap < 2 || cap > 60)
              return bad("Player cap has to be a whole number between 2 and 60.");
            // Past rounds are a record of what was played, so they stand.
            await env.DB.prepare(`UPDATE polls SET cap=? WHERE id=?`).bind(cap, id).run();
          }
          return ok(env);
        }
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
        const guard = need();
        if (guard) return guard;
        await env.DB.prepare(`DELETE FROM rsvps WHERE poll_id=? AND id=?`)
          .bind(kickMatch[1], kickMatch[2]).run();
        return ok(env);
      }

      /* ---- rounds: mix, undo, clear ----------------------------- */
      const roundsMatch = path.match(/^\/polls\/([\w-]+)\/rounds$/);
      if (roundsMatch) {
        const guard = need();
        if (guard) return guard;
        const pollId = roundsMatch[1];

        // Wipe the whole session and start over.
        if (method === "DELETE") {
          await env.DB.prepare(`DELETE FROM rounds WHERE poll_id=?`).bind(pollId).run();
          return ok(env);
        }

        if (method === "POST") {
          const poll = await getPoll(env, pollId);
          if (!poll) return bad("That game is gone.", 404);

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

          await env.DB.prepare(
            `INSERT INTO rounds
               (id,poll_id,team_count,teams,bench,gap,fresh_pairs,repeats,created_at)
             VALUES (?,?,?,?,?,?,?,?,?)`
          ).bind(
            uid(), pollId, n,
            JSON.stringify(round.teams), JSON.stringify(round.bench),
            round.gap, round.freshPairs, round.repeats, Date.now()
          ).run();

          return ok(env);
        }
      }

      /* ---- undo a single round ---------------------------------- */
      const oneRound = path.match(/^\/polls\/([\w-]+)\/rounds\/([\w-]+)$/);
      if (oneRound && method === "DELETE") {
        const guard = need();
        if (guard) return guard;
        const res = await env.DB.prepare(`DELETE FROM rounds WHERE poll_id=? AND id=?`)
          .bind(oneRound[1], oneRound[2]).run();
        if (!res.meta.changes) return bad("That round is already gone.", 404);
        return ok(env);
      }

      return bad("No such endpoint.", 404);
    } catch (err) {
      console.error(err);
      return bad("Something broke on the server. Try again.", 500);
    }
  },
};
