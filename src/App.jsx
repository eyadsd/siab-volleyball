import React, { useState, useEffect, useMemo } from "react";
import { api, getKey, setKey, clearKey } from "./api.js";

const SKILLS = [
  { id: "A", label: "Advanced", w: 3 },
  { id: "I", label: "Intermediate", w: 2 },
  { id: "B", label: "Beginner", w: 1 },
];
const skillOf = (id) => SKILLS.find((s) => s.id === id) || SKILLS[2];
const norm = (s) => s.trim().replace(/\s+/g, " ");
const initials = (n) =>
  norm(n).split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase();

function fmtDate(d, t) {
  if (!d) return "Date TBD";
  const dt = new Date(`${d}T${t || "00:00"}`);
  if (isNaN(dt)) return d;
  const day = dt.toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
  });
  return t ? `${day} · ${t}` : day;
}

/* ------------------------------------------------------------------ */

function Slot({ p, i }) {
  if (!p)
    return (
      <div className="slot open">
        <span className="mono">{String(i + 1).padStart(2, "0")}</span>
      </div>
    );
  return (
    <div className="slot">
      <span className={`pip ${p.skill}`}>{initials(p.name)}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="pname">{p.name}</div>
        <div className="psk">{skillOf(p.skill).label.slice(0, 3)}</div>
      </div>
    </div>
  );
}

function RsvpForm({ onJoin, busy }) {
  const [name, setName] = useState("");
  const [skill, setSkill] = useState("I");
  const [err, setErr] = useState("");

  const submit = async () => {
    if (norm(name).length < 2) return setErr("Enter the name your teammates know you by.");
    setErr("");
    const msg = await onJoin(norm(name), skill);
    if (msg) setErr(msg);
    else setName("");
  };

  return (
    <div className="sec">
      <h3>Claim a spot</h3>
      <div className="grid2" style={{ marginTop: 10 }}>
        <div>
          <label htmlFor="nm">Your name</label>
          <input id="nm" value={name} placeholder="Ana K." disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()} />
        </div>
        <div>
          <label htmlFor="sk">How you play</label>
          <select id="sk" value={skill} disabled={busy}
            onChange={(e) => setSkill(e.target.value)}>
            {SKILLS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <button className="go" onClick={submit} disabled={busy} style={{ width: "100%" }}>
            I'm in
          </button>
        </div>
      </div>
      {err && <div className="err">{err}</div>}
    </div>
  );
}


/** "4 v 4" for two sides, "3 x 4" when there are more. */
const fmtFormat = (r) => {
  const size = r.teams[0]?.length ?? 0;
  return r.teams.length === 2 ? `${size} v ${size}` : `${r.teams.length} × ${size}`;
};

