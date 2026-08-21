import { mixRound, benchHistory, pairHistory, WEIGHT } from "../worker/balance.js";

const C = (n, k) => (k > n ? 0 : k === 0 || k === n ? 1 : C(n - 1, k - 1) + C(n - 1, k));

const mk = (skills) => skills.map((s, i) => ({ id: `p${i}`, name: `Player${i}`, skill: s }));
// Five rungs, spread 1..5. "AIB" cycles appear below on purpose: they are
// the legacy three-level values, which must keep working untouched.
const LADDER = ["B", "BI", "I", "UI", "A"];
const rung = (i) => LADDER[i % 5];
const sig = (teams) =>
  teams.map((t) => t.map((p) => p.id).sort().join(",")).sort().join(" | ");

let pass = 0, fail = 0;
const t = (label, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? "  — " + detail : ""}`);
};

/* --- shape ---------------------------------------------------------- */
{
  const players = mk(["A","A","A","I","I","I","I","B","B","B","B","B"]);
  const r = mixRound(players, 2);
  t("12 players, 2 sides -> 6 a side", r.teams.every((x) => x.length === 6));
  t("nobody benched when it divides evenly", r.bench.length === 0);
  const ids = r.teams.flat().map((p) => p.id);
  t("everyone placed exactly once", ids.length === 12 && new Set(ids).size === 12);
  t("sides close on skill", r.gap <= 2, `gap=${r.gap}`);
}
{
  const players = mk(Array.from({ length: 13 }, (_, i) => "AIB"[i % 3]));
  const r = mixRound(players, 2);
  t("13 players -> equal sides, one benched",
    r.teams.every((x) => x.length === 6) && r.bench.length === 1);
  const all = [...r.teams.flat(), ...r.bench].map((p) => p.id);
  t("benched player still accounted for", new Set(all).size === 13);
}
{
  const r = mixRound(mk(Array.from({ length: 14 }, () => "I")), 3);
  t("14 players, 3 sides -> 4 a side, 2 benched",
    r.teams.every((x) => x.length === 4) && r.bench.length === 2);
}

/* --- variety: the whole point of re-mixing -------------------------- */
{
  const players = mk(["A","A","A","I","I","I","I","B","B","B","B","B"]);
  const seen = new Set(Array.from({ length: 8 }, () => sig(mixRound(players, 2).teams)));
  t("repeat mixes are not identical", seen.size > 1, `${seen.size} distinct of 8`);
}
{
  // Some repetition in round 2 is forced: two new sides of m drawn from two
  // old sides of m can do no better than 4*C(m/2,2) shared pairs. Hitting
  // that number exactly is the strongest claim available.
  for (const m of [4, 6]) {
    const players = mk(Array.from({ length: 2 * m }, (_, i) => "AIB"[i % 3]));
    const floor = 4 * C(m / 2, 2);
    let worst = 0, differed = 0;
    for (let i = 0; i < 30; i++) {
      const r1 = mixRound(players, 2);
      const r2 = mixRound(players, 2, null, [r1]);
      worst = Math.max(worst, r2.repeats);
      if (sig(r1.teams) !== sig(r2.teams)) differed++;
    }
    t(`round 2 hits the minimum possible overlap (${m} a side)`, worst === floor,
      `worst=${worst}, theoretical floor=${floor}`);
    t(`round 2 always reshuffles (${m} a side)`, differed === 30, `${differed}/30`);
  }
}
{
  // Over a session, how much of the group has each player actually played with?
  // A deterministic mixer would freeze at one round's worth of pairings forever.
  const players = mk(Array.from({ length: 12 }, (_, i) => rung(i)));
  const history = [];
  for (let i = 0; i < 4; i++) history.push(mixRound(players, 2, null, history));

  const distinct = pairHistory(history).size;
  const possible = C(12, 2);
  const frozen = 2 * C(6, 2); // what you'd get if teams never changed
  t("4 rounds cover most of the group", distinct >= possible * 0.85,
    `${distinct}/${possible} pairings, vs ${frozen} for a fixed lineup`);
  t("every round stayed balanced", history.every((r) => r.gap <= 4),
    history.map((r) => r.gap).join(","));
}

/* --- bench rotation ------------------------------------------------- */
{
  const players = mk(Array.from({ length: 13 }, (_, i) => "AIB"[i % 3]));
  const history = [];
  for (let i = 0; i < 13; i++) history.push(mixRound(players, 2, null, history));
  const counts = benchHistory(history);
  const per = players.map((p) => counts.get(p.id) || 0);
  t("bench time shared evenly over 13 rounds",
    Math.max(...per) - Math.min(...per) <= 1,
    `each sat out ${Math.min(...per)}-${Math.max(...per)} times`);
  t("nobody sat out twice in a row",
    history.every((r, i) =>
      i === 0 || !r.bench.some((b) => history[i - 1].bench.some((x) => x.id === b.id))));
}


/* --- explicit side size --------------------------------------------- */
{
  const players = mk(Array.from({ length: 12 }, (_, i) => "AIB"[i % 3]));

  const r = mixRound(players, 2, 4);
  t("12 players at 4 v 4 -> two sides of 4",
    r.teams.length === 2 && r.teams.every((x) => x.length === 4));
  t("the other 4 wait their turn", r.bench.length === 4);
  t("still balanced at 4 v 4", r.gap <= 4, `gap=${r.gap}`);
  t("reports the side size back", r.perTeam === 4);

  const small = mixRound(players, 2, 2);
  t("2 v 2 leaves 8 on the bench",
    small.teams.every((x) => x.length === 2) && small.bench.length === 8);

  const auto = mixRound(players, 2);
  t("omitting side size fills the court", auto.teams.every((x) => x.length === 6));

  let threw = false;
  try { mixRound(players, 2, 7); } catch { threw = true; }
  t("asking for more players than exist is refused", threw);
}

{
  // The case that matters: a third of the roster sits every round, so
  // rotation has to be fair or the same people never play.
  const players = mk(Array.from({ length: 12 }, (_, i) => "AIB"[i % 3]));
  const history = [];
  for (let i = 0; i < 6; i++) history.push(mixRound(players, 2, 4, history));

  const counts = benchHistory(history);
  const per = players.map((p) => counts.get(p.id) || 0);
  t("4 v 4 with 12 players shares bench time evenly over 6 rounds",
    Math.max(...per) - Math.min(...per) <= 1,
    `each sat out ${Math.min(...per)}-${Math.max(...per)} of 6 rounds`);
  t("every round fielded a full 4 v 4",
    history.every((r) => r.teams.every((x) => x.length === 4) && r.bench.length === 4));
  t("sides stayed balanced across the session",
    history.every((r) => r.gap <= 4), history.map((r) => r.gap).join(","));
}

/* --- five levels ---------------------------------------------------- */
{
  // The reason for the change: with three levels people bunched in the
  // middle, so half a roster of Intermediates is the realistic case.
  const players = mk(["A","UI","UI","I","I","I","I","I","BI","BI","B","B"]);
  const r = mixRound(players, 2);
  t("five-level roster splits evenly", r.teams.every((x) => x.length === 6));
  t("five-level sides come out close", r.gap <= 2, `gap=${r.gap}`);

  // Strictly increasing, or "upper-intermediate" carries no information.
  const ws = LADDER.map((k) => WEIGHT[k]);
  t("the five rungs are a strict ladder",
    ws.length === 5 && ws.every((v, i) => i === 0 || v > ws[i - 1]), ws.join(" < "));
  t("no rung falls back to the unknown-skill default",
    LADDER.every((k) => WEIGHT[k] !== undefined));

  // The mixer must see the two new rungs, not silently weight them as 1.
  // Four Upper-intermediates against four Beginner-intermediates is a real
  // 8-point spread; splitting them 2-and-2 is the only even answer.
  const mixed = mixRound(mk(["UI","UI","UI","UI","BI","BI","BI","BI"]), 2);
  t("the new rungs carry their own weight",
    mixed.gap === 0 && mixed.teams.every((tm) =>
      tm.filter((x) => x.skill === "UI").length === 2), `gap=${mixed.gap}`);
}

{
  // Legacy rows: an RSVP stored as B/I/A under the old scale still mixes.
  const players = mk(Array.from({ length: 12 }, (_, i) => "AIB"[i % 3]));
  const r = mixRound(players, 2);
  const ids = r.teams.flat().map((p) => p.id);
  t("three-level values still mix", ids.length === 12 && new Set(ids).size === 12);
  t("three-level values still balance", r.gap <= 2, `gap=${r.gap}`);
}

/* --- integrity ------------------------------------------------------ */
{
  let bad = 0, checked = 0;
  for (let i = 0; i < 200; i++) {
    const size = 4 + Math.floor(Math.random() * 12);
    const n = 2 + Math.floor(Math.random() * 3);
    if (Math.floor(size / n) < 1) continue;
    checked++;
    const players = mk(Array.from({ length: size }, () => LADDER[Math.floor(Math.random() * 5)]));
    const maxSide = Math.floor(size / n);
    const side = 1 + Math.floor(Math.random() * maxSide);
    const r = mixRound(players, n, side);
    if (r.teams.some((x) => x.length !== side)) { bad++; continue; }
    const ids = [...r.teams.flat(), ...r.bench].map((p) => p.id);
    const sizes = r.teams.map((x) => x.length);
    if (new Set(ids).size !== size || ids.length !== size ||
        new Set(sizes).size !== 1 || r.gap > 6) bad++;
  }
  t("random rosters and side sizes: nobody lost or cloned, gap <= 6", bad === 0,
    `${checked} checked, ${bad} bad`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
