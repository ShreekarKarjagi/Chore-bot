# House Chore Bot

**A production-style SMS service, built and hardened as a real deployed system rather than a toy demo — DST-safe scheduling, HMAC-verified webhooks, idempotent delivery, and a self-editing web dashboard, running on ~$0/month infrastructure.**

Any of the housemates can text the bot a chore name and it replies with whose turn it is; turns rotate round-robin as chores get marked done. On top of that reactive flow, it proactively texts people on a per-chore weekly schedule, with a browser dashboard to edit that schedule, reassign turns, and add new chores — all without touching code.

`Node.js` `Express` `Textbelt SMS API` `HMAC-SHA256` `Vanilla JS` `Render` `GitHub Actions`

---

## Engineering highlights

A few things in this codebase that were worth doing properly rather than the easy way:

**Found and fixed a ~1000x algorithmic regression.** The dashboard's "next reminder" calculation was brute-forcing forward minute-by-minute (up to 10,080 iterations) through `Intl.DateTimeFormat`, the correct-but-expensive API for timezone-aware date math — a call that measured at ~526ms, run once per scheduled task on every dashboard load. Diagnosed with Playwright network-timing instrumentation (isolating exactly which request was slow, down to the millisecond), then replaced with a day-search-plus-offset-correction algorithm that finds the same instant in ~10 calls instead of ~5,000 on average. Verified byte-for-byte identical to the original across 1,512 test cases spanning six timezones (including a 30-minute-offset DST zone) and both 2026 US daylight-saving transitions, before it ever touched the live function. Net result: ~526ms → ~0.5ms per calculation.

**Webhook authenticity, not just an open POST endpoint.** Inbound replies are verified with an HMAC-SHA256 signature over `timestamp + rawBody`, checked with `crypto.timingSafeEqual` (not `===`, which leaks timing information on a byte-by-byte mismatch) and rejected outright if the timestamp is more than 15 minutes old — a lightweight replay-attack guard on an endpoint that would otherwise let anyone spoof an incoming text.

**Correctness under real-world scheduling edge cases.** Every reminder occurrence is tracked by a stable slot key so a server restart or a scheduler tick that fires twice in the same minute can't send the same reminder twice; a failed send is deliberately left unmarked so it can still retry within that minute, but isn't retried forever once the slot has passed. If two chores land on the same person at the same moment, they get one combined text instead of two — a small design choice that keeps SMS costs down as the schedule grows.

**A UI that doesn't refetch and repaint the whole page for a one-line change.** Every dashboard action (reassigning a turn, adding a schedule entry, sending a reminder) used to trigger a full `location.reload()`. Rebuilt the client-side JS around a real Promise chain and a `refreshChores()` call that patches just the affected DOM nodes from a small JSON endpoint — verified with Playwright that a full pass of every mutating action on the page triggers zero page navigations. All user-supplied text is inserted via `.textContent`/`document.createTextNode`, not string concatenation into HTML, so it's inherently immune to injection rather than relying on remembering to escape it everywhere (the server-rendered path also runs everything through an explicit `escapeHTML`/`escapeAttr` pair for the same reason).

**Deliberately zero-dependency where it counts.** The entire backend is Express + `dotenv` — no ORM, no job queue, no framework for a single background timer — because nothing else was justified at this scale. It's one ~1,400-line `server.js`, organized into clearly numbered sections (state, messaging, webhook, scheduler, admin API, dashboard rendering), not a scaffold of folders for a project with one real data model.

**Thought about the free-tier hosting trade-offs instead of ignoring them.** Render's free tier sleeps a service after 15 minutes idle, which would silently drop scheduled reminders while asleep. Rather than just upgrading, this repo ships its own fix: a [GitHub Actions workflow](.github/workflows/keep-alive.yml) that pings the deployed URL every 14 minutes, keeping it within Render's free instance-hour budget without adding paid infrastructure or a third-party account.

---

## How it works once it's live

Text the bot's Textbelt-provided number:

| You send | Bot does |
|---|---|
| `trash` / `vacuuming` / `bathroom` / `balcony` | Texts whoever's turn it currently is for that chore |
| `trash done` | Marks that chore complete and passes the turn to the next person |
| `status` | Replies with whose turn it is for all chores |
| `help` | Shows a quick command reference |

No app to install for anyone else in the house — it's a normal text thread.

### Automatic weekly reminders

Beyond the reactive commands above, the bot proactively texts whoever's turn it is at scheduled times each week — no one has to ask. The schedule starts from a set of sensible defaults and lives in `state.json` from then on, so it's edited **from the dashboard**, not by changing code:

```js
// server.js — DEFAULT_SCHEDULE only seeds state.schedule the very first
// time the bot ever runs. After that, edit it from the dashboard.
const DEFAULT_SCHEDULE = {
  vacuuming: [{ day: 'sat', time: '10:00' }],
  bathroom: [{ day: 'wed', time: '18:00' }],
  balcony: [{ day: 'sun', time: '11:00' }],
  trash: [
    { day: 'mon', time: '08:00' },
    { day: 'thu', time: '08:00' },
  ],
};
```

