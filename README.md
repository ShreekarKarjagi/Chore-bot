# House Chore Bot (WhatsApp)

A small bot for a 3-person household. Any of the 3 housemates can message it a chore
name and it will remind whoever's turn it is via WhatsApp. Turns rotate round-robin
each time someone marks a chore "done".

Chores tracked: **vacuuming**, **cleaning the bathroom**, **cleaning the balcony**,
**taking out the trash**.

## How it works once it's live

Text the bot's WhatsApp number:

| You send | Bot does |
|---|---|
| `trash` / `vacuuming` / `bathroom` / `balcony` | Sends a WhatsApp reminder to whoever's turn it currently is for that chore |
| `trash done` | Marks that chore complete and passes the turn to the next person |
| `status` | Replies with whose turn it is for all 4 chores |
| `help` | Shows a quick command reference |

No app to install for your housemates — it's just WhatsApp.

---

## Setup (about 20–30 minutes, free)

You'll do two things: (1) create a free Twilio account for WhatsApp messaging,
and (2) deploy this code somewhere it can run 24/7 (Render's free tier).

### Step 1 — Create a Twilio account

1. Go to https://www.twilio.com/try-twilio and sign up (free trial, no charge
   for what this bot needs).
2. Verify your email and phone number when prompted.
3. From the Twilio Console dashboard (https://console.twilio.com), copy your
   **Account SID** and **Auth Token** — you'll need these shortly. Keep this tab open.

### Step 2 — Turn on the WhatsApp Sandbox

Twilio's free trial includes a shared WhatsApp "sandbox" number that's perfect for
a household bot like this.

1. In the Twilio Console, go to **Messaging → Try it out → Send a WhatsApp message**
   (or search "WhatsApp sandbox" in the console search bar).
2. You'll see a sandbox number (usually `+1 415 523 8886`) and a join code that
   looks like `join <two-words>`.
3. **Each of the 3 housemates** must send that exact `join <two-words>` message
   to that number from their own WhatsApp, once. This opts each phone into the
   sandbox so the bot can message them. (This is a one-time step per phone;
   sandbox participation lasts a while and just needs occasional renewal if
   Twilio prompts for it.)

### Step 3 — Get everyone's WhatsApp numbers

Write down each housemate's phone number in international format, e.g.
`+15551234567`. You'll enter these as `whatsapp:+15551234567` in Step 5.

### Step 4 — Put this code on GitHub

Render deploys from a Git repository, so this project needs to live in one.

1. Create a free GitHub account if you don't have one: https://github.com/signup
2. Create a new **private** repository (e.g. `house-chore-bot`).
3. Upload the contents of this folder to that repository (via GitHub's web
   "upload files" button is easiest, or `git push` if you're comfortable with git).
   Do **not** upload your real `.env` file if you create one locally — only
   `.env.example` should go in the repo.

### Step 5 — Deploy to Render (free tier)

1. Create a free account at https://render.com (you can sign up with GitHub).
2. Click **New → Web Service** and connect the GitHub repo from Step 4.
3. Render should auto-detect Node. Confirm:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Plan:** Free
4. Under **Environment**, add these variables (values from Steps 1–3):

   | Key | Value |
   |---|---|
   | `TWILIO_ACCOUNT_SID` | your Account SID |
   | `TWILIO_AUTH_TOKEN` | your Auth Token |
   | `TWILIO_WHATSAPP_NUMBER` | `whatsapp:+14155238886` (the sandbox number) |
   | `PERSON_1_NAME` | e.g. `Alex` |
   | `PERSON_1_NUMBER` | e.g. `whatsapp:+15551234567` |
   | `PERSON_2_NAME` | e.g. `Sam` |
   | `PERSON_2_NUMBER` | e.g. `whatsapp:+15551234568` |
   | `PERSON_3_NAME` | e.g. `Jordan` |
   | `PERSON_3_NUMBER` | e.g. `whatsapp:+15551234569` |

5. Click **Create Web Service**. Wait for the deploy to finish — Render will
   give you a URL like `https://house-chore-bot.onrender.com`.

### Step 6 — Point Twilio at your deployed bot

1. Back in the Twilio Console's WhatsApp Sandbox settings, find the field
   **"WHEN A MESSAGE COMES IN"**.
2. Set it to: `https://house-chore-bot.onrender.com/webhook` (use your actual
   Render URL) with method `POST`.
3. Save.

### Step 7 — Test it

From any of the 3 phones (that joined the sandbox in Step 2), send the sandbox
number a message like `trash` or `status`. You should get a reply within a
few seconds, and — for a chore reminder — the assigned person should get a
separate WhatsApp message.

---

## Notes and limitations

- **Free Render tier sleeps after inactivity.** The first message after a quiet
  period may take ~30–50 seconds to get a reply while the server wakes up.
  Later messages are fast. This is normal on the free tier.
- **State resets on redeploy.** Whose-turn-is-it is stored in `state.json` on
  the server's disk. It survives normal restarts/sleep, but a fresh deploy
  (e.g. pushing new code) resets rotation back to the starting order. Fine for
  occasional tweaks; if this bothers you, the next step up is swapping the
  file storage for a small free database (e.g. Render's free Postgres, or
  Upstash Redis) — ask and this can be added.
- **Twilio Sandbox is free but has caveats:** each participant needs to
  re-join the sandbox periodically (Twilio will show a reminder), and it's
  meant for testing/personal use rather than a public product. For a
  permanent, no-rejoin setup, Twilio also offers a paid WhatsApp Business
  number — not necessary for a 3-person household bot.
- **Changing the chores or rotation logic:** edit the `CHORES` object and the
  keyword lists near the top of `server.js`.

## Local testing (optional)

```bash
npm install
cp .env.example .env   # then fill in real values
npm start
```

Then simulate an incoming message without needing Twilio or a phone:

```bash
curl -X POST http://localhost:3000/webhook \
  -d "From=whatsapp:+15551234567" \
  -d "Body=status"
```
