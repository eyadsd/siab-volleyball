# SIAB

Volleyball game board for the SIAB community. Anyone can post a game slot,
players RSVP, the roster fills to a cap, everyone after that lands on a waitlist
in arrival order, and whoever is running the game can split the confirmed roster
into skill-balanced teams.

- **Players** need no account — a name and a skill level.
- **Organizers** need no account either. Post a game, set a passcode for it,
  and that passcode runs that game.
- **Admin** signs in with the site-wide passcode and can edit or delete anything.
- **Waitlist** promotion is automatic. Cancel a spot and the next person moves up.
- **Rounds** — re-mix as many times as you like during a session. Each mix
  pairs people who haven't played together yet and rotates the bench.
- **Housekeeping** — a game clears itself off the board an hour after it ends.

Stack: React + Vite on the front, a single Cloudflare Worker on the back, D1
(SQLite) for storage. Runs entirely inside Cloudflare's free tier.

---

## Who can do what

Two levels of authority, because one shared passcode meant one person had to be
awake to run every game.

**Game passcode.** Whoever posts a game sets a passcode for it, right in the
form. It's stored hashed — SHA-256 salted with the game's id, so the same
passcode on two games doesn't produce the same hash, and a leaked database
doesn't hand out passcodes people reuse elsewhere. That passcode lets you edit
the game, mix rounds, remove players, close voting, and delete it. It works on
any device and on nobody else's game. Share it with whoever helps you run the
night.

**Admin passcode.** The `ADMIN_PASSCODE` secret opens every game on the board
regardless of who posted it, including games whose host passcode nobody
remembers. Set it once with `wrangler secret put` and it never reaches the
browser.

The browser keeps game passcodes in `localStorage` and the admin passcode in
`sessionStorage` — a game passcode is low-value and gets pasted into a group
chat anyway, so it survives a reload; the admin one dies with the tab. Either
way, the server re-checks on every request; the client-side flag only decides
which buttons to draw.

Games created before per-game passcodes existed have no host hash, so they're
admin-only. That's the one thing the upgrade can't infer.

## How the roster logic works

RSVPs are stored in one ordered list per game with a strictly increasing signup
counter (`seq`). The first `cap` entries are the active roster; everything after
is the waitlist. There is no separate "promote" operation to get wrong — removing
anyone shifts the list, and the next person is on the roster by definition.

Two guarantees worth knowing:

- **No double-booking.** A `UNIQUE(poll_id, name_key)` index rejects a duplicate
  name even if two requests arrive simultaneously. The check is in the database,
  not in application code where a race could slip through.
- **Fair queue order.** Ordering uses the autoincrement counter rather than a
  timestamp, because timestamps tie when two people submit in the same
  millisecond, and a tie-break on a random ID would hand out waitlist places
  arbitrarily.

## Skill levels

Five rungs: **Beginner, Beginner-intermediate, Intermediate, Upper-intermediate,
Advanced**, weighted 1 to 5.

Three levels didn't work. Nobody volunteers to be the worst player in the gym
and nobody wants to over-claim either, so almost everyone picked Intermediate
and the balancer had a roster of identical numbers to work with. The two halfway
rungs give people an answer they'll actually pick, which is the only way the
mixer gets real signal.

The old `B`, `I` and `A` ids are unchanged, so RSVPs stored under the
three-level scale still read correctly — they simply sit at 1, 3 and 5 on the
new scale instead of 1, 2 and 3. No data migration needed.

## Mixing rounds

Every mix creates a new round, and rounds are kept as a record of what was
actually played. A player joining or leaving later doesn't rewrite earlier
rounds — only the next mix uses the updated roster.

Re-mixing has to fight a real problem: a plain skill-balancer is deterministic,
so pressing "mix" twice hands you the same two teams. The mixer optimizes three
things at once instead:

1. **Even sides.** Beginner 1 up to Advanced 5, gap minimized.
2. **Fresh pairings.** Every previous round is read back as a pairing history,
   and same-side pairs that already happened are penalized. One point of skill
   imbalance is priced at five repeat pairings (`GAP_WEIGHT` in
   `worker/balance.js`) — raise it to favour balance, lower it to favour
   variety. It was ten when the scale ran 1–3; a "point" is now half a skill
   step rather than a whole one, so five prices a full step at the same ten
   repeats it always cost.