`day` is a 3-letter lowercase weekday (`sun`…`sat`), `time` is 24-hour `"HH:MM"`, both interpreted in the `TIMEZONE` env var (defaults to `America/Los_Angeles`).

A few behaviors worth knowing:

- If two chores are ever scheduled for the exact same day and time **and** it happens to be the same person's turn for both, they get **one combined text** ("...it's your turn for: Vacuuming and Cleaning the balcony.") instead of two separate ones.
- Each reminder only ever fires once per calendar occurrence — the bot tracks what it's already sent (`state.lastAutoSent`) so a server restart or a timing glitch can't cause a duplicate text for the same slot.
- If a send fails (e.g. a temporary Textbelt outage), that slot is **not** marked as sent, so a restart within the same minute would retry it — but once the minute passes, that occurrence is simply missed rather than retried. It'll fire normally again at the next scheduled occurrence.

### Status dashboard

Visiting the deployed URL in a browser shows a real dashboard, not just an "it's running" message:

- **Tasks & schedule** — a card per task showing whose turn it is, every scheduled day/time as a small pill, and the next time it'll auto-remind someone. This is also the schedule *editor*:
  - **Change whose turn it is** — a dropdown of everyone in the house. Picking someone sets that task's turn directly — a manual override, separate from the "text `<chore> done`" flow, useful for fixing a mistake or handing a chore to someone covering for another person.
  - **Send reminder now** — texts whoever's currently assigned immediately, through the exact same path every other message goes through (respects `TEST_MODE`, re-arms that person's reply channel), just triggered by a click instead of the clock.
  - **Add a reminder** — pick an existing task (or type a new one) plus a day and time. A brand-new task gets its own keywords (comma-separated words that trigger it over text, e.g. `dishes, plates`), defaulting to the task name if left blank. New tasks work exactly like the built-in ones: reactive texting, "done" rotation, and automatic reminders all just work.
  - **Remove a reminder** — drop a single day/time slot from a task.
  - **Delete a task** — tasks added from the dashboard can be deleted entirely; the built-in chores can only be unscheduled, not deleted, since they're wired into the code.
  - **Add to Google Calendar** — opens a pre-filled Google Calendar event (weekly recurrence already set) on Google's own site — no Google account or API key needed on the bot's side, since it's a plain link Google Calendar itself supports.
  - Everything above except the calendar link requires an admin secret typed into the "Admin key" box (never saved) — **except while `TEST_MODE=true`**, where the check is skipped entirely since a test deploy only ever touches a single test number anyway.
- **System health** — shown only while `TEST_MODE=true`. At a glance: whether the Textbelt API key is configured, whether `WEBHOOK_BASE_URL` is set, how many housemates are configured, and whether the scheduler has confirmed a heartbeat recently.
- **Quick actions** — manually trigger the scheduler, or preview what it would do, without building URLs by hand.

The same data is available read-only as JSON at `/status.json` — no secret needed, nothing sensitive in it. This same page also doubles as the health check Render pings to know the service is alive.

**Testing the schedule without waiting for the real time or spending credits:**

```
GET  /debug/schedule?secret=YOUR_SEED_SECRET&at=2026-08-25T15:00:00Z   # read-only preview
POST /debug/trigger-schedule?secret=YOUR_SEED_SECRET&at=2026-08-25T15:00:00Z   # actually sends
```

(`?at=` is optional on both — omit it to check/trigger "right now".)

### A quirk worth knowing: how reply channels get "armed"

Textbelt only routes someone's texts to the bot **after** at least one message with a reply-webhook has been sent to them — there's no traditional "forward every inbound text to this URL" webhook the way some providers offer. There's no separate priming step needed, though: `sendSMS()`, the one function every outbound text goes through, attaches that reply-webhook to **every** message it sends, so whichever message goes out first — a scheduled reminder, a manual "Send reminder now," or a reply — arms that person's channel automatically.

The one gap: if someone texts the bot completely cold, before it's ever sent them anything, that first reply has nothing to attach to. Sending one reminder from the dashboard right after deploying (or after adding someone new) arms their channel before they try texting in.

---

## Architecture

```
Housemate's phone ──text──> Textbelt ──HMAC-signed webhook──> /webhook
                                                                  │
                                                     verify signature (timing-safe)
                                                                  │
                                                    match keyword → chore → person
                                                                  │
                                                            sendSMS() ──> Textbelt ──text──> reply

Every minute: scheduler tick ──> findDueReminders(state) ──> sendSMS() per person (batched)

Browser ──> GET  /            server-rendered dashboard (HTML + inline vanilla JS)
        ──> GET  /status.json same data as JSON, read-only, no secret
        ──> POST /api/*       admin-secret-gated mutations → state.json → dashboard patches in place
```

State (turn rotation, live schedule, custom tasks, sent-reminder tracking) lives in a single `state.json` file read/written by every request that needs it — no database, since a household's worth of chores doesn't need one. `buildStatusData()` is the single function that computes dashboard state from `state.json`; both the HTML page and `/status.json` call through it, so the two views can never drift apart.

