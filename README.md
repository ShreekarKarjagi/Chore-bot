# House Chore Bot (SMS via Textbelt)

A small bot for a 3-person household. Any of the 3 housemates can text it a chore
name and it will remind whoever's turn it is via SMS. Turns rotate round-robin
each time someone marks a chore "done".

This version uses **Textbelt** instead of Twilio — no business/brand
registration, no carrier approval wait. You get an API key and it works
immediately.

Chores tracked: **vacuuming**, **cleaning the bathroom**, **cleaning the balcony**,
**taking out the trash**.

## How it works once it's live

Text the bot's Textbelt-provided number (or shared number, depending on your
plan):

| You send | Bot does |
|---|---|
| `trash` / `vacuuming` / `bathroom` / `balcony` | Texts whoever's turn it currently is for that chore |
| `trash done` | Marks that chore complete and passes the turn to the next person |
| `status` | Replies with whose turn it is for all 4 chores |
| `help` | Shows a quick command reference |

No app to install for your housemates — it's a normal text message thread.

### Automatic weekly reminders

Beyond the reactive commands above, the bot also proactively texts whoever's
turn it is at scheduled times each week — no one has to ask. The schedule
starts from a set of sensible defaults and lives in `state.json` from then
on, so it's edited **from the dashboard**, not by changing code:

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

`day` is a 3-letter lowercase weekday (`sun`…`sat`), `time` is 24-hour
`"HH:MM"`, both interpreted in the `TIMEZONE` env var (defaults to
`America/Los_Angeles`).

A few behaviors worth knowing:

- If two of your chores are ever scheduled for the exact same day and time
  **and** it happens to be the same person's turn for both, they get **one
  combined text** ("...it's your turn for: Vacuuming and Cleaning the
  balcony.") instead of two separate ones — this is what keeps the automatic
  reminders cheap even if your schedule gets busy.
- Each reminder only ever fires once per calendar occurrence — the bot
  tracks what it's already sent (`state.lastAutoSent`) so a server restart
  or a timing glitch can't cause a duplicate text for the same slot.
- If a send fails (e.g. a temporary Textbelt outage), that slot is **not**
  marked as sent, so a restart within the same minute would retry it —
  but once the minute passes, that occurrence is simply missed rather than
  retried, since the bot only checks for exact matches. It'll fire normally
  again at the next scheduled occurrence.

### Status dashboard

Visiting your deployed URL in a browser (e.g. `https://house-chore-bot.onrender.com/`)
shows a real dashboard, not just a plain "it's running" message:

- **System health** — at a glance, whether the Textbelt API key is configured,
  whether `WEBHOOK_BASE_URL` is set, how many of the 3 housemates are
  configured, how many have been seeded (see below), whether the automatic
  scheduler has confirmed a heartbeat recently, and whether `TEST_MODE` is on.
  Each card has a 🟢/🔴 (or 🧪/⚪ for test mode) so a problem is visible without
  reading logs.
- **Tasks & schedule** — a card per task showing whose turn it is, every
  scheduled day/time as a small pill, and the next time it'll auto-remind
  someone. This is also the schedule *editor*:
  - **Add a reminder** — pick an existing task (or type a new one) plus a
    day and time, and hit "Add reminder." A brand-new task also gets its own
    keywords (comma-separated words that trigger it over text, e.g.
    `dishes, plates`) — defaulting to the task name if you leave that blank.
    New tasks work exactly like the 4 built-in ones: reactive texting,
    "done" rotation, and automatic reminders all just work.
  - **Remove a reminder** — click the ✕ on any pill to drop that one
    day/time slot.
  - **Delete a task** — tasks you've added from the dashboard can be deleted
    entirely (schedule + turn history); the 4 built-in chores can only be
    unscheduled, not deleted, since they're wired into the code.
  - **Add to Google Calendar** — click the 📅 on any pill to open a
    pre-filled Google Calendar event (with a weekly recurrence already set)
    on Google's own site — you just click "Save" there. This needs no
    Google account or API key on the bot's side; it's a plain link Google
    Calendar itself supports, so the bot can never create a calendar event
    without that person's own click.
  - Adding/removing/deleting all require your `SEED_SECRET` in the "Admin
    key" box at the top of the page (typed in, never saved anywhere).
- **Quick actions** — buttons to run `/seed`, manually trigger the scheduler
  right now, or preview what the scheduler would do, without needing to build
  URLs by hand. Same admin key as above.

For scripts or monitoring, the same data is available as JSON at `/status.json`
(no secret needed — it's read-only and has nothing sensitive in it).

This page also doubles as the health check Render pings to know the service
is alive — it always returns 200, and surfaces any underlying problem (like a
missing API key) on the page itself rather than as a failed health check.

**Testing the schedule without waiting for the real time or spending
credits:**

```
https://your-app.onrender.com/debug/schedule?secret=YOUR_SEED_SECRET&at=2026-08-25T15:00:00Z
```

This is read-only — it tells you what *would* happen at that moment (in your
configured timezone) without sending anything. Good for sanity-checking your
schedule and `TIMEZONE` are set up the way you think.

To actually fire it for real (e.g. to test the full send, or to manually
re-send something you missed):

```
POST https://your-app.onrender.com/debug/trigger-schedule?secret=YOUR_SEED_SECRET&at=2026-08-25T15:00:00Z
```

(`?at=` is optional on both — omit it to check/trigger "right now".) This one
**does** send real texts (respecting `TEST_MODE` like everything else), so
use it deliberately.

### Important quirk: the one-time "seed" step

Textbelt only routes someone's texts to your bot **after** you've sent them at
least one message with a reply-webhook attached — it doesn't have a
traditional "any message that arrives on this number, forward it to me"
webhook the way Twilio does. Every message the bot sends re-arms this for the
next reply, so once the loop is going it stays going — but there needs to be
one initial nudge to kick it off for each person. That's what the `/seed`
endpoint below is for. **Do this once after deploying, and again for anyone
who hasn't texted the bot in a very long time** if they ever stop getting
replies.

---

## Setup

### Step 1 — Get a Textbelt API key

1. Go to https://textbelt.com/purchase/ and buy some SMS credits (no business
   registration, no approval wait — pricing is shown per-region on that page).
2. You'll get an API key. Save it.
3. (Optional, free) You can test the whole flow first using the special test
   key `textbelt_test` — it validates your setup without spending credit or
   actually delivering a text, useful for confirming your deploy works before
   spending real money.

### Step 2 — Get everyone's phone numbers

Write down each housemate's number in E.164 format, e.g. `+15551234567`.

### Step 3 — Put this code on GitHub

Render deploys from a Git repository.

1. Create a free GitHub account if you don't have one: https://github.com/signup
2. Create a new **private** repository (e.g. `house-chore-bot`).
3. Upload the contents of this folder. Do **not** upload a real `.env` file —
   only `.env.example` should go in the repo.

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
   | `SEED_SECRET` | any password you make up, e.g. `mysecret123` |
   | `PERSON_1_NAME` | e.g. `Alex` |
   | `PERSON_1_NUMBER` | e.g. `+15551234567` |
   | `PERSON_2_NAME` | e.g. `Sam` |
   | `PERSON_2_NUMBER` | e.g. `+15551234568` |
   | `PERSON_3_NAME` | e.g. `Jordan` |
   | `PERSON_3_NUMBER` | e.g. `+15551234569` |

   Note: you won't know your exact Render URL until after the first deploy.
   Deploy once, copy the URL Render gives you, then come back and set
   `WEBHOOK_BASE_URL` to it (Render will redeploy automatically when you save
   an env var change).

5. Click **Create Web Service** and wait for it to go live.

### Step 5 — Run the one-time seed

Once deployed with the real `WEBHOOK_BASE_URL` set, open this in a browser
(replace with your actual URL and secret):

```
https://house-chore-bot.onrender.com/seed?secret=mysecret123
```

This texts all 3 housemates an intro message and arms their reply channels.
You should see a JSON response confirming each send succeeded.

### Step 6 — Test it

From any of the 3 housemates' phones, reply to that intro text with something
like `trash` or `status`. You should get a reply within a few seconds.

While you're testing, keep the dashboard open at your app's root URL (e.g.
`https://house-chore-bot.onrender.com/`) — it's the fastest way to see
whether everything's configured correctly and whose turn it currently is,
without digging through Render's logs.

---

## Notes and limitations

- **Free Render tier sleeps after inactivity.** The first message after a quiet
  period may take ~30–50 seconds to get a reply while the server wakes up.
- **The scheduler only runs while the server is awake.** Free Render services
  spin down after ~15 minutes with no incoming HTTP traffic — and since the
  scheduler is just a timer running inside this same process, a scheduled
  reminder can get missed if the server happened to be asleep at that exact
  minute (no incoming text or request in the run-up to it). Texting the bot
  anything a minute or two before a scheduled time keeps it awake for that
  slot. If missed reminders become a real problem, the fix is either a paid
  Render instance (no sleep) or an external pinger that hits the site every
  10–15 minutes to keep it awake — ask if you want that set up.
- **State resets on redeploy — this now includes schedule edits and
  dashboard-added tasks, so read this one.** Whose-turn-is-it, who's been
  seeded, the live schedule, and any tasks you've added from the dashboard
  are all stored in `state.json` on disk. That file survives normal
  restarts/sleep, but Render's free tier has no persistent disk, so a fresh
  deploy (i.e. every `git push`) replaces it with whatever `state.json`
  happens to be committed in your repo — **any schedule changes or tasks you
  added from the dashboard since your last commit will be lost** on the next
  deploy. If you've made changes on the live dashboard you want to keep:
  copy the live `/status.json` (or the file itself, if you can reach the
  Render disk) back into your repo's `state.json` and commit it before your
  next deploy. Day-to-day code changes that don't touch the schedule won't
  disturb anything as long as you're not deploying in the same window as a
  dashboard edit. Ask if you'd like this moved to a small free database
  (removes this gotcha entirely).
- **The reply-channel behavior is Textbelt's own undocumented mechanic** —
  their public docs don't fully specify how long a channel stays "armed" after
  the last message. The bot re-arms it on every single message it sends (both
  replies and reminders), which should keep it alive indefinitely through
  normal use. If someone ever stops getting replies after a long silence, hit
  `/seed` again to re-open their channel (the dashboard's "Run /seed" button
  does this without needing to build the URL by hand).
- **Cost:** pay-per-text, no monthly fee — check https://textbelt.com/purchase/
  for current rates. For a household's worth of chore texts, this should be a
  small amount per month.
- **Changing tasks or the schedule:** day-to-day, use the dashboard (see
  above) — no code or redeploy needed. The 4 built-in chores and their
  keyword lists live in the `CHORES` object near the top of `server.js` if
  you ever want to change those specifically (e.g. rename a chore, add more
  trigger words); `DEFAULT_SCHEDULE` next to it is only the starting
  schedule for a brand-new deploy, not the live one (see the state-reset
  note above).

## Local testing (optional)

```bash
npm install
cp .env.example .env   # then fill in real values (or use TEXTBELT_API_KEY=textbelt_test)
npm start
```

Then simulate an incoming reply without needing a real webhook call from
Textbelt — note this only works if you disable signature verification
temporarily, since Textbelt signs real webhook calls with your API key. The
simplest way to test end-to-end is to actually deploy with `textbelt_test`
and use the `/seed` endpoint, which exercises the real send path without
spending money or delivering a real text.