3. **Bench rotation.** Sides are always equal size, because 6v6 with a sub is
   volleyball and 7v6 isn't. Anyone not on court sits out, and whoever sat out
   most goes back on first.

You set two things: how many **sides** (2–4) and how many **players a side**
(1 up to whatever the roster allows). Twelve players at 6 v 6 puts everyone on
court; the same twelve at 4 v 4 fields eight and rotates four through the bench.
Leave the side size at its maximum and it behaves as before, fitting as many
people on court as possible.

Bench rotation matters much more once you drop below a full court — over six
rounds of 4 v 4 with twelve players, everyone sits out exactly twice.

In practice, with 12 players over 4 rounds this covers 63 of the 66 possible
pairings. A fixed lineup would give you 30, forever.

Each round shows how it did — new pairings, repeats, and the point gap between
sides. You can undo a single round if a mix looks wrong, or clear the session to
start over.

One honest limit: with a small roster of all-distinct levels there is sometimes
exactly one balanced split, and the mixer will keep choosing it rather than
unbalance the sides for variety's sake. That's the trade-off `GAP_WEIGHT` names.

## Editing a game

Anything you set when posting a game can be changed afterwards by whoever holds
its passcode: name, date, start time, length, place, player cap, and the
description. Only the fields you actually change are written, so fixing the
start time doesn't blank the notes.

Past rounds are left alone — they're a record of what was played, so raising or
lowering the cap doesn't rewrite them.

## Games clear themselves off the board

A game is deleted, with its RSVPs and rounds, one hour after it ends. "Ends" is
a real moment rather than a guess, which is why posting a game asks how long it
runs (default two hours).

The sweep runs at the start of every API request. There's no cron on the free
tier, and the check is one indexed `SELECT` that usually matches nothing.

Two details worth knowing:

- **Timezones.** Date and time are stored as bare strings with no offset, and a
  Worker's local time is UTC — so the server can't tell 19:00 Budapest from
  19:00 UTC. The browser can, so the end timestamp is computed client-side when
  a game is posted or rescheduled and sent along. The UTC fallback for API
  callers that don't send one errs late, which only means a finished game
  lingers a couple of hours longer.
- **No date, no expiry.** A game with the date left blank never expires. It
  waits for a human to remove it.

---

## Deploy

You need a free Cloudflare account and a GitHub account. Total time ~10 minutes.

### 1. Push to GitHub

```bash
cd siab
git init
git add .
git commit -m "SIAB volleyball board"
gh repo create siab --private --source=. --push
```

No `gh` CLI? Create an empty repo on github.com, then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/siab.git
git branch -M main
git push -u origin main
```

### 2. Install and log in

```bash
npm install
npx wrangler login
```

### 3. Create the database

```bash
npm run db:create
```

This prints a `database_id`. Open `wrangler.jsonc` and paste it in place of
`PASTE_YOUR_DATABASE_ID_HERE`. Then create the tables:

```bash
npm run db:init
```

Upgrading an existing deployment? Don't re-run the schema — apply whichever
migrations you're missing, in order:

```bash
# only if you deployed the original single-mix version
npx wrangler d1 execute siab-db --remote --file=./migrations/001_rounds.sql

