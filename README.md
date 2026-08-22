# House Chore Bot (SMS)

A small bot for a 3-person household. Any of the 3 housemates can text it a chore
name and it will remind whoever's turn it is via SMS. Turns rotate round-robin
each time someone marks a chore "done".

Chores tracked: **vacuuming**, **cleaning the bathroom**, **cleaning the balcony**,
**taking out the trash**.

## How it works once it's live

Text the bot's phone number:

| You send | Bot does |
|---|---|
| `trash` / `vacuuming` / `bathroom` / `balcony` | Texts whoever's turn it currently is for that chore |
| `trash done` | Marks that chore complete and passes the turn to the next person |
| `status` | Replies with whose turn it is for all 4 chores |
| `help` | Shows a quick command reference |

No app to install for your housemates — it's a normal text message thread.

---

## Setup

You'll do two things: (1) get a Twilio phone number for sending/receiving SMS,
and (2) deploy this code somewhere it can run 24/7 (Render's free tier).

### Step 1 — Buy a Twilio phone number

You already have a paid Twilio account, so this is quick and needs no approval wait:

1. In the Twilio Console, go to **Phone Numbers → Buy a number** (or search "buy a number").
2. Make sure **SMS** capability is checked as a filter, pick any number in your country
   (US numbers are typically ~$1.15/month), and buy it.
3. Note the number in E.164 format, e.g. `+15551230000`.

### Step 2 — Get your Account SID and Auth Token

From the Twilio Console home page (console.twilio.com), copy your **Account SID**
and **Auth Token**. (If you already grabbed these earlier, they don't change when
you buy a number.)

### Step 3 — Get everyone's phone numbers

Write down each housemate's number in E.164 format, e.g. `+15551234567` — no
spaces, dashes, or `whatsapp:` prefix this time, since this is plain SMS.

### Step 4 — Put this code on GitHub

Render deploys from a Git repository.

1. Create a free GitHub account if you don't have one: https://github.com/signup
2. Create a new **private** repository (e.g. `house-chore-bot`).
3. Upload the contents of this folder to that repository. Do **not** upload a
   real `.env` file if you create one locally — only `.env.example` should go
   in the repo.

### Step 5 — Deploy to Render (free tier)

1. Create a free account at https://render.com (you can sign up with GitHub).
2. Click **New → Web Service** and connect the GitHub repo from Step 4.
3. Confirm:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance Type:** Free
4. Under **Environment**, add these variables:

   | Key | Value |
   |---|---|
   | `TWILIO_ACCOUNT_SID` | your Account SID |
   | `TWILIO_AUTH_TOKEN` | your Auth Token |
   | `TWILIO_PHONE_NUMBER` | the number you bought, e.g. `+15551230000` |
   | `PERSON_1_NAME` | e.g. `Alex` |
   | `PERSON_1_NUMBER` | e.g. `+15551234567` |
   | `PERSON_2_NAME` | e.g. `Sam` |
   | `PERSON_2_NUMBER` | e.g. `+15551234568` |
   | `PERSON_3_NAME` | e.g. `Jordan` |
   | `PERSON_3_NUMBER` | e.g. `+15551234569` |

5. Click **Create Web Service**. Wait for the deploy to finish — you'll get a
   URL like `https://house-chore-bot.onrender.com`.

### Step 6 — Point Twilio at your deployed bot

1. In the Twilio Console, go to **Phone Numbers → Manage → Active Numbers** and
   click the number you bought.
2. Scroll to the **Messaging Configuration** section.
3. Set **"A message comes in"** to **Webhook**, and enter:
   `https://house-chore-bot.onrender.com/webhook`, method `POST`.
4. Save.

### Step 7 — Test it

From any of the 3 housemates' phones, text the bot's number something like
`trash` or `status`. You should get a reply within a few seconds.

---

## Notes and limitations

- **Free Render tier sleeps after inactivity.** The first message after a quiet
  period may take ~30–50 seconds to get a reply while the server wakes up.
  Later messages are fast.
- **State resets on redeploy.** Whose-turn-is-it is stored in `state.json` on
  the server's disk. It survives normal restarts/sleep, but a fresh deploy
  resets rotation back to the starting order. If this bothers you, ask and
  a small free database (e.g. Render's free Postgres, or Upstash Redis) can
  be added for true persistence.
- **Cost:** roughly $1/month for the phone number, plus about $0.0079 per
  SMS segment sent (US pricing) — for a household's worth of chore texts,
  that's typically under $1–2/month total.
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
  -d "From=+15551234567" \
  -d "Body=status"
```
