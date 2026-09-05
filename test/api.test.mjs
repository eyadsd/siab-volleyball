import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../worker/index.js";

// Minimal D1 shim over real SQLite so the actual SQL is exercised.
const db = new DatabaseSync(":memory:");
db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
const isSelect = (s) => /^\s*select/i.test(s);
const D1 = {
  prepare(sql) {
    return {
      bind(...a) { this.a = a; return this; },
      async all() { return { results: db.prepare(sql).all(...(this.a||[])) }; },
      async first() { return db.prepare(sql).get(...(this.a||[])) ?? null; },
      async run() {
        const r = db.prepare(sql).run(...(this.a||[]));
        return { meta: { changes: Number(r.changes) } };
      },
      a: [],
    };
  },
  async batch(stmts) { for (const s of stmts) await s.run(); return []; },
};
const env = { DB: D1, ADMIN_PASSCODE: "hunter2" };

let pass = 0, fail = 0;
const t = (label, cond) => { cond ? pass++ : fail++; console.log(`${cond?"ok  ":"FAIL"} ${label}`); };

// `key` is the site-wide admin passcode, `host` a single game's own.
const call = (path, { method = "GET", body, key, host } = {}) =>
  worker.fetch(new Request(`https://x/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(key ? { "x-siab-key": key } : {}),
      ...(host ? { "x-siab-poll-key": host } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }), env);

const j = async (r) => [r.status, await r.json()];

// Games expire, so a fixture pinned to a literal date would start failing
// the moment that date passed. Everything schedulable is relative to now.
const day = (offset) =>
  new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const HOST = "letmein";

// --- admin auth ---
let [s] = await j(await call("/admin/verify", { method: "POST", body: { passcode: "wrong" } }));
t("wrong admin passcode rejected", s === 401);
[s] = await j(await call("/admin/verify", { method: "POST", body: { passcode: "hunter2" } }));
t("right admin passcode accepted", s === 200);

// --- validation ---
[s] = await j(await call("/polls", { method: "POST", body: { title: "a", cap: 4, hostPasscode: HOST } }));
t("title too short rejected", s === 400);
[s] = await j(await call("/polls", { method: "POST", body: { title: "Ok", cap: 999, hostPasscode: HOST } }));
t("absurd cap rejected", s === 400);
[s] = await j(await call("/polls", { method: "POST", body: { title: "Ok", cap: 4 } }));
t("posting without a game passcode rejected", s === 400);
[s] = await j(await call("/polls", { method: "POST", body: { title: "Ok", cap: 4, hostPasscode: "ab" } }));
t("too-short game passcode rejected", s === 400);
[s] = await j(await call("/polls", { method: "POST",
  body: { title: "Ok", cap: 4, hostPasscode: HOST, durationMin: 5000 } }));
t("absurd game length rejected", s === 400);

// --- create a 4-cap game: no admin passcode needed ---
let st;
[s, st] = await j(await call("/polls", { method: "POST",
  body: { title: "Thursday 6s", cap: 4, date: day(7), time: "19:00", location: "Gym",
          hostPasscode: HOST } }));
t("anyone can post a game", s === 200 && st.polls.length === 1);
t("create hands back the new id so the host keeps its key", typeof st.created === "string");
const id = st.created;
t("the board says the game has a passcode", st.polls[0].hasHost === true);
t("the hash never leaves the server",
  !JSON.stringify(st).includes("host_hash") && !("hostHash" in st.polls[0]));

// --- five skill levels ---
for (const [n, sk] of [["Ana","A"],["Bea","UI"],["Cy","A"],["Dov","BI"],["Eve","I"],["Fay","B"]]) {
  [s, st] = await j(await call(`/polls/${id}/rsvps`, { method: "POST", body: { name: n, skill: sk } }));
}
let p = st.polls[0];
t("six RSVPs stored in order", p.rsvps.map(r=>r.name).join(",") === "Ana,Bea,Cy,Dov,Eve,Fay");
t("active roster capped at 4", p.rsvps.slice(0,p.cap).map(r=>r.name).join(",") === "Ana,Bea,Cy,Dov");
t("overflow lands on waitlist", p.rsvps.slice(p.cap).map(r=>r.name).join(",") === "Eve,Fay");
t("the two new levels round-trip",
  p.rsvps.find(r=>r.name==="Bea").skill === "UI" && p.rsvps.find(r=>r.name==="Dov").skill === "BI");

// --- duplicate name ---
[s] = await j(await call(`/polls/${id}/rsvps`, { method: "POST", body: { name: "ana", skill: "B" } }));
t("duplicate name (case-insensitive) blocked", s === 409);

// --- bad skill ---
[s] = await j(await call(`/polls/${id}/rsvps`, { method: "POST", body: { name: "Zed", skill: "Z" } }));
t("invalid skill rejected", s === 400);
[s] = await j(await call(`/polls/${id}/rsvps`, { method: "POST", body: { name: "Zed", skill: "ui" } }));
t("skill level is case-sensitive", s === 400);

// --- cancellation promotes waitlist head ---
[s, st] = await j(await call(`/polls/${id}/rsvps`, { method: "DELETE", body: { name: "Bea" } }));
p = st.polls[0];
t("Eve promoted into active roster", p.rsvps.slice(0,p.cap).map(r=>r.name).join(",") === "Ana,Cy,Dov,Eve");
t("Fay still waiting", p.rsvps.slice(p.cap).map(r=>r.name).join(",") === "Fay");

[s] = await j(await call(`/polls/${id}/rsvps`, { method: "DELETE", body: { name: "Ghost" } }));
t("cancelling unknown name 404s", s === 404);


/* ---- per-game passcodes ------------------------------------------- */

[s] = await j(await call(`/polls/${id}/unlock`, { method: "POST", body: { passcode: "nope" } }));
t("wrong game passcode rejected", s === 401);
[s] = await j(await call(`/polls/${id}/unlock`, { method: "POST", body: { passcode: HOST } }));
t("right game passcode accepted", s === 200);

[s] = await j(await call(`/polls/${id}`, { method: "PATCH", body: { closed: true } }));
t("no passcode at all cannot manage a game", s === 401);
[s] = await j(await call(`/polls/${id}`, { method: "PATCH", host: "nope", body: { closed: true } }));
t("wrong game passcode cannot manage a game", s === 401);
[s] = await j(await call(`/polls/${id}`, { method: "PATCH", key: "nope", body: { closed: true } }));
t("wrong admin passcode cannot manage a game", s === 401);

// A second game, so a host key can be shown not to travel between games.
let [, other] = await j(await call("/polls", { method: "POST",
  body: { title: "Someone else's game", cap: 4, hostPasscode: "otherpass" } }));
const otherId = other.created;
[s] = await j(await call(`/polls/${otherId}`, { method: "PATCH", host: HOST, body: { closed: true } }));
t("a game's passcode does not open a different game", s === 401);
[s] = await j(await call(`/polls/${otherId}/unlock`, { method: "POST", body: { passcode: HOST } }));
t("a game's passcode does not unlock a different game", s === 401);
[s, st] = await j(await call(`/polls/${otherId}`, { method: "PATCH", key: "hunter2",
  body: { closed: true } }));
t("admin manages a game it did not create",
  st.polls.find(x => x.id === otherId).closed === true);
[s] = await j(await call(`/polls/${otherId}`, { method: "DELETE", key: "hunter2" }));
t("admin deletes a game it did not create", s === 200);

// Identical passcodes on two games must not hash alike — the poll id salts them.
let [, twin] = await j(await call("/polls", { method: "POST",
  body: { title: "Twin one", cap: 4, hostPasscode: HOST } }));
const twinId = twin.created;
const hashes = db.prepare("SELECT host_hash h FROM polls WHERE id IN (?,?)").all(id, twinId);
t("the same passcode on two games hashes differently", hashes[0].h !== hashes[1].h);
t("passcodes are not stored in the clear",
  hashes.every(r => r.h && r.h.length === 64 && !r.h.includes(HOST)));
await call(`/polls/${twinId}`, { method: "DELETE", key: "hunter2" });

// A pre-passcode game (host_hash NULL) is admin-only, not open to all.
db.prepare(`INSERT INTO polls (id,title,cap,closed,created_at,duration_min)
            VALUES ('legacy1','Old game',6,0,1,120)`).run();
[s] = await j(await call("/polls/legacy1", { method: "PATCH", body: { closed: true } }));
t("a game with no passcode is not open to everyone", s === 401);
[s] = await j(await call("/polls/legacy1/unlock", { method: "POST", body: { passcode: "" } }));
t("a game with no passcode cannot be unlocked", s === 403);
[s] = await j(await call("/polls/legacy1", { method: "PATCH", key: "hunter2", body: { closed: true } }));
t("admin still manages a game with no passcode", s === 200);
await call("/polls/legacy1", { method: "DELETE", key: "hunter2" });


/* ---- editing a posted game ----------------------------------------- */

[s, st] = await j(await call(`/polls/${id}`, { method: "PATCH", host: HOST,
  body: { date: day(9), time: "20:30", notes: "Bring a light shirt", durationMin: 90 } }));
p = st.polls.find(x => x.id === id);
t("the host reschedules their own game",
  p.date === day(9) && p.time === "20:30" && p.durationMin === 90);
t("the description is editable", p.notes === "Bring a light shirt");
t("the title survives an edit that didn't mention it", p.title === "Thursday 6s");
t("rescheduling moves the expiry with it",
  p.endsAt > Date.now() && p.endsAt < Date.now() + 11 * 86400000);

[s, st] = await j(await call(`/polls/${id}`, { method: "PATCH", host: HOST,
  body: { title: "Thursday 6s (later start)", location: "Gym B" } }));
p = st.polls.find(x => x.id === id);
t("title and place are editable", p.title === "Thursday 6s (later start)" && p.location === "Gym B");
t("an edit that skips the schedule leaves it alone", p.time === "20:30" && p.durationMin === 90);
t("an edit that skips the notes leaves them alone", p.notes === "Bring a light shirt");

[s] = await j(await call(`/polls/${id}`, { method: "PATCH", host: HOST, body: { title: "x" } }));
t("an edit to a too-short title is rejected", s === 400);
[s] = await j(await call(`/polls/${id}`, { method: "PATCH", host: HOST, body: { cap: 0 } }));
t("an edit to an impossible cap is rejected", s === 400);
[s] = await j(await call(`/polls/${id}`, { method: "PATCH", host: HOST, body: {} }));
t("an empty edit is rejected", s === 400);
[s] = await j(await call("/polls/gone/", { method: "PATCH", key: "hunter2", body: { cap: 4 } }));
t("editing a missing game 404s", s === 404);

// An explicit endsAt from the browser wins over the server's UTC guess.
const pinned = Date.now() + 3 * 86400000;
[s, st] = await j(await call(`/polls/${id}`, { method: "PATCH", host: HOST,
  body: { date: day(3), time: "19:00", durationMin: 120, endsAt: pinned } }));
t("the browser's end timestamp is what gets stored",
  st.polls.find(x => x.id === id).endsAt === pinned);


// --- signup order survives same-millisecond submissions ---
[s, st] = await j(await call("/polls", { method: "POST",
  body: { title: "Race test", cap: 2, hostPasscode: HOST } }));
const rid = st.created;
for (const n of ["One","Two","Three","Four","Five"]) {
  [s, st] = await j(await call(`/polls/${rid}/rsvps`, { method: "POST", body: { name: n, skill: "I" } }));
}
const race = st.polls.find(x => x.id === rid);
t("burst signups keep arrival order", race.rsvps.map(r=>r.name).join(",") === "One,Two,Three,Four,Five");
t("burst waitlist order is first-come", race.rsvps.slice(2).map(r=>r.name).join(",") === "Three,Four,Five");
await call(`/polls/${rid}`, { method: "DELETE", key: "hunter2" });

// --- rounds ---
[s, st] = await j(await call(`/polls/${id}/rounds`, { method: "POST", host: HOST, body: { teamCount: 2 } }));
p = st.polls.find(x => x.id === id);
t("round 1 created", p.rounds.length === 1);
t("round drawn from active roster only", p.rounds[0].teams.flat().length + p.rounds[0].bench.length === 4);
t("waitlisted player excluded from the round",
  ![...p.rounds[0].teams.flat(), ...p.rounds[0].bench].some(x => x.name === "Fay"));

[s] = await j(await call(`/polls/${id}/rounds`, { method: "POST", body: { teamCount: 2 } }));
t("mixing requires a passcode", s === 401);
[s] = await j(await call(`/polls/${id}/rounds`, { method: "POST", host: "nope", body: { teamCount: 2 } }));
t("mixing with the wrong game passcode is refused", s === 401);

[s, st] = await j(await call(`/polls/${id}/rounds`, { method: "POST", key: "hunter2", body: { teamCount: 2 } }));
p = st.polls.find(x => x.id === id);
t("admin can mix any game's rounds", p.rounds.length === 2);
t("rounds come back oldest-first", p.rounds[0].at <= p.rounds[1].at);

const sigOf = (r) => r.teams.map(x => x.map(y=>y.id).sort().join(",")).sort().join("|");
t("round 2 is a different lineup", sigOf(p.rounds[0]) !== sigOf(p.rounds[1]));
t("round 2 stayed balanced while reshuffling", p.rounds[1].gap <= 2);

[s] = await j(await call(`/polls/${id}/rounds`, { method: "POST", host: HOST, body: { teamCount: 9 } }));
t("absurd team count rejected", s === 400);

// roster changes must NOT rewrite history
[s, st] = await j(await call(`/polls/${id}/rsvps`, { method: "POST", body: { name: "Gil", skill: "UI" } }));
t("past rounds survive a roster change", st.polls.find(x => x.id === id).rounds.length === 2);

// undo one round
const r1id = st.polls.find(x => x.id === id).rounds[0].id;
[s, st] = await j(await call(`/polls/${id}/rounds/${r1id}`, { method: "DELETE", host: HOST }));
t("single round undone", st.polls.find(x => x.id === id).rounds.length === 1);
[s] = await j(await call(`/polls/${id}/rounds/${r1id}`, { method: "DELETE", host: HOST }));
t("undoing a gone round 404s", s === 404);
[s] = await j(await call(`/polls/${id}/rounds/${r1id}`, { method: "DELETE" }));
t("undoing a round requires a passcode", s === 401);

// clear session
[s] = await j(await call(`/polls/${id}/rounds`, { method: "DELETE" }));
t("clearing session requires a passcode", s === 401);
[s, st] = await j(await call(`/polls/${id}/rounds`, { method: "DELETE", host: HOST }));
t("session cleared", st.polls.find(x => x.id === id).rounds.length === 0);

// removing a player
[s] = await j(await call(`/polls/${id}/rsvps/whatever`, { method: "DELETE" }));
t("removing a player requires a passcode", s === 401);


// --- explicit side size over the API ---
[s, st] = await j(await call("/polls", { method: "POST",
  body: { title: "Four a side", cap: 12, hostPasscode: HOST } }));
const fid = st.created;
for (let i = 0; i < 10; i++)
  await call(`/polls/${fid}/rsvps`, { method: "POST",
    body: { name: `Sub${i}`, skill: ["B","BI","I","UI","A"][i%5] } });

[s, st] = await j(await call(`/polls/${fid}/rounds`, { method: "POST", host: HOST,
  body: { teamCount: 2, perTeam: 4 } }));
let fr = st.polls.find(x => x.id === fid).rounds[0];
t("4 v 4 requested and delivered", fr.teams.every(x => x.length === 4));
t("remaining players benched", fr.bench.length === 2);

[s] = await j(await call(`/polls/${fid}/rounds`, { method: "POST", host: HOST,
  body: { teamCount: 2, perTeam: 8 } }));
t("side size beyond the roster refused", s === 400);
[s] = await j(await call(`/polls/${fid}/rounds`, { method: "POST", host: HOST,
  body: { teamCount: 2, perTeam: 0 } }));
t("zero a side refused", s === 400);

[s, st] = await j(await call(`/polls/${fid}/rounds`, { method: "POST", host: HOST,
  body: { teamCount: 2 } }));
fr = st.polls.find(x => x.id === fid).rounds[1];
t("omitting side size fills the court", fr.teams.every(x => x.length === 5) && fr.bench.length === 0);
await call(`/polls/${fid}`, { method: "DELETE", host: HOST });
t("a host can delete their own game",
  (await (await call("/state")).json()).polls.every(x => x.id !== fid));


/* ---- games clear themselves off the board -------------------------- */

const HOUR = 3600000;
const mkExpiring = async (title, endsAt) => {
  const [, made] = await j(await call("/polls", { method: "POST",
    body: { title, cap: 6, date: day(-1), time: "19:00", hostPasscode: HOST, endsAt } }));
  return made.created;
};
const board = async () => (await (await call("/state")).json()).polls;
const onBoard = async (pid) => (await board()).some(x => x.id === pid);

// Inside the grace period: finished, but still there for anyone reading it.
const fresh = await mkExpiring("Just wrapped", Date.now() - 20 * 60000);
t("a game that just ended stays up during the grace hour", await onBoard(fresh));

// Past the grace period.
const old = await mkExpiring("Long over", Date.now() - 2 * HOUR);
await call(`/polls/${old}/rsvps`, { method: "POST", body: { name: "Ghosty", skill: "I" } });
t("an expired game is swept on the next request", !(await onBoard(old)));
t("its RSVPs go with it",
  db.prepare("SELECT COUNT(*) c FROM rsvps WHERE poll_id=?").get(old).c === 0);
t("the game that ended minutes ago is untouched by the sweep", await onBoard(fresh));

// The boundary itself: exactly one hour old is still inside the grace.
const edge = await mkExpiring("On the hour", Date.now() - HOUR + 30000);
t("a game one minute short of the full hour survives", await onBoard(edge));
db.prepare("UPDATE polls SET ends_at=? WHERE id=?").run(Date.now() - HOUR - 60000, edge);
t("a game one minute past the full hour is swept", !(await onBoard(edge)));

// No date means no end, so it waits for a human.
const [, tbd] = await j(await call("/polls", { method: "POST",
  body: { title: "Date TBD", cap: 6, hostPasscode: HOST } }));
t("a date-TBD game gets no expiry", tbd.polls.find(x => x.id === tbd.created).endsAt === null);
t("a date-TBD game is never swept", await onBoard(tbd.created));
await call(`/polls/${tbd.created}`, { method: "DELETE", key: "hunter2" });
await call(`/polls/${fresh}`, { method: "DELETE", key: "hunter2" });

// A game far enough out that the sweep must not touch it.
const [, soon] = await j(await call("/polls", { method: "POST",
  body: { title: "Next week", cap: 6, date: day(7), time: "19:00", hostPasscode: HOST } }));
t("an upcoming game is left alone", await onBoard(soon.created));
await call(`/polls/${soon.created}`, { method: "DELETE", key: "hunter2" });


// --- matchups: who won ---
[s, st] = await j(await call("/polls", { method: "POST",
  body: { title: "Result night", cap: 12, hostPasscode: HOST } }));
const wid = st.created;
for (let i = 0; i < 12; i++)
  await call(`/polls/${wid}/rsvps`, { method: "POST",
    body: { name: `Won${i}`, skill: ["B","BI","I","UI","A"][i % 5] } });

// Two sides is one matchup; four sides is every pairing of the four.
[s, st] = await j(await call(`/polls/${wid}/rounds`, { method: "POST", host: HOST,
  body: { teamCount: 2, perTeam: 6 } }));
let wr = st.polls.find(x => x.id === wid).rounds[0];
t("two sides make one matchup", wr.matches.length === 1);
t("the matchup names both sides", wr.matches[0].sideA === 0 && wr.matches[0].sideB === 1);
t("a fresh matchup has no winner", wr.matches[0].winner === null);
t("team snapshots stay on the server", wr.matches[0].teamA === undefined);

await call(`/polls/${wid}/rounds`, { method: "DELETE", host: HOST });
[s, st] = await j(await call(`/polls/${wid}/rounds`, { method: "POST", host: HOST,
  body: { teamCount: 4, perTeam: 3 } }));
wr = st.polls.find(x => x.id === wid).rounds[0];
t("four sides make six matchups", wr.matches.length === 6);
t("every pairing appears exactly once",
  new Set(wr.matches.map(m => `${m.sideA}v${m.sideB}`)).size === 6);
t("pairings are stored low side first", wr.matches.every(m => m.sideA < m.sideB));

// Anyone can settle one nobody has recorded yet — the person walking off
// court is rarely the person holding the passcode.
const m0 = wr.matches[0];
[s, st] = await j(await call(`/polls/${wid}/matches/${m0.id}`,
  { method: "PUT", body: { winner: m0.sideB } }));
let mNow = () => st.polls.find(x => x.id === wid).rounds[0].matches.find(m => m.id === m0.id);
t("a stranger can record an undecided matchup", s === 200 && mNow().winner === m0.sideB);
t("who recorded it is noted",
  db.prepare("SELECT reported_by b FROM matches WHERE id=?").get(m0.id).b === "anyone");

// But not overwrite one that's already down.
[s] = await j(await call(`/polls/${wid}/matches/${m0.id}`,
  { method: "PUT", body: { winner: m0.sideA } }));
t("a stranger cannot overwrite a recorded result", s === 403);
[s] = await j(await call(`/polls/${wid}/matches/${m0.id}`,
  { method: "PUT", body: { winner: null } }));
t("a stranger cannot clear a result", s === 403);

[s, st] = await j(await call(`/polls/${wid}/matches/${m0.id}`,
  { method: "PUT", host: HOST, body: { winner: m0.sideA } }));
t("the game passcode overrides a recorded result", mNow().winner === m0.sideA);
t("the override is attributed to the host",
  db.prepare("SELECT reported_by b FROM matches WHERE id=?").get(m0.id).b === "host");

[s, st] = await j(await call(`/polls/${wid}/matches/${m0.id}`,
  { method: "PUT", key: "hunter2", body: { winner: null } }));
t("admin can clear a result", mNow().winner === null);
const cleared = db.prepare("SELECT reported_by b, decided_at d FROM matches WHERE id=?").get(m0.id);
t("a cleared result forgets who reported it and when",
  cleared.b === null && cleared.d === null);
t("a cleared matchup is open to anyone again",
  (await call(`/polls/${wid}/matches/${m0.id}`,
    { method: "PUT", body: { winner: m0.sideA } })).status === 200);

// A side that wasn't in this pairing can't have won it.
[s] = await j(await call(`/polls/${wid}/matches/${m0.id}`,
  { method: "PUT", host: HOST, body: { winner: 3 } }));
t("a side outside the pairing is rejected", s === 400);
[s] = await j(await call(`/polls/${wid}/matches/${m0.id}`,
  { method: "PUT", host: HOST, body: {} }));
t("a request with no winner field changes nothing", s === 400);
[s] = await j(await call(`/polls/${wid}/matches/nosuchmatch`,
  { method: "PUT", host: HOST, body: { winner: 0 } }));
t("an unknown matchup 404s", s === 404);

// Undoing a round says it didn't happen, so its results don't either.
const wrid = wr.id;
await call(`/polls/${wid}/rounds/${wrid}`, { method: "DELETE", host: HOST });
t("undoing a round takes its matchups with it",
  db.prepare("SELECT COUNT(*) c FROM matches WHERE round_id=?").get(wrid).c === 0);

// Clearing the session does too, decided or not.
[s, st] = await j(await call(`/polls/${wid}/rounds`, { method: "POST", host: HOST,
  body: { teamCount: 2, perTeam: 6 } }));
let cm = st.polls.find(x => x.id === wid).rounds[0].matches[0];
await call(`/polls/${wid}/matches/${cm.id}`, { method: "PUT", body: { winner: cm.sideA } });
await call(`/polls/${wid}/rounds`, { method: "DELETE", host: HOST });
t("clearing the session drops even decided matchups",
  db.prepare("SELECT COUNT(*) c FROM matches WHERE poll_id=?").get(wid).c === 0);

// A played night has to leave something behind, so the sweep spares results.
[s, st] = await j(await call(`/polls/${wid}/rounds`, { method: "POST", host: HOST,
  body: { teamCount: 4, perTeam: 3 } }));
const sm = st.polls.find(x => x.id === wid).rounds[0].matches;
await call(`/polls/${wid}/matches/${sm[0].id}`, { method: "PUT", body: { winner: sm[0].sideA } });
db.prepare("UPDATE polls SET ends_at=? WHERE id=?").run(Date.now() - 2 * 3600000, wid);
[s, st] = await j(await call("/state"));
t("the played game is swept off the board", !st.polls.some(x => x.id === wid));
t("its recorded result survives the sweep",
  db.prepare("SELECT COUNT(*) c FROM matches WHERE poll_id=?").get(wid).c === 1);
t("the matchups nobody played are swept",
  db.prepare("SELECT COUNT(*) c FROM matches WHERE poll_id=? AND winner IS NULL").get(wid).c === 0);
t("a surviving result keeps its team snapshot",
  JSON.parse(db.prepare("SELECT team_a a FROM matches WHERE poll_id=?").get(wid).a).length === 3);
t("a surviving result is not served to the board once its game is gone",
  !st.polls.some(x => x.rounds.some(r => r.matches.some(m => m.id === sm[0].id))));


// --- closing ---
[s, st] = await j(await call(`/polls/${id}`, { method: "PATCH", host: HOST, body: { closed: true } }));
t("game closed", st.polls.find(x => x.id === id).closed === true);
[s] = await j(await call(`/polls/${id}/rsvps`, { method: "POST", body: { name: "Hal", skill: "B" } }));
t("closed game refuses new RSVPs", s === 400);

// --- delete cascades ---
[s, st] = await j(await call(`/polls/${id}`, { method: "DELETE", host: HOST }));
t("game deleted", st.polls.length === 0);
t("its RSVPs went with it", db.prepare("SELECT COUNT(*) c FROM rsvps").get().c === 0);
t("its rounds went with it", db.prepare("SELECT COUNT(*) c FROM rounds").get().c === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
