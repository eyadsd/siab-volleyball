/**
 * Round mixer.
 *
 * Three things matter when you re-mix mid-session, and they pull against
 * each other:
 *
 *   1. Sides stay even on skill.
 *   2. You play with people you haven't played with yet. A deterministic
 *      balancer hands you the same teams every round, which defeats the
 *      point of re-mixing at all.
 *   3. Whoever sat out last round gets to play this one. With 12 players
 *      at 4 v 4, eight are on court and four are waiting, so rotation is
 *      the difference between a good session and four people standing
 *      around all night.
 *
 * Teams are always equal size — leftovers go to the bench rather than
 * making one side play a player up, because 6v6 with a sub is volleyball
 * and 7v6 isn't.
 */

export const WEIGHT = { B: 1, I: 2, A: 3 };
const w = (p) => WEIGHT[p.skill] ?? 1;

/** How much one point of skill imbalance is worth in repeat-pairings. */
const GAP_WEIGHT = 10;
/** Random restarts. Cheap — rosters are tiny — and it's what buys variety. */
const ATTEMPTS = 60;

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Counts from previous rounds: how often each pair shared a side. */
export function pairHistory(rounds) {
  const pairs = new Map();
  for (const r of rounds) {
    for (const team of r.teams) {
      for (let i = 0; i < team.length; i++) {
        for (let j = i + 1; j < team.length; j++) {
          const k = pairKey(team[i].id, team[j].id);
          pairs.set(k, (pairs.get(k) || 0) + 1);
        }
      }
    }
  }
  return pairs;
}

/** How many rounds each player has sat out. */
export function benchHistory(rounds) {
  const counts = new Map();
  for (const r of rounds) {
    for (const p of r.bench || []) counts.set(p.id, (counts.get(p.id) || 0) + 1);
  }
  return counts;
}

const totals = (teams) => teams.map((t) => t.reduce((s, p) => s + w(p), 0));
const skillGap = (teams) => {
  const t = totals(teams);
  return Math.max(...t) - Math.min(...t);
};

/** Same-side pairs that have already happened, weighted by how often. */
export function repeatCount(teams, pairs) {
  let n = 0;
  for (const team of teams) {
    for (let i = 0; i < team.length; i++) {
      for (let j = i + 1; j < team.length; j++) {
        n += pairs.get(pairKey(team[i].id, team[j].id)) || 0;
      }
    }
  }
  return n;
}

const cost = (teams, pairs) => skillGap(teams) * GAP_WEIGHT + repeatCount(teams, pairs);

/** Snake draft, with ties inside a skill tier broken randomly. */
function draft(players, n) {
  const pool = shuffle(players).sort((a, b) => w(b) - w(a));
  const teams = Array.from({ length: n }, () => []);
  pool.forEach((p, i) => {
    const round = Math.floor(i / n);
    const slot = i % n;
    teams[round % 2 === 0 ? slot : n - 1 - slot].push(p);
  });
  return teams;
}

/** 1-for-1 trades while they lower the cost. Team sizes can't drift. */
function improve(start, pairs) {
  let teams = start;
  const n = teams.length;
  for (let pass = 0; pass < 100; pass++) {
    const cur = cost(teams, pairs);
    let best = null;
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        for (const pa of teams[a]) {
          for (const pb of teams[b]) {
            const trial = teams.map((t) => [...t]);
            trial[a] = trial[a].map((p) => (p.id === pa.id ? pb : p));
            trial[b] = trial[b].map((p) => (p.id === pb.id ? pa : p));
            const c = cost(trial, pairs);
            if (c < cur && (!best || c < best.c)) best = { c, trial };
          }
        }
      }
    }
    if (!best) break;
    teams = best.trial;
  }
  return teams;
}

/**
 * Build one round.
 *
 * @param players   active roster, in signup order
 * @param teamCount how many sides
 * @param perTeam   players a side. Omit to fit as many on court as possible.
 * @param rounds    previous rounds: [{ teams: [[player]], bench: [player] }]
 * @returns { teams, bench, gap, repeats, freshPairs }
 */
export function mixRound(players, teamCount, perTeam = null, rounds = []) {
  const maxSide = Math.floor(players.length / teamCount);
  const size = perTeam == null ? maxSide : perTeam;

  if (size < 1) throw new Error("Not enough players for that many sides.");
  if (size > maxSide)
    throw new Error(`${teamCount} sides of ${size} needs ${teamCount * size} players.`);

  const playCount = size * teamCount;
  const benched = benchHistory(rounds);
  const pairs = pairHistory(rounds);

  // Whoever has sat out most goes back on first; random within a tie.
  const queue = shuffle(players).sort(
    (a, b) => (benched.get(b.id) || 0) - (benched.get(a.id) || 0)
  );
  const playing = queue.slice(0, playCount);
  const bench = queue.slice(playCount);

  let best = null;
  for (let i = 0; i < ATTEMPTS; i++) {
    const teams = improve(draft(playing, teamCount), pairs);
    const c = cost(teams, pairs);
    if (!best || c < best.c) best = { c, teams };
  }

  const teams = best.teams.map((t) =>
    [...t].sort((a, b) => w(b) - w(a) || a.name.localeCompare(b.name))
  );

  const repeats = repeatCount(teams, pairs);
  const totalPairs = teamCount * ((size * (size - 1)) / 2);

  return {
    perTeam: size,
    teams,
    bench: [...bench].sort((a, b) => a.name.localeCompare(b.name)),
    gap: skillGap(teams),
    repeats,
    freshPairs: totalPairs - repeats,
  };
}
