# SIAB

Volleyball game board for the SIAB community. Players RSVP for a game slot, the
roster fills to a cap, everyone after that lands on a waitlist in arrival order,
and the organizer can split the confirmed roster into skill-balanced teams.

- **Players** need no account — a name and a skill level.
- **Organizer** signs in with a passcode to post games, edit rosters, and mix teams.
- **Waitlist** promotion is automatic. Cancel a spot and the next person moves up.
- **Rounds** — re-mix as many times as you like during a session. Each mix
  pairs people who haven't played together yet and rotates the bench.

Stack: React + Vite on the front, a single Cloudflare Worker on the back, D1
(SQLite) for storage. Runs entirely inside Cloudflare's free tier.

---

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

## Mixing rounds

Every mix creates a new round, and rounds are kept as a record of what was
actually played. A player joining or leaving later doesn't rewrite earlier
rounds — only the next mix uses the updated roster.

Re-mixing has to fight a real problem: a plain skill-balancer is deterministic,
so pressing "mix" twice hands you the same two teams. The mixer optimizes three
things at once instead:

1. **Even sides.** Beginner 1, Intermediate 2, Advanced 3, gap minimized.
2. **Fresh pairings.** Every previous round is read back as a pairing history,
   and same-side pairs that already happened are penalized. One point of skill
   imbalance is priced at ten repeat pairings (`GAP_WEIGHT` in `worker/balance.js`)
   — raise it to favour balance, lower it to favour variety.
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

Already running the earlier single-mix version? Apply the rounds migration
instead of re-running the schema:

```bash
npx wrangler d1 execute siab-db --remote --file=./migrations/001_rounds.sql
```

### 4. Set the organizer passcode

```bash
npx wrangler secret put ADMIN_PASSCODE
```

Type your passcode when prompted. It's stored as a Cloudflare secret and never
ships to the browser — the client sends what you type at sign-in and the Worker
compares it in constant time. To change it later, run the same command again.

### 5. Deploy

```bash
npm run deploy
```

You'll get a URL like `https://siab.YOUR_SUBDOMAIN.workers.dev`. That's the live
board — send it to the group.

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

**C. Free `workers.dev` subdomain.** What you already get in step 5. Slightly
uglier, entirely functional, zero effort.

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

66 checks. The mixer is verified against the theoretical minimum pairing overlap
rather than a guessed threshold — for two sides of six, round 2 provably cannot
share fewer than 12 pairings with round 1, and the mixer hits exactly that every
run. Also covers bench fairness at 4 v 4 where a third of the roster sits every
round, side sizes the roster can't support, and the full API against real SQLite: auth, validation, capacity overflow, waitlist promotion, duplicate
names, round history surviving roster changes, and cascade deletes.

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
be well inside the limit.

## Project layout

```
worker/index.js      API routes, auth, validation
worker/balance.js    round mixer: pairing memory, bench rotation
src/App.jsx          all UI
src/api.js           fetch wrapper, passcode handling
schema.sql           tables and indexes
migrations/          upgrade scripts for an existing deployment
wrangler.jsonc       Cloudflare config (paste database_id here)
```