### Project structure

```
server.js                        single-file backend: state, SMS, webhook, scheduler, admin API, dashboard
.github/workflows/keep-alive.yml GitHub Actions cron — keeps the free-tier deploy from sleeping
render.yaml                      Render service definition (env var names, build/start commands)
state.json                       runtime state (turn rotation, schedule, custom tasks) — not secret, but resets on redeploy (see below)
.env.example                     documents every required environment variable
```

---

## Setup

### Step 1 — Get a Textbelt API key

1. Go to https://textbelt.com/purchase/ and buy some SMS credits (no business registration, no approval wait — pricing is shown per-region on that page).
2. You'll get an API key. Save it.
3. (Optional, free) Test the whole flow first using the special test key `textbelt_test` — it validates your setup without spending credit or actually delivering a text.

### Step 2 — Get everyone's phone numbers

Write down each housemate's number in E.164 format, e.g. `+15551234567`.

### Step 3 — Put this code on GitHub

Render deploys from a Git repository.

1. Create a free GitHub account if you don't have one: https://github.com/signup
2. Create a new repository (private, if you'd rather keep phone numbers and secrets out of a public repo — they only ever live in Render's environment variables and your local `.env`, never in this repo, but a private repo is the safer default).
3. Push the contents of this folder. Do **not** commit a real `.env` file — only `.env.example` should be in the repo.

### Step 4 — Deploy to Render (free tier)

1. Create a free account at https://render.com (you can sign up with GitHub).
2. Click **New → Web Service** and connect your GitHub repo.
3. Confirm:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance Type:** Free
4. Under **Environment**, add these variables:

   | Key | Value |
   |---|---|
   | `TEXTBELT_API_KEY` | your Textbelt API key (or `textbelt_test` for a dry run) |
   | `WEBHOOK_BASE_URL` | your Render URL once deployed, e.g. `https://house-chore-bot.onrender.com` (no trailing slash) |
   | `SEED_SECRET` | any password you make up |
   | `PERSON_1_NAME` / `PERSON_1_NUMBER` | e.g. `Alex` / `+15551234567` |
   | `PERSON_2_NAME` / `PERSON_2_NUMBER` | same pattern |
   | `PERSON_3_NAME` / `PERSON_3_NUMBER` | same pattern |

   You won't know your exact Render URL until after the first deploy — deploy once, copy the URL Render gives you, then come back and set `WEBHOOK_BASE_URL` (Render redeploys automatically on an env var change).

5. Click **Create Web Service** and wait for it to go live.

### Step 5 — Keep it from sleeping (optional but recommended)

Render's free tier spins down after 15 minutes idle. This repo includes a GitHub Actions workflow (`.github/workflows/keep-alive.yml`) that pings the deployed site every 14 minutes to prevent that. One-time setup: in your GitHub repo, go to **Settings → Secrets and variables → Actions → Variables** and add a repository variable named `APP_URL` set to your deployed URL, no trailing slash.

### Step 6 — Test it

Open the app's root URL — that's the dashboard. On any task card, click "📨 Send reminder now" (you'll need the `SEED_SECRET` you set above, unless `TEST_MODE=true`). That sends a real first text to whoever's currently assigned, which also arms their reply channel — do this once per housemate after deploying.

Then, from any housemate's phone, reply to that text with something like `trash` or `status`. You should get a reply within a few seconds.

---

## Notes and limitations

- **Free Render tier sleeps after inactivity** if the keep-alive workflow above isn't set up — the first message after a quiet period can take ~30–50 seconds to get a reply while the server wakes up.
- **State resets on redeploy.** Whose-turn-is-it, the live schedule, and any dashboard-added tasks are all stored in `state.json` on disk. Render's free tier has no persistent disk, so a fresh deploy replaces that file with whatever's committed in the repo — **schedule changes or tasks added from the dashboard since your last commit are lost on the next deploy.** To keep live changes: copy `/status.json` back into the repo's `state.json` and commit it before deploying again. A natural next step to remove this limitation entirely would be moving state to a small hosted database (e.g. Render's free Postgres tier) instead of a local file.
- **The reply-channel behavior is Textbelt's own undocumented mechanic** — their public docs don't fully specify how long a channel stays "armed" after the last message. The bot re-arms it on every message it sends, which should keep it alive indefinitely through normal use.
- **Cost:** pay-per-text, no monthly fee — check https://textbelt.com/purchase/ for current rates.
- **Changing tasks or the schedule** day-to-day uses the dashboard — no code or redeploy needed. The built-in chores and their keyword lists live in the `CHORES` object near the top of `server.js`; `DEFAULT_SCHEDULE` next to it is only the starting schedule for a brand-new deploy, not the live one.

## Local testing

```bash
npm install
cp .env.example .env   # then fill in real values (or use TEXTBELT_API_KEY=textbelt_test)
npm start
```

The simplest way to test end-to-end without spending money is to deploy with `textbelt_test` and use the dashboard's "Send reminder now" button, which exercises the real send path without delivering an actual text.
