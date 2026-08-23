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

---

## Notes and limitations

- **Free Render tier sleeps after inactivity.** The first message after a quiet
  period may take ~30–50 seconds to get a reply while the server wakes up.
- **State resets on redeploy.** Whose-turn-is-it, and who's been seeded, are
  stored in `state.json` on disk. It survives normal restarts/sleep, but a
  fresh deploy resets it. Ask if you want this moved to a small free database
  for true persistence.
- **The reply-channel behavior is Textbelt's own undocumented mechanic** —
  their public docs don't fully specify how long a channel stays "armed" after
  the last message. The bot re-arms it on every single message it sends (both
  replies and reminders), which should keep it alive indefinitely through
  normal use. If someone ever stops getting replies after a long silence, hit
  `/seed` again to re-open their channel.
- **Cost:** pay-per-text, no monthly fee — check https://textbelt.com/purchase/
  for current rates. For a household's worth of chore texts, this should be a
  small amount per month.
- **Changing the chores or rotation logic:** edit the `CHORES` object and the
  keyword lists near the top of `server.js`.

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