const fmtClock = (ms) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function Sides({ teams }) {
  return (
    <div className="teams">
      {teams.map((t, i) => (
        <div className="team" key={i}>
          <div className="thead">
            <strong style={{ fontFamily: "Archivo", letterSpacing: ".08em" }}>
              SIDE {String.fromCharCode(65 + i)}
            </strong>
            <span className="mono psk">
              {t.reduce((s, p) => s + skillOf(p.skill).w, 0)} pts
            </span>
          </div>
          {t.map((p) => (
            <div className="trow" key={p.id}>
              <span className={`pip ${p.skill}`}>{initials(p.name)}</span>
              <span style={{ flex: 1 }}>{p.name}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function RoundStats({ round }) {
  return (
    <div className="rstats">
      <span>{round.freshPairs} new {round.freshPairs === 1 ? "pairing" : "pairings"}</span>
      {round.repeats > 0 && <span>{round.repeats} repeated</span>}
      <span>sides within {round.gap} pt</span>
    </div>
  );
}

function Bench({ bench }) {
  if (!bench.length) return null;
  return (
    <div className="bench">
      <span className="psk">Sitting out</span>
      {bench.map((p) => (
        <span className="benchp" key={p.id}>
          <span className={`pip ${p.skill}`}>{initials(p.name)}</span>
          {p.name}
        </span>
      ))}
    </div>
  );
}

function Round({ round, n, current, admin, act, pollId, busy }) {
  const head = (
    <div className="rhead">
      <span className="rnum mono">{String(n).padStart(2, "0")}</span>
      <strong style={{ fontFamily: "Archivo", letterSpacing: ".1em", fontSize: 14 }}>
        ROUND {n}
      </strong>
      <span className="psk">{fmtClock(round.at)}</span>
      <span className="fmt mono">{fmtFormat(round)}</span>
      {current && <span className="pill live" style={{ marginLeft: "auto" }}>On court</span>}
      {admin && (
        <button className="mini danger" disabled={busy}
          style={{ marginLeft: current ? 0 : "auto" }}
          onClick={() => act.undoRound(pollId, round.id)}>
          Undo
        </button>
      )}
    </div>
  );

  // The round being played stays open; finished ones fold away.
  if (current) {
    return (
      <div className="round current">
        {head}
        <Sides teams={round.teams} />
        <Bench bench={round.bench} />
        <RoundStats round={round} />
      </div>
    );
  }

  return (
    <details className="round">
      <summary>
        <span className="rnum mono">{String(n).padStart(2, "0")}</span>
        <span style={{ fontFamily: "Archivo", letterSpacing: ".1em", fontSize: 13 }}>
          ROUND {n}
        </span>
        <span className="psk">{fmtClock(round.at)}</span>
        <span className="fmt mono">{fmtFormat(round)}</span>
        <span className="psk rsum">
          {round.teams.map((t, i) => `${String.fromCharCode(65 + i)}: ${t.map((p) => p.name.split(" ")[0]).join(", ")}`).join("  ·  ")}
        </span>
      </summary>
      <div style={{ paddingTop: 12 }}>
        {admin && (
          <div className="bar" style={{ marginTop: 0, marginBottom: 12 }}>
            <button className="mini danger" disabled={busy}
              onClick={() => act.undoRound(pollId, round.id)}>Undo this round</button>
          </div>
        )}
        <Sides teams={round.teams} />
        <Bench bench={round.bench} />
        <RoundStats round={round} />
      </div>
    </details>
  );
}

function PollCard({ poll, admin, act, busy }) {
  const [mixCount, setMixCount] = useState(2);
  // null = fit as many on court as possible; clamped so a shrinking roster
  // can't leave a stale, impossible side size selected.
  const [sideSize, setSideSize] = useState(null);
  const [dropName, setDropName] = useState("");
  const [dropMsg, setDropMsg] = useState("");

  const rounds = poll.rounds || [];
  const active = poll.rsvps.slice(0, poll.cap);
  const waitlist = poll.rsvps.slice(poll.cap);
  const open = active.length < poll.cap;
  const slots = Array.from({ length: poll.cap }, (_, i) => active[i] || null);
  const maxSide = Math.max(1, Math.floor(active.length / mixCount));
  const perSide = Math.min(sideSize ?? maxSide, maxSide);
  const benchCount = active.length - perSide * mixCount;

  const drop = async () => {
    const msg = await act.leave(poll.id, dropName);
    setDropMsg(msg || "");
    if (!msg) setDropName("");
  };

  return (
    <div className={`card ${poll.closed ? "closed" : ""}`}>
      <div className="rowline">
        <div style={{ flex: 1, minWidth: 220 }}>
          <span className={`pill ${poll.closed ? "" : open ? "live" : "full"}`}>
            {poll.closed ? "Closed" : open ? `${poll.cap - active.length} spots open` : "Roster full"}
          </span>
          <h2 style={{ marginTop: 10 }}>{poll.title}</h2>
          <div className="meta">
            <span><b>{fmtDate(poll.date, poll.time)}</b></span>
            <span>{poll.location || "Location TBD"}</span>
          </div>
          {poll.notes && <div className="note">{poll.notes}</div>}
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="count">{active.length}<small>/{poll.cap}</small></div>
          {waitlist.length > 0 && (
            <div className="psk" style={{ marginTop: 6, color: "var(--flag)" }}>
              +{waitlist.length} waiting
            </div>
          )}
        </div>
      </div>

      <div className="sec net">
        <div className="slots">
          {slots.map((p, i) => <Slot key={p ? p.id : `o${i}`} p={p} i={i} />)}
        </div>
      </div>
      <div className="legend">
        <span><i className="dot" style={{ background: "var(--flag)" }} />Advanced</span>
        <span><i className="dot" style={{ background: "var(--sky)" }} />Intermediate</span>
        <span><i className="dot" style={{ background: "var(--ball)" }} />Beginner</span>
      </div>

      {waitlist.length > 0 && (
        <div className="wait">
          <h3>Waitlist — first in line moves up the moment a spot frees</h3>
          {waitlist.map((p, i) => (
            <div className="wrow" key={p.id}>
              <span className="wnum">{i + 1}</span>
              <span className={`pip ${p.skill}`}>{initials(p.name)}</span>
              <span style={{ flex: 1 }}>{p.name}</span>
              <span className="psk">{skillOf(p.skill).label}</span>
              {admin && (
                <button className="mini danger" disabled={busy}
                  onClick={() => act.remove(poll.id, p.id)}>Remove</button>
              )}
            </div>
          ))}
        </div>
      )}

      {!poll.closed && <RsvpForm busy={busy} onJoin={(n, s) => act.join(poll.id, n, s)} />}

      {poll.rsvps.length > 0 && !poll.closed && (
        <div className="sec">
          <h3>Can't make it?</h3>
          <div className="grid2" style={{ marginTop: 10 }}>
            <input value={dropName} disabled={busy}
              placeholder="Type your name to give up your spot"
              onChange={(e) => setDropName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && drop()} />
            <div>
              <button className="ghost" onClick={drop} disabled={busy}>Give up my spot</button>
            </div>
          </div>
          {dropMsg && <div className="err">{dropMsg}</div>}
        </div>
      )}

      {admin && (
        <div className="sec" style={{ borderTop: "1px solid var(--line)", paddingTop: 18 }}>
          <h3>Organizer controls</h3>

          {active.length >= 2 && (
            <div className="bar mixbar">
              <div>
                <label htmlFor={`tc${poll.id}`}>Sides</label>
                <select id={`tc${poll.id}`} value={mixCount}
                  onChange={(e) => setMixCount(Number(e.target.value))}>
                  {[2, 3, 4].map((n) => (
                    <option key={n} value={n} disabled={active.length < n}>{n}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`ps${poll.id}`}>Players a side</label>
                <select id={`ps${poll.id}`} value={perSide}
                  onChange={(e) => setSideSize(Number(e.target.value))}>
                  {Array.from({ length: maxSide }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
              <button className="go" disabled={busy}
                onClick={() => act.mixRound(poll.id, mixCount, perSide)}>
                {rounds.length ? `Mix round ${rounds.length + 1}` : "Mix round 1"}
              </button>
              {rounds.length > 0 && (
                <button className="ghost" disabled={busy}
                  onClick={() => act.clearRounds(poll.id, poll.title)}>
                  Clear session
                </button>
              )}
              <span className="mixnote">
                <strong>
                  {mixCount === 2 ? `${perSide} v ${perSide}` : `${mixCount} × ${perSide}`}
                </strong>
                {benchCount > 0
                  ? ` · ${benchCount} rotating through the bench`
                  : " · everyone on court"}
              </span>
            </div>
          )}

          <div className="bar">
            <button className="ghost" disabled={busy}
              onClick={() => act.setClosed(poll.id, !poll.closed)}>
              {poll.closed ? "Reopen voting" : "Close voting"}
            </button>
            <button className="danger" disabled={busy} onClick={() => act.del(poll.id, poll.title)}>
              Delete game
            </button>
          </div>

          {active.length > 0 && (
            <div className="sec">
              <h3>Active roster</h3>
              {active.map((p) => (
                <div className="wrow" key={p.id}>
                  <span className={`pip ${p.skill}`}>{initials(p.name)}</span>
                  <span style={{ flex: 1 }}>{p.name}</span>
                  <span className="psk">{skillOf(p.skill).label}</span>
                  <button className="mini danger" disabled={busy}
                    onClick={() => act.remove(poll.id, p.id)}>Remove</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {rounds.length > 0 && (
        <div className="sec">
          <h3>Session · {rounds.length} {rounds.length === 1 ? "round" : "rounds"} played</h3>
          <div className="rounds">
            {[...rounds].reverse().map((r, i) => (
              <Round key={r.id} round={r} n={rounds.length - i} current={i === 0}
                admin={admin} act={act} pollId={poll.id} busy={busy} />
            ))}
          </div>
          <div className="note">
            Beginner 1 · Intermediate 2 · Advanced 3. Each mix keeps the sides even on
            points while pairing you with people you haven't played alongside yet.
          </div>
        </div>
      )}
    </div>
  );
}

function NewGame({ act, busy, onExit }) {
  const [f, setF] = useState({
    title: "", date: "", time: "19:00", location: "", cap: 12, notes: "",
  });
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const create = async () => {
    const msg = await act.create({ ...f, title: norm(f.title), cap: Number(f.cap) });
    if (msg) return setErr(msg);
    setErr("");
    setF({ ...f, title: "", location: "", notes: "" });
  };

  return (
    <div className="card">
      <div className="rowline">
        <h2>New game</h2>
        <button className="ghost mini" onClick={onExit}>Sign out</button>
      </div>
      <div className="grid2" style={{ marginTop: 16 }}>
        <div style={{ gridColumn: "1 / -1" }}>
          <label htmlFor="t">Game name</label>
          <input id="t" value={f.title} onChange={set("title")} placeholder="Thursday indoor 6s" />
        </div>
        <div>
          <label htmlFor="d">Date</label>
          <input id="d" type="date" value={f.date} onChange={set("date")} />
        </div>
        <div>
          <label htmlFor="ti">Start time</label>
          <input id="ti" type="time" value={f.time} onChange={set("time")} />
        </div>
        <div>
          <label htmlFor="l">Where</label>
          <input id="l" value={f.location} onChange={set("location")} placeholder="Gellért courts" />
        </div>
        <div>
          <label htmlFor="c">Player cap</label>
          <input id="c" type="number" min="2" max="60" value={f.cap} onChange={set("cap")} />
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <label htmlFor="n">Anything players should know</label>
          <input id="n" value={f.notes} onChange={set("notes")}
            placeholder="Bring 400 HUF for court fee" />
        </div>
      </div>
      {err && <div className="err">{err}</div>}
      <div className="bar">
        <button className="go" onClick={create} disabled={busy}>Post game</button>
      </div>
    </div>
  );
}

function SignIn({ onDone, onClose }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true);
    try {
      setKey(pw);
      await api.verify(pw);
      onDone();
    } catch (e) {
      clearKey();
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="rowline">
        <h2>Organizer sign in</h2>
        <button className="ghost mini" onClick={onClose}>Back</button>
      </div>
      <div className="note">
        The passcode lives on the server, not in this page. It unlocks posting games,
        editing rosters, and the team mixer.
      </div>
      <div className="grid2" style={{ marginTop: 14 }}>
        <div>
          <label htmlFor="p1">Passcode</label>
          <input id="p1" type="password" value={pw} autoComplete="current-password"
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && go()} />
        </div>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <button className="go" onClick={go} disabled={busy} style={{ width: "100%" }}>
            {busy ? "Checking…" : "Sign in"}
          </button>
        </div>
      </div>
      {err && <div className="err">{err}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function App() {
  const [state, setState] = useState(null);
  const [admin, setAdmin] = useState(false);
  const [gate, setGate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState("");

  const load = async () => {
    try {
      setState(await api.state());
      setFatal("");
    } catch (e) {
      setFatal("Can't reach the board right now. Check your connection and refresh.");
    }
  };

  useEffect(() => {
    load();
    if (getKey()) api.verify(getKey()).then(() => setAdmin(true)).catch(() => clearKey());
    // Someone else's RSVP should show up without a manual refresh.
    const t = setInterval(load, 20000);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, []);

  /** Runs a call, folds the returned state in, and hands back an error string. */
  const run = async (fn) => {
    setBusy(true);
    try {
      setState(await fn());
      return null;
    } catch (e) {
      return e.message;
    } finally {
      setBusy(false);
    }
  };

  const act = useMemo(() => ({
    create: (poll) => run(() => api.createPoll(poll)),
    join: (id, name, skill) => run(() => api.join(id, name, skill)),
    leave: (id, name) => run(() => api.leave(id, norm(name))),
    remove: (id, rsvpId) => run(() => api.remove(id, rsvpId)),
    setClosed: (id, closed) => run(() => api.setClosed(id, closed)),
    mixRound: (id, n, perTeam) => run(() => api.mixRound(id, n, perTeam)),
    undoRound: (id, roundId) => run(() => api.undoRound(id, roundId)),
    clearRounds: (id, title) => {
      if (!window.confirm(`Clear every round played for "${title}"? The next mix starts from scratch.`)) return;
      return run(() => api.clearRounds(id));
    },
    del: (id, title) => {
      if (!window.confirm(`Delete "${title}" and every RSVP on it? This can't be undone.`)) return;
      return run(() => api.deletePoll(id));
    },
  }), []);

  const signOut = () => { clearKey(); setAdmin(false); };

  if (!state)
    return (
      <div className="wrap">
        <div className="empty" style={{ marginTop: 80 }}>
          {fatal || "Loading the board…"}
        </div>
      </div>
    );

  return (
    <div className="wrap">
      <header className="top">
        <div className="mark">
          <div className="antenna" />
          <div>
            <h1>SIAB</h1>
            <div className="tag">Volleyball · rosters &amp; waitlists</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 9 }}>
          <button className="ghost mini" onClick={load} disabled={busy}>
            {busy ? "Syncing…" : "Refresh"}
          </button>
          {admin ? (
            <button className="mini" onClick={signOut}>Sign out</button>
          ) : (
            <button className="mini" onClick={() => setGate(true)}>Organizer</button>
          )}
        </div>
      </header>

      {fatal && <div className="err">{fatal}</div>}

      {gate && !admin && (
        <SignIn onDone={() => { setAdmin(true); setGate(false); }} onClose={() => setGate(false)} />
      )}

      {admin && <NewGame act={act} busy={busy} onExit={signOut} />}

      {state.polls.length === 0 ? (
        <div className="empty">
          <h2 style={{ marginBottom: 10 }}>No games on the board</h2>
          The organizer posts a game here — then you grab a spot before it fills.
        </div>
      ) : (
        state.polls.map((p) => (
          <PollCard key={p.id} poll={p} admin={admin} act={act} busy={busy} />
        ))
      )}

      <div className="note" style={{ marginTop: 30 }}>
        The board refreshes itself every 20 seconds, so rosters stay current without reloading.
      </div>
    </div>
  );
}
