# House Chore Bot

A text-message bot for a 3-person household, built so nobody has to remember whose turn it is to take out the trash. Text it a chore name and it tells you who's on the hook; it also texts people on its own on a weekly schedule, so reminders happen without anyone having to ask.

I built this using **Textbelt**, Chores tracked out of the box: **vacuuming**, **cleaning the bathroom**, **cleaning the balcony**, **taking out the trash** — plus anything else you add from the dashboard.

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


## Under the hood

This is a small, deliberately simple app — one `server.js` file, Node.js and Express, with `state.json` on disk holding the schedule and whose turn it is. No database, no framework beyond Express, because a household chore list doesn't need one.

A few things worth calling out if you're looking at the code:

- **Incoming texts are verified, not just trusted.** Textbelt signs each webhook (HMAC-SHA256), and the bot checks that signature with a timing-safe comparison and rejects anything more than 15 minutes old, so the reply endpoint can't be spoofed.
- **The "next reminder" time used to be slow, and now it isn't.** It was originally computed by brute-force checking every minute in the coming week — a real, measurable ~500ms per chore. It's now computed with a much smarter day-and-offset search that lands on the exact same answer, verified against the old version across 1,500+ test cases (different timezones and both daylight-saving switchovers included), and runs in well under a millisecond.
- **The dashboard patches itself instead of reloading the page** after every click — it fetches just the updated data and updates the DOM directly, which is most of why it now feels instant.


