import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  api, getKey, setKey, clearKey,
  hostKeys, getHostKey, setHostKey, clearHostKey, pruneHostKeys,
} from "./api.js";

/**
 * Five rungs, not three. With Beginner / Intermediate / Advanced almost
 * everyone picked the middle one — nobody volunteers to be the worst
 * player in the gym, and nobody wants to over-claim either. The two
 * halfway steps give people an answer they'll actually pick, which is
 * what the balancer needs to work with.
 */
const SKILLS = [
  { id: "A",  label: "Advanced",              short: "ADV",  w: 5 },
  { id: "UI", label: "Upper-intermediate",    short: "UP-I", w: 4 },
  { id: "I",  label: "Intermediate",          short: "INT",  w: 3 },
  { id: "BI", label: "Beginner-intermediate", short: "B-I",  w: 2 },
  { id: "B",  label: "Beginner",              short: "BEG",  w: 1 },
];
const LADDER = [...SKILLS].reverse();
const UNKNOWN = { id: "B", label: "Beginner", short: "BEG", w: 1 };
const skillOf = (id) => SKILLS.find((s) => s.id === id) || UNKNOWN;

const DURATIONS = [
  { min: 60, label: "1 hour" },
  { min: 90, label: "1½ hours" },
  { min: 120, label: "2 hours" },
  { min: 150, label: "2½ hours" },
  { min: 180, label: "3 hours" },
  { min: 240, label: "4 hours" },
];

const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ");
const initials = (n) =>
  norm(n).split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase();

const hm = (d) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** "Thu, Aug 6 · 19:00–21:00" — the end matters now that games expire. */
function fmtWhen(poll) {
  if (!poll.date) return "Date TBD";
  const start = new Date(`${poll.date}T${poll.time || "00:00"}`);
  if (isNaN(start)) return poll.date;
  const day = start.toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
  });
  if (!poll.time) return day;
  const end = new Date(start.getTime() + (poll.durationMin || 120) * 60000);
  return `${day} · ${hm(start)}–${hm(end)}`;
}

const fmtClock = (ms) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

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
        <div className="psk">{skillOf(p.skill).short}</div>
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

