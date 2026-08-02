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

const call = (path, { method = "GET", body, key } = {}) =>
  worker.fetch(new Request(`https://x/api${path}`, {
    method,
    headers: { "content-type": "application/json", ...(key ? { "x-siab-key": key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env);

const j = async (r) => [r.status, await r.json()];

// --- auth ---
let [s] = await j(await call("/polls", { method: "POST", body: { title: "X", cap: 4 } }));
t("create without passcode is rejected", s === 401);
[s] = await j(await call("/admin/verify", { method: "POST", body: { passcode: "wrong" } }));
t("wrong passcode rejected", s === 401);
[s] = await j(await call("/admin/verify", { method: "POST", body: { passcode: "hunter2" } }));
t("right passcode accepted", s === 200);

// --- validation ---
[s] = await j(await call("/polls", { method: "POST", key: "hunter2", body: { title: "a", cap: 4 } }));
t("title too short rejected", s === 400);
[s] = await j(await call("/polls", { method: "POST", key: "hunter2", body: { title: "Ok", cap: 999 } }));
t("absurd cap rejected", s === 400);

// --- create a 4-cap game ---
let st;
[s, st] = await j(await call("/polls", { method: "POST", key: "hunter2",
  body: { title: "Thursday 6s", cap: 4, date: "2026-08-06", time: "19:00", location: "Gym" } }));
t("game created", s === 200 && st.polls.length === 1);
const id = st.polls[0].id;

// --- fill past capacity ---
for (const [n, sk] of [["Ana","A"],["Bea","I"],["Cy","B"],["Dov","I"],["Eve","A"],["Fay","B"]]) {
  [s, st] = await j(await call(`/polls/${id}/rsvps`, { method: "POST", body: { name: n, skill: sk } }));
}
let p = st.polls[0];
t("six RSVPs stored in order", p.rsvps.map(r=>r.name).join(",") === "Ana,Bea,Cy,Dov,Eve,Fay");
t("active roster capped at 4", p.rsvps.slice(0,p.cap).map(r=>r.name).join(",") === "Ana,Bea,Cy,Dov");
t("overflow lands on waitlist", p.rsvps.slice(p.cap).map(r=>r.name).join(",") === "Eve,Fay");

// --- duplicate name ---
[s] = await j(await call(`/polls/${id}/rsvps`, { method: "POST", body: { name: "ana", skill: "B" } }));
t("duplicate name (case-insensitive) blocked", s === 409);

// --- bad skill ---
[s] = await j(await call(`/polls/${id}/rsvps`, { method: "POST", body: { name: "Zed", skill: "Z" } }));
t("invalid skill rejected", s === 400);

// --- cancellation promotes waitlist head ---
[s, st] = await j(await call(`/polls/${id}/rsvps`, { method: "DELETE", body: { name: "Bea" } }));
p = st.polls[0];
t("Eve promoted into active roster", p.rsvps.slice(0,p.cap).map(r=>r.name).join(",") === "Ana,Cy,Dov,Eve");
t("Fay still waiting", p.rsvps.slice(p.cap).map(r=>r.name).join(",") === "Fay");

[s] = await j(await call(`/polls/${id}/rsvps`, { method: "DELETE", body: { name: "Ghost" } }));
t("cancelling unknown name 404s", s === 404);


// --- signup order survives same-millisecond submissions ---
[s, st] = await j(await call("/polls", { method: "POST", key: "hunter2",
  body: { title: "Race test", cap: 2 } }));
const rid = st.polls.find(x => x.title === "Race test").id;
for (const n of ["One","Two","Three","Four","Five"]) {
  [s, st] = await j(await call(`/polls/${rid}/rsvps`, { method: "POST", body: { name: n, skill: "I" } }));
}
const race = st.polls.find(x => x.id === rid);
t("burst signups keep arrival order", race.rsvps.map(r=>r.name).join(",") === "One,Two,Three,Four,Five");
t("burst waitlist order is first-come", race.rsvps.slice(2).map(r=>r.name).join(",") === "Three,Four,Five");
await call(`/polls/${rid}`, { method: "DELETE", key: "hunter2" });

// --- rounds ---
[s, st] = await j(await call(`/polls/${id}/rounds`, { method: "POST", key: "hunter2", body: { teamCount: 2 } }));
p = st.polls[0];
t("round 1 created", p.rounds.length === 1);
t("round drawn from active roster only", p.rounds[0].teams.flat().length + p.rounds[0].bench.length === 4);
t("waitlisted player excluded from the round", 
  ![...p.rounds[0].teams.flat(), ...p.rounds[0].bench].some(x => x.name === "Fay"));

[s] = await j(await call(`/polls/${id}/rounds`, { method: "POST", body: { teamCount: 2 } }));
t("mixing requires passcode", s === 401);

[s, st] = await j(await call(`/polls/${id}/rounds`, { method: "POST", key: "hunter2", body: { teamCount: 2 } }));
p = st.polls[0];
t("round 2 appended, round 1 kept", p.rounds.length === 2);
t("rounds come back oldest-first", p.rounds[0].at <= p.rounds[1].at);

const sigOf = (r) => r.teams.map(x => x.map(y=>y.id).sort().join(",")).sort().join("|");
t("round 2 is a different lineup", sigOf(p.rounds[0]) !== sigOf(p.rounds[1]));

[s] = await j(await call(`/polls/${id}/rounds`, { method: "POST", key: "hunter2", body: { teamCount: 9 } }));
t("absurd team count rejected", s === 400);

// roster changes must NOT rewrite history
[s, st] = await j(await call(`/polls/${id}/rsvps`, { method: "POST", body: { name: "Gil", skill: "I" } }));
t("past rounds survive a roster change", st.polls[0].rounds.length === 2);

// undo one round
const r1id = st.polls[0].rounds[0].id;
[s, st] = await j(await call(`/polls/${id}/rounds/${r1id}`, { method: "DELETE", key: "hunter2" }));
t("single round undone", st.polls[0].rounds.length === 1);
[s] = await j(await call(`/polls/${id}/rounds/${r1id}`, { method: "DELETE", key: "hunter2" }));
t("undoing a gone round 404s", s === 404);

// clear session
[s] = await j(await call(`/polls/${id}/rounds`, { method: "DELETE" }));
t("clearing session requires passcode", s === 401);
[s, st] = await j(await call(`/polls/${id}/rounds`, { method: "DELETE", key: "hunter2" }));
t("session cleared", st.polls[0].rounds.length === 0);


// --- explicit side size over the API ---
[s, st] = await j(await call("/polls", { method: "POST", key: "hunter2",
  body: { title: "Four a side", cap: 12 } }));
const fid = st.polls.find(x => x.title === "Four a side").id;
for (let i = 0; i < 10; i++)
  await call(`/polls/${fid}/rsvps`, { method: "POST", body: { name: `Sub${i}`, skill: "AIB"[i%3] } });

[s, st] = await j(await call(`/polls/${fid}/rounds`, { method: "POST", key: "hunter2",
  body: { teamCount: 2, perTeam: 4 } }));
let fr = st.polls.find(x => x.id === fid).rounds[0];
t("4 v 4 requested and delivered", fr.teams.every(x => x.length === 4));
t("remaining players benched", fr.bench.length === 2);

[s] = await j(await call(`/polls/${fid}/rounds`, { method: "POST", key: "hunter2",
  body: { teamCount: 2, perTeam: 8 } }));
t("side size beyond the roster refused", s === 400);
[s] = await j(await call(`/polls/${fid}/rounds`, { method: "POST", key: "hunter2",
  body: { teamCount: 2, perTeam: 0 } }));
t("zero a side refused", s === 400);

[s, st] = await j(await call(`/polls/${fid}/rounds`, { method: "POST", key: "hunter2",
  body: { teamCount: 2 } }));
fr = st.polls.find(x => x.id === fid).rounds[1];
t("omitting side size fills the court", fr.teams.every(x => x.length === 5) && fr.bench.length === 0);
await call(`/polls/${fid}`, { method: "DELETE", key: "hunter2" });

// --- closing ---
[s, st] = await j(await call(`/polls/${id}`, { method: "PATCH", key: "hunter2", body: { closed: true } }));
t("game closed", st.polls[0].closed === true);
[s] = await j(await call(`/polls/${id}/rsvps`, { method: "POST", body: { name: "Hal", skill: "B" } }));
t("closed game refuses new RSVPs", s === 400);

// --- delete cascades ---
[s, st] = await j(await call(`/polls/${id}`, { method: "DELETE", key: "hunter2" }));
t("game deleted", st.polls.length === 0);
t("its RSVPs went with it", db.prepare("SELECT COUNT(*) c FROM rsvps").get().c === 0);
t("its rounds went with it", db.prepare("SELECT COUNT(*) c FROM rounds").get().c === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