# per-game passcodes and automatic expiry
npx wrangler d1 execute siab-db --remote --file=./migrations/002_hosts_and_expiry.sql
```

`002` is not re-runnable — SQLite has no `ADD COLUMN IF NOT EXISTS`, so a second
run fails on a duplicate column. That failure means it already ran.

It leaves `ends_at` NULL on existing rows on purpose, so nothing already on the
board vanishes the moment you deploy. Games posted after the upgrade expire
normally; to retire the old ones, edit each once in the UI (which recomputes the
end time) or backfill `ends_at` directly — `migrations/003_backfill_ends_at.sql`
is a worked example of the latter.

### 4. Set the admin passcode

```bash
npx wrangler secret put ADMIN_PASSCODE
```

Type your passcode when prompted. It's stored as a Cloudflare secret and never
ships to the browser — the client sends what you type at sign-in and the Worker
compares it in constant time. To change it later, run the same command again.

This is the passcode that opens *every* game. Day-to-day organizing doesn't need
it: whoever posts a game sets that game's own passcode in the form.

### 5. Deploy

```bash
npm run deploy
```

That's the live board — send the URL to the group.

### Continuous deploys (optional)

To redeploy on every push instead of running `npm run deploy` by hand, connect
the repo under **Workers & Pages → your worker → Settings → Build**. Cloudflare's
free tier allows 500 builds/month, so a normal commit rhythm won't run out.

---

## Custom domain

**Be aware: the domain registration itself is not free.** Freenom's free `.tk`
and `.ml` extensions shut down in 2024 after legal action from Meta, and no
registrar gives away real top-level domains anymore. Everything *else* here —
hosting, DNS, SSL, bandwidth — is genuinely $0.

Three honest options:

**A. Buy a domain (~$10/year, recommended).** Cloudflare Registrar sells at
wholesale cost with no markup and includes free WHOIS privacy. Register in the
Cloudflare dashboard under **Domain Registration → Register Domain**, then:

1. Go to **Workers & Pages → siab → Settings → Domains & Routes**
2. **Add → Custom domain**, enter `siab.yourdomain.com` (or the apex)
3. Cloudflare adds the DNS record and issues the SSL certificate automatically

If the domain is already registered elsewhere, add the site to Cloudflare and
point the registrar at Cloudflare's nameservers first. Same steps after that.

**B. Free subdomain.** `eu.org` gives free permanent subdomains (`siab.eu.org`),
though approval is manual and can take a couple of weeks. Similar services exist
for developer-flavored domains. You control DNS, so the Cloudflare setup above
still applies — you just point a CNAME at the worker.

**C. Free `workers.dev` subdomain.** Slightly uglier, entirely functional, zero
effort. Flip `workers_dev` back to `true` in `wrangler.jsonc`.

---

## Local development

Two terminals:

```bash
npm run dev:api    # Worker + local D1 on :8787
npm run dev        # Vite on :5173, proxies /api to :8787
```

First time only, seed the local database and set a dev passcode:

```bash
npm run db:init:local
cp .dev.vars.example .dev.vars     # then edit the passcode inside
```

## Tests

```bash
npm test
```

120 checks, no test framework and no network.

`test/balance.test.mjs` verifies the mixer against the theoretical minimum
pairing overlap rather than a guessed threshold — for two sides of six, round 2
provably cannot share fewer than 12 pairings with round 1, and the mixer hits
exactly that every run. Also covers bench fairness at 4 v 4 where a third of the
roster sits every round, side sizes the roster can't support, that the five
levels form a strict ladder the mixer actually reads, and that RSVPs stored
under the old three-level scale still mix and still balance.

`test/api.test.mjs` runs the real Worker against real SQLite through a small D1
shim, so the actual SQL is exercised: auth at both levels, validation, capacity
overflow, waitlist promotion, duplicate names, round history surviving roster
changes, and cascade deletes. On the newer behaviour it covers that a game
passcode opens its own game and no other, that identical passcodes on two games
hash differently, that passcodes are never stored or served in the clear, that
admin overrides a game it didn't create, that a partial edit leaves untouched
fields alone, and the expiry sweep on both sides of the grace hour — including
that a date-TBD game is never swept.

Fixtures are scheduled relative to `Date.now()`, not pinned to literal dates.
Now that games expire, a hard-coded date would have quietly started failing the
day it passed.

---

## Free-tier headroom

| Resource | Free allowance | What SIAB uses |
| --- | --- | --- |
| Worker requests | 100,000/day | ~1 per page view or RSVP |
| D1 rows read | 5,000,000/day | Whole board is a few dozen rows |
| D1 rows written | 100,000/day | 1 per RSVP, 1 per round mixed |
| D1 storage | 5 GB | Kilobytes |
| Builds | 500/month | 1 per push |

A group of 30 players polling a few games a week uses a rounding error of this.
The page auto-refreshes every 20 seconds while open, which is the heaviest
recurring cost — at ~4,300 requests per day of continuous open tabs you'd still
be well inside the limit. The expiry sweep adds one indexed read to each of
those, and writes only on the rare request that actually finds an expired game.

## Project layout

```
worker/index.js      API routes, auth, validation, expiry sweep
worker/balance.js    round mixer: skill weights, pairing memory, bench rotation
src/App.jsx          all UI
src/api.js           fetch wrapper, admin + per-game passcode storage
schema.sql           tables and indexes — for a fresh database only
migrations/          upgrade scripts for an existing deployment, in order
wrangler.jsonc       Cloudflare config (paste database_id here)
```