function Round({ round, n, current, manage, act, pollId, busy }) {
  const head = (
    <div className="rhead">
      <span className="rnum mono">{String(n).padStart(2, "0")}</span>
      <strong style={{ fontFamily: "Archivo", letterSpacing: ".1em", fontSize: 14 }}>
        ROUND {n}
      </strong>
      <span className="psk">{fmtClock(round.at)}</span>
      <span className="fmt mono">{fmtFormat(round)}</span>
      {current && <span className="pill live" style={{ marginLeft: "auto" }}>On court</span>}
      {manage && (
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
        {manage && (
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

/** The fields of a posted game, changeable after the fact. */
function EditGame({ poll, act, busy }) {
  const seed = () => ({
    title: poll.title || "",
    date: poll.date || "",
    time: poll.time || "",
    durationMin: poll.durationMin || 120,
    location: poll.location || "",
    notes: poll.notes || "",
    cap: poll.cap,
  });
  const [f, setF] = useState(seed);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);
  const set = (k) => (e) => { setSaved(false); setF({ ...f, [k]: e.target.value }); };

  const save = async () => {
    const msg = await act.update(poll.id, {
      title: norm(f.title),
      date: f.date,
      time: f.time,
      durationMin: Number(f.durationMin),
      location: f.location,
      notes: f.notes,
      cap: Number(f.cap),
    });
    setErr(msg || "");
    setSaved(!msg);
  };

  return (
    <details className="edit">
      <summary>Edit game details</summary>
      <div className="grid2" style={{ marginTop: 14 }}>
        <div style={{ gridColumn: "1 / -1" }}>
          <label htmlFor={`et${poll.id}`}>Game name</label>
          <input id={`et${poll.id}`} value={f.title} onChange={set("title")} />
        </div>
        <div>
          <label htmlFor={`ed${poll.id}`}>Date</label>
          <input id={`ed${poll.id}`} type="date" value={f.date} onChange={set("date")} />
        </div>
        <div>
          <label htmlFor={`ei${poll.id}`}>Start time</label>
          <input id={`ei${poll.id}`} type="time" value={f.time} onChange={set("time")} />
        </div>
        <div>
          <label htmlFor={`eu${poll.id}`}>How long</label>
          <select id={`eu${poll.id}`} value={f.durationMin} onChange={set("durationMin")}>
            {DURATIONS.map((d) => <option key={d.min} value={d.min}>{d.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`el${poll.id}`}>Where</label>
          <input id={`el${poll.id}`} value={f.location} onChange={set("location")} />
        </div>
        <div>
          <label htmlFor={`ec${poll.id}`}>Player cap</label>
          <input id={`ec${poll.id}`} type="number" min="2" max="60"
            value={f.cap} onChange={set("cap")} />
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <label htmlFor={`en${poll.id}`}>Description</label>
          <input id={`en${poll.id}`} value={f.notes} onChange={set("notes")}
            placeholder="Bring 400 HUF for court fee" />
        </div>
      </div>
      {err && <div className="err">{err}</div>}
      <div className="bar">
        <button className="go" onClick={save} disabled={busy}>Save changes</button>
        <button className="ghost" onClick={() => { setF(seed()); setErr(""); setSaved(false); }}
          disabled={busy}>Reset</button>
        {saved && <span className="okmsg">Saved.</span>}
      </div>
      <div className="note">
        Changing the date, start time, or length also moves when the game clears
        itself off the board — an hour after it finishes.
      </div>
    </details>
  );
}

/** Anyone holding this game's passcode gets its controls. */
function Unlock({ poll, act, busy }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");

  if (!open)
    return (
      <div className="bar">
        <button className="ghost mini" onClick={() => setOpen(true)}>
          I'm running this game
        </button>
      </div>
    );

  const go = async () => {
    const msg = await act.unlock(poll.id, pw);
    if (msg) return setErr(msg);
    setPw("");
    setOpen(false);
  };

  return (
    <div className="sec">
      <h3>Game passcode</h3>
      <div className="grid2" style={{ marginTop: 10 }}>
        <div>
          <input type="password" value={pw} autoComplete="off" placeholder="Passcode"
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && go()} />
        </div>
        <div className="bar" style={{ marginTop: 0 }}>
          <button className="go" onClick={go} disabled={busy}>Unlock</button>
          <button className="ghost" onClick={() => { setOpen(false); setErr(""); }}>Cancel</button>
        </div>
      </div>
      {err && <div className="err">{err}</div>}
      <div className="note">
        Whoever posted this game set this passcode. It runs this game only.
      </div>
    </div>
  );
}

function PollCard({ poll, admin, hosting, act, busy }) {
  const [mixCount, setMixCount] = useState(2);
  // null = fit as many on court as possible; clamped so a shrinking roster
  // can't leave a stale, impossible side size selected.
  const [sideSize, setSideSize] = useState(null);
  const [dropName, setDropName] = useState("");
  const [dropMsg, setDropMsg] = useState("");

  const manage = admin || hosting;
  const rounds = poll.rounds || [];
  const active = poll.rsvps.slice(0, poll.cap);
  const waitlist = poll.rsvps.slice(poll.cap);
  const open = active.length < poll.cap;
  const slots = Array.from({ length: poll.cap }, (_, i) => active[i] || null);
  const maxSide = Math.max(1, Math.floor(active.length / mixCount));
  const perSide = Math.min(sideSize ?? maxSide, maxSide);
  const benchCount = active.length - perSide * mixCount;
  const finished = poll.endsAt != null && poll.endsAt < Date.now();

  const drop = async () => {
    const msg = await act.leave(poll.id, dropName);
    setDropMsg(msg || "");
    if (!msg) setDropName("");
  };

  return (
    <div className={`card ${poll.closed || finished ? "closed" : ""}`}>
      <div className="rowline">
        <div style={{ flex: 1, minWidth: 220 }}>
          <span className={`pill ${finished || poll.closed ? "" : open ? "live" : "full"}`}>
            {finished ? "Played" : poll.closed ? "Closed" : open
              ? `${poll.cap - active.length} spots open` : "Roster full"}
          </span>
          {hosting && !admin && <span className="pill host">Your game</span>}
          <h2 style={{ marginTop: 10 }}>{poll.title}</h2>
          <div className="meta">
            <span><b>{fmtWhen(poll)}</b></span>
            <span>{poll.location || "Location TBD"}</span>
          </div>
          {poll.notes && <div className="note">{poll.notes}</div>}
          {finished && (
            <div className="note">
              This one's over — it clears off the board an hour after it finished.
            </div>
          )}
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
        {LADDER.map((s) => (
          <span key={s.id}><i className={`dot ${s.id}`} />{s.label}</span>
        ))}
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
              {manage && (
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

      {!manage && poll.hasHost && <Unlock poll={poll} act={act} busy={busy} />}

      {manage && (
        <div className="sec" style={{ borderTop: "1px solid var(--line)", paddingTop: 18 }}>
          <h3>
            {admin && !hosting ? "Admin controls" : "Organizer controls"}
          </h3>

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

          <EditGame poll={poll} act={act} busy={busy} />

          <div className="bar">
            <button className="ghost" disabled={busy}
              onClick={() => act.setClosed(poll.id, !poll.closed)}>
              {poll.closed ? "Reopen voting" : "Close voting"}
            </button>
            <button className="danger" disabled={busy} onClick={() => act.del(poll.id, poll.title)}>
              Delete game
            </button>
            {hosting && (
              <button className="ghost" disabled={busy} onClick={() => act.lock(poll.id)}>
                Lock on this device
              </button>
            )}
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
                manage={manage} act={act} pollId={poll.id} busy={busy} />
            ))}
          </div>
          <div className="note">
            {LADDER.map((s) => `${s.label} ${s.w}`).join(" · ")}. Each mix keeps the sides
            even on points while pairing you with people you haven't played alongside yet.
          </div>
        </div>
      )}
    </div>
  );
}

/** Open to everyone — the passcode you set here is what runs your game. */
function NewGame({ act, busy, onExit }) {
  const [f, setF] = useState({
    title: "", date: "", time: "19:00", durationMin: 120,
    location: "", cap: 12, notes: "", hostPasscode: "",
  });
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const create = async () => {
    const msg = await act.create({
      ...f,
      title: norm(f.title),
      cap: Number(f.cap),
      durationMin: Number(f.durationMin),
    });
    if (msg) return setErr(msg);
    setErr("");
    setF({ ...f, title: "", location: "", notes: "", hostPasscode: "" });
    onExit();
  };

  return (
    <div className="card">
      <div className="rowline">
        <h2>Post a game</h2>
        <button className="ghost mini" onClick={onExit}>Cancel</button>
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
          <label htmlFor="du">How long</label>
          <select id="du" value={f.durationMin} onChange={set("durationMin")}>
            {DURATIONS.map((d) => <option key={d.min} value={d.min}>{d.label}</option>)}
          </select>
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
        <div style={{ gridColumn: "1 / -1" }}>
          <label htmlFor="hp">Your passcode for this game</label>
          <input id="hp" type="password" value={f.hostPasscode} autoComplete="new-password"
            onChange={set("hostPasscode")} placeholder="At least 4 characters" />
          <div className="note">
            This is what lets you edit the game and mix teams later, on any device.
            Pick something you'll remember and share it with anyone helping you run it.
          </div>
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
        <h2>Admin sign in</h2>
        <button className="ghost mini" onClick={onClose}>Back</button>
      </div>
      <div className="note">
        The admin passcode lives on the server, not in this page. It opens every game
        on the board, whoever posted it. To run a single game, use that game's own
        passcode instead.
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
  const [posting, setPosting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState("");
  // Which games this browser holds the host passcode for. Mirrors
  // localStorage so a change there re-renders the cards.
  const [hosted, setHosted] = useState(() => new Set(Object.keys(hostKeys())));

  const syncHosted = useCallback(() => setHosted(new Set(Object.keys(hostKeys()))), []);

  const absorb = useCallback((next) => {
    setState(next);
    // Games get swept an hour after they end; their keys can go too.
    pruneHostKeys(next.polls.map((p) => p.id));
    syncHosted();
    return next;
  }, [syncHosted]);

  const load = useCallback(async () => {
    try {
      absorb(await api.state());
      setFatal("");
    } catch (e) {
      setFatal("Can't reach the board right now. Check your connection and refresh.");
    }
  }, [absorb]);

  useEffect(() => {
    load();
    if (getKey()) api.verify(getKey()).then(() => setAdmin(true)).catch(() => clearKey());
    // Someone else's RSVP should show up without a manual refresh.
    const t = setInterval(load, 20000);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [load]);

  /** Runs a call, folds the returned state in, and hands back an error string. */
  const run = useCallback(async (fn) => {
    setBusy(true);
    try {
      absorb(await fn());
      return null;
    } catch (e) {
      return e.message;
    } finally {
      setBusy(false);
    }
  }, [absorb]);

  const act = useMemo(() => ({
    create: async (poll) => {
      setBusy(true);
      try {
        const next = await api.createPoll(poll);
        // Whoever posts a game is holding its passcode by definition.
        if (next.created) setHostKey(next.created, poll.hostPasscode);
        absorb(next);
        return null;
      } catch (e) {
        return e.message;
      } finally {
        setBusy(false);
      }
    },
    unlock: async (id, passcode) => {
      setBusy(true);
      try {
        await api.unlock(id, passcode);
        setHostKey(id, passcode);
        syncHosted();
        return null;
      } catch (e) {
        return e.message;
      } finally {
        setBusy(false);
      }
    },
    lock: (id) => { clearHostKey(id); syncHosted(); },

    update: (id, patch) => run(() => api.updatePoll(id, patch)),
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
  }), [absorb, run, syncHosted]);

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
        <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
          <button className="ghost mini" onClick={load} disabled={busy}>
            {busy ? "Syncing…" : "Refresh"}
          </button>
          {!posting && (
            <button className="mini go" onClick={() => setPosting(true)}>Post a game</button>
          )}
          {admin ? (
            <button className="mini" onClick={signOut}>Sign out</button>
          ) : (
            <button className="mini" onClick={() => setGate(true)}>Admin</button>
          )}
        </div>
      </header>

      {fatal && <div className="err">{fatal}</div>}

      {gate && !admin && (
        <SignIn onDone={() => { setAdmin(true); setGate(false); }} onClose={() => setGate(false)} />
      )}

      {posting && <NewGame act={act} busy={busy} onExit={() => setPosting(false)} />}

      {state.polls.length === 0 ? (
        <div className="empty">
          <h2 style={{ marginBottom: 10 }}>No games on the board</h2>
          Post one yourself — set a passcode, share the link, and grab your spot.
        </div>
      ) : (
        state.polls.map((p) => (
          <PollCard key={p.id} poll={p} admin={admin} hosting={hosted.has(p.id)}
            act={act} busy={busy} />
        ))
      )}

      <div className="note foot" style={{ marginTop: 30 }}>
        <span>
          The board refreshes itself every 20 seconds, so rosters stay current without
          reloading. Games drop off the board an hour after they finish.
        </span>
        {/* Plain anchor, not a route: /whats-new is a static page, and the
            SPA fallback would otherwise swallow it. */}
        <a href="/whats-new">What's new</a>
      </div>
    </div>
  );
}
