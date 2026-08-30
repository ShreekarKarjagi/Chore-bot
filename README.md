# House Chore Bot

A text-message bot for a 3-person household, built so nobody has to remember whose turn it is to take out the trash. Text it a chore name and it tells you who's on the hook; it also texts people on its own on a weekly schedule, so reminders happen without anyone having to ask.

I built this using **Textbelt** instead of Twilio — no business registration or carrier approval wait, just an API key that works right away.

Chores tracked out of the box: **vacuuming**, **cleaning the bathroom**, **cleaning the balcony**, **taking out the trash** — plus anything else you add from the dashboard.

## How it works

Text the bot's number:

| You send | Bot does |
|---|---|
| `trash` / `vacuuming` / `bathroom` / `balcony` | Texts back whoever's turn it currently is for that chore |
| `trash done` | Marks it complete and passes the turn to the next person |
| `status` | Replies with whose turn it is for everything |
| `help` | Quick command reference |

No app to install — it's just a normal text thread.

### It also reminds people on its own

Beyond answering when someone asks, the bot proactively texts whoever's turn it is at scheduled times each week. The schedule starts with sensible defaults (Saturday morning for vacuuming, trash out twice a week, etc.) and from then on it's edited from the web dashboard — no code changes needed.

A couple of things it quietly handles so reminders stay reliable:

- If someone's due for two chores at the exact same time, they get one combined text instead of two.
- Each reminder only ever fires once — a server restart or a scheduler hiccup can't cause a duplicate text for the same slot.
- If a text fails to send, it isn't marked as sent, so it can still go out on retry — but it won't nag someone forever for a slot that's already passed.

### The dashboard

Opening the deployed URL in a browser shows a live dashboard rather than just a blank "it's running" page. From there you can:

- See whose turn it is for everything, and reassign it by hand if needed (separate from the normal "text `done`" flow — useful for fixing a mistake or covering for someone).
- Send a reminder to someone right now, on the spot, without waiting for the schedule.
- Add a new chore, give it a day/time and some trigger keywords, and it works exactly like the built-in ones from that point on.
- Add any scheduled reminder to Google Calendar with one click.
- Remove a scheduled time, or delete a chore you added.

Everything that changes something is protected by an admin password you type in (not saved anywhere).

### One quirk worth knowing

Textbelt only starts routing someone's replies to the bot *after* it has sent them at least one text — there's no "forward everything this number receives" webhook the way some providers offer. In practice this isn't a real extra step, since every text the bot sends (a reminder, a reply, a manual send from the dashboard) opens that channel automatically. The only case it matters: if someone texts the bot completely cold before it's ever texted them, that first message has nothing to attach to. Sending one reminder from the dashboard right after setup (or after adding someone new) takes care of it.

---

## Under the hood

This is a small, deliberately simple app — one `server.js` file, Node.js and Express, with `state.json` on disk holding the schedule and whose turn it is. No database, no framework beyond Express, because a household chore list doesn't need one.

A few things worth calling out if you're looking at the code:

- **Incoming texts are verified, not just trusted.** Textbelt signs each webhook (HMAC-SHA256), and the bot checks that signature with a timing-safe comparison and rejects anything more than 15 minutes old, so the reply endpoint can't be spoofed.
- **The "next reminder" time used to be slow, and now it isn't.** It was originally computed by brute-force checking every minute in the coming week — a real, measurable ~500ms per chore. It's now computed with a much smarter day-and-offset search that lands on the exact same answer, verified against the old version across 1,500+ test cases (different timezones and both daylight-saving switchovers included), and runs in well under a millisecond.
- **The dashboard patches itself instead of reloading the page** after every click — it fetches just the updated data and updates the DOM directly, which is most of why it now feels instant.
- **It's hosted for free on Render**, with a small [GitHub Actions job](.github/workflows/keep-alive.yml) that pings the site every 14 minutes so it doesn't spin down from inactivity between free-tier deploys.

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
2. Create a new repository (private is the safer default, since it keeps the repo itself separate from any real secrets — though those only ever live in Render's environment variables and your local `.env`, never committed here).
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
- **State resets on redeploy.** Whose-turn-is-it, the live schedule, and any dashboard-added tasks are all stored in `state.json` on disk. Render's free tier has no persistent disk, so a fresh deploy replaces that file with whatever's committed in the repo — **schedule changes or tasks added from the dashboard since your last commit are lost on the next deploy.** To keep live changes: copy `/status.json` back into the repo's `state.json` and commit it before deploying again. Moving state to a small hosted database (e.g. Render's free Postgres tier) would remove this limitation entirely, if it ever becomes a real problem.
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
