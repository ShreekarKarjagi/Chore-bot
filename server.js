// House Chore Bot
// An SMS bot (via Textbelt — no business/carrier registration required) that
// reminds housemates whose turn it is to do a chore, and rotates turns
// round-robin as chores get marked done.

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

// Capture the raw JSON body (needed to verify Textbelt's webhook signature,
// which is computed over the exact raw bytes Textbelt sent).
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, 'state.json');

// ---------------------------------------------------------------------
// 1. Configure the 3 housemates and the 4 chores
// ---------------------------------------------------------------------

// Each person is identified by their phone number in E.164 format,
// e.g. "+15551234567". Set these via environment variables.
const PEOPLE = [
  { name: process.env.PERSON_1_NAME || 'Person 1', number: process.env.PERSON_1_NUMBER },
  { name: process.env.PERSON_2_NAME || 'Person 2', number: process.env.PERSON_2_NUMBER },
  { name: process.env.PERSON_3_NAME || 'Person 3', number: process.env.PERSON_3_NUMBER },
].filter((p) => p.number);

if (PEOPLE.length !== 3) {
  console.warn(
    `WARNING: Expected 3 people with phone numbers configured, found ${PEOPLE.length}. ` +
    `Set PERSON_1_NAME/PERSON_1_NUMBER, PERSON_2_NAME/PERSON_2_NUMBER, PERSON_3_NAME/PERSON_3_NUMBER in your .env`
  );
}

// Chore definitions: id -> { label, keywords[] }
// The bot matches an incoming message against these keywords (case-insensitive substring match).
const CHORES = {
  vacuuming: { label: 'Vacuuming', keywords: ['vacuum', 'vacuuming', 'hoover'] },
  bathroom: { label: 'Cleaning the bathroom', keywords: ['bathroom', 'toilet'] },
  balcony: { label: 'Cleaning the balcony', keywords: ['balcony', 'patio'] },
  trash: { label: 'Taking out the trash', keywords: ['trash', 'garbage', 'rubbish', 'bins', 'bin'] },
};

// ---------------------------------------------------------------------
// 2. Persisted rotation state
// ---------------------------------------------------------------------
// state.turn[choreId] = index into PEOPLE array = whose turn it currently is.
// Rotation order is the same for every chore: PEOPLE[0] -> PEOPLE[1] -> PEOPLE[2] -> repeat.

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
      console.error('Failed to parse state.json, starting fresh:', e);
    }
  }
  const fresh = { turn: {}, seeded: [], lastAutoSent: {} };
  Object.keys(CHORES).forEach((choreId, i) => {
    // Stagger starting turns so nobody is dead last on everything by coincidence.
    fresh.turn[choreId] = i % Math.max(PEOPLE.length, 1);
  });
  return fresh;
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let state = loadState();
if (!state.seeded) state.seeded = [];
if (!state.lastAutoSent) state.lastAutoSent = {};

function whoseTurn(choreId) {
  const idx = state.turn[choreId] ?? 0;
  return PEOPLE[idx];
}

function advanceTurn(choreId) {
  const idx = state.turn[choreId] ?? 0;
  const nextIdx = (idx + 1) % PEOPLE.length;
  state.turn[choreId] = nextIdx;
  saveState(state);
  return PEOPLE[nextIdx];
}

// ---------------------------------------------------------------------
// 3. Message parsing
// ---------------------------------------------------------------------

function findChoreInText(text) {
  const lower = text.toLowerCase();
  for (const [choreId, chore] of Object.entries(CHORES)) {
    if (chore.keywords.some((kw) => lower.includes(kw))) {
      return choreId;
    }
  }
  return null;
}

function isDoneMessage(text) {
  return /\bdone\b|\bfinished\b|\bcompleted?\b/i.test(text);
}

function isStatusRequest(text) {
  return /\b(status|chores|list|whose turn|who'?s turn)\b/i.test(text.toLowerCase());
}

function isHelpRequest(text) {
  return /\bhelp\b/i.test(text.toLowerCase());
}

// Normalize any phone number format down to a bare digit string so we can
// reliably match numbers coming back from Textbelt against our configured
// PEOPLE list, regardless of formatting differences (+1, spaces, etc).
function normalizeNumber(num) {
  if (!num) return '';
  const digits = String(num).replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') return digits.slice(1);
  return digits;
}

function findPersonByNumber(number) {
  const target = normalizeNumber(number);
  return PEOPLE.find((p) => normalizeNumber(p.number) === target);
}

function statusMessage() {
  const lines = Object.entries(CHORES).map(([choreId, chore]) => {
    const person = whoseTurn(choreId);
    return `- ${chore.label}: ${person ? person.name : 'unassigned'}`;
  });
  return `🏠 Chore status:\n${lines.join('\n')}`;
}

function helpMessage() {
  return (
    `🏠 House Chore Bot\n\n` +
    `Text me a chore name (e.g. "trash", "vacuuming", "bathroom", "balcony") ` +
    `and I'll remind whoever's turn it is.\n\n` +
    `Text "<chore> done" (e.g. "trash done") when it's finished to pass the turn to the next person.\n\n` +
    `Text "status" any time to see whose turn it is for everything.`
  );
}

// ---------------------------------------------------------------------
// 4. Textbelt client for sending messages
// ---------------------------------------------------------------------

const TEXTBELT_API_KEY = process.env.TEXTBELT_API_KEY;
// Your deployed base URL, e.g. "https://house-chore-bot.onrender.com" (no trailing slash).
const WEBHOOK_BASE_URL = (process.env.WEBHOOK_BASE_URL || '').replace(/\/+$/, '');

// TEST_MODE: when enabled, every outbound message is redirected to
// TEST_NUMBER instead of its real recipient, so testing/debugging only ever
// spends credits on one number. The original intended recipient is noted in
// the message itself so you can still tell what would have happened.
const TEST_MODE = /^(1|true|yes)$/i.test(process.env.TEST_MODE || '');
const TEST_NUMBER = process.env.TEST_NUMBER || process.env.PERSON_1_NUMBER;
if (TEST_MODE) {
  console.log(`TEST_MODE is ON — all outbound SMS will be redirected to ${TEST_NUMBER}`);
}

function toTextbeltPhone(num) {
  const trimmed = String(num || '').trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') return digits.slice(1);
  if (trimmed.startsWith('+') && !trimmed.startsWith('+1')) return trimmed; // international, keep E.164
  return digits;
}

async function sendSMS(toNumber, message) {
  if (!TEXTBELT_API_KEY) {
    console.warn('TEXTBELT_API_KEY not configured; would have sent:', toNumber, message);
    return;
  }

  let actualTo = toNumber;
  let actualMessage = message;
  if (TEST_MODE && normalizeNumber(toNumber) !== normalizeNumber(TEST_NUMBER)) {
    actualTo = TEST_NUMBER;
    actualMessage = `[TEST — would go to ${toNumber}] ${message}`;
  }

  const params = new URLSearchParams();
  params.set('phone', toTextbeltPhone(actualTo));
  params.set('message', actualMessage);
  params.set('key', TEXTBELT_API_KEY);
  if (WEBHOOK_BASE_URL) {
    // Re-arm the reply channel every time we message someone, so their next
    // text back (whenever that is) keeps routing to our webhook.
    params.set('replyWebhookUrl', `${WEBHOOK_BASE_URL}/webhook`);
  }

  console.log(`Sending SMS to ${actualTo}: ${actualMessage}`);
  try {
    const res = await fetch('https://textbelt.com/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json();
    if (!data.success) {
      console.error('Textbelt send failed:', data);
    } else {
      console.log('Textbelt send OK, quotaRemaining:', data.quotaRemaining);
    }
    return data;
  } catch (err) {
    // Network error, Textbelt outage, bad response body, etc. Never let a
    // failed send crash the server — just log it and move on.
    console.error('Textbelt request threw:', err.message);
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------
// 5. Webhook signature verification
// ---------------------------------------------------------------------

function verifyTextbeltSignature(req) {
  if (!TEXTBELT_API_KEY) {
    console.warn('[sig] TEXTBELT_API_KEY is not set on this server — cannot verify anything.');
    return false;
  }
  const signature = req.headers['x-textbelt-signature'];
  const timestamp = req.headers['x-textbelt-timestamp'];
  console.log('[sig] headers present?', { signature: !!signature, timestamp: !!timestamp, rawBody: !!req.rawBody });
  console.log('[sig] rawBody:', req.rawBody);
  console.log('[sig] TEXTBELT_API_KEY length/prefix:', TEXTBELT_API_KEY.length, JSON.stringify(TEXTBELT_API_KEY.slice(0, 4)));

  if (!signature || !timestamp || !req.rawBody) {
    console.warn('[sig] missing signature, timestamp, or rawBody');
    return false;
  }

  // Reject requests with a stale timestamp (older than 15 minutes).
  // The header is a standard Unix timestamp in SECONDS (10 digits), not
  // milliseconds — multiply by 1000 before comparing against Date.now().
  const ageMs = Date.now() - Number(timestamp) * 1000;
  if (!Number.isFinite(ageMs) || Math.abs(ageMs) > 15 * 60 * 1000) {
    console.warn('[sig] timestamp check failed, ageMs =', ageMs, 'raw timestamp header =', timestamp);
    return false;
  }

  const expected = crypto
    .createHmac('sha256', TEXTBELT_API_KEY)
    .update(timestamp + req.rawBody)
    .digest('hex');

  console.log('[sig] received signature:', signature);
  console.log('[sig] expected signature:', expected);

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (e) {
    console.warn('[sig] timingSafeEqual threw (likely length mismatch):', e.message, 'sigLen:', signature.length, 'expectedLen:', expected.length);
    return false; // length mismatch etc.
  }
}

// ---------------------------------------------------------------------
// 6. Webhook — Textbelt POSTs here when someone replies
// ---------------------------------------------------------------------

app.post('/webhook', async (req, res) => {
  if (!verifyTextbeltSignature(req)) {
    console.warn('Rejected webhook with invalid/missing signature');
    return res.status(401).send('invalid signature');
  }

  const { fromNumber, text } = req.body || {};
  const body = (text || '').trim();

  // Acknowledge Textbelt immediately; we send any reply as a separate outbound SMS.
  res.status(200).send('ok');

  const sender = findPersonByNumber(fromNumber);
  const senderName = sender ? sender.name : 'Someone';
  const replyTo = fromNumber;

  try {
    if (!body || isHelpRequest(body)) {
      await sendSMS(replyTo, helpMessage());
      return;
    }
    if (isStatusRequest(body)) {
      await sendSMS(replyTo, statusMessage());
      return;
    }

    const choreId = findChoreInText(body);

    if (!choreId) {
      await sendSMS(replyTo, `I didn't recognize a chore in that message. ${helpMessage()}`);
      return;
    }

    if (isDoneMessage(body)) {
      const next = advanceTurn(choreId);
      await sendSMS(replyTo, `✅ Marked "${CHORES[choreId].label}" as done. Next up: ${next.name}.`);
      if (normalizeNumber(next.number) !== normalizeNumber(fromNumber)) {
        await sendSMS(next.number, `🏠 Heads up ${next.name} — it's your turn for: ${CHORES[choreId].label}.`);
      }
      return;
    }

    // Reminder request
    const person = whoseTurn(choreId);
    if (!person) {
      await sendSMS(replyTo, `No one is configured for that chore yet.`);
      return;
    }
    if (normalizeNumber(person.number) !== normalizeNumber(fromNumber)) {
      await sendSMS(person.number, `🏠 Reminder from ${senderName}: it's your turn to do — ${CHORES[choreId].label}.`);
      await sendSMS(replyTo, `Got it — I reminded ${person.name} to handle "${CHORES[choreId].label}".`);
    } else {
      await sendSMS(replyTo, `Looks like it's already your turn for "${CHORES[choreId].label}" — go get 'em!`);
    }
  } catch (err) {
    console.error('Error handling message:', err);
    await sendSMS(replyTo, 'Sorry, something went wrong handling that. Please try again.').catch(() => {});
  }
});

// ---------------------------------------------------------------------
// 7. Scheduled reminders — hardcoded weekly times per chore
// ---------------------------------------------------------------------
// Edit SCHEDULE below to set which day(s) and time(s) each chore should
// automatically remind whoever's turn it is, no incoming text required.
//   day:  'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'
//   time: 24-hour "HH:MM", interpreted in TIMEZONE below
// A chore can have more than one entry per week (e.g. trash twice a week).
// These are placeholder defaults — edit them to match your household.

const TIMEZONE = process.env.TIMEZONE || 'America/Los_Angeles';

const SCHEDULE = {
  vacuuming: [{ day: 'sat', time: '10:00' }],
  bathroom: [{ day: 'wed', time: '18:00' }],
  balcony: [{ day: 'sun', time: '11:00' }],
  trash: [
    { day: 'mon', time: '08:00' },
    { day: 'thu', time: '08:00' },
  ],
};

// Precompute {hour, minute} once at startup instead of re-parsing the
// "HH:MM" string on every check.
function parseHHMM(str) {
  const [hour, minute] = String(str).split(':').map((n) => parseInt(n, 10));
  return { hour, minute };
}
const SCHEDULE_PARSED = {};
for (const [choreId, entries] of Object.entries(SCHEDULE)) {
  SCHEDULE_PARSED[choreId] = entries.map((e) => ({ day: e.day, ...parseHHMM(e.time) }));
}

// Get the current local weekday/hour/minute/date in TIMEZONE. Uses the
// platform's ICU timezone database (via Intl) rather than manual UTC offset
// math, so daylight saving transitions are handled automatically instead of
// silently going an hour off twice a year.
function getLocalParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0; // some locales render midnight as "24" instead of "00"
  return {
    weekday: parts.weekday.toLowerCase().slice(0, 3), // 'sun', 'mon', ...
    hour,
    minute: parseInt(parts.minute, 10),
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

// Figure out which reminders are due right now, grouped by PERSON so anyone
// with 2+ chores due in the same minute gets ONE combined text instead of
// several — this is the main way the scheduler keeps API usage efficient.
// Pure function of (now, state) so it can be tested with a fixed date
// instead of waiting on the real clock.
function findDueReminders(now) {
  const { weekday, hour, minute, dateStr } = getLocalParts(now, TIMEZONE);
  const duePerPerson = new Map(); // number -> { name, chores: [...], slotKeys: [{slotKey, dateStr}] }

  for (const [choreId, entries] of Object.entries(SCHEDULE_PARSED)) {
    for (const entry of entries) {
      if (entry.day !== weekday || entry.hour !== hour || entry.minute !== minute) continue;

      const slotKey = `${choreId}|${entry.day}|${String(entry.hour).padStart(2, '0')}:${String(entry.minute).padStart(2, '0')}`;
      // Already sent for this exact calendar occurrence? Skip — prevents a
      // duplicate send if the ticker fires more than once inside the same
      // minute, or the server restarts right at the boundary.
      if (state.lastAutoSent[slotKey] === dateStr) continue;

      const person = whoseTurn(choreId);
      if (!person) continue;

      if (!duePerPerson.has(person.number)) {
        duePerPerson.set(person.number, { name: person.name, chores: [], slotKeys: [] });
      }
      const forPerson = duePerPerson.get(person.number);
      forPerson.chores.push(CHORES[choreId].label);
      forPerson.slotKeys.push({ slotKey, dateStr });
    }
  }

  return duePerPerson;
}

function joinWithAnd(items) {
  if (items.length === 1) return items[0];
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

async function runScheduledReminders(now = new Date()) {
  try {
    const due = findDueReminders(now);
    if (due.size === 0) return;

    for (const [number, info] of due.entries()) {
      const message = `🏠 Reminder ${info.name} — today it's your turn for: ${joinWithAnd(info.chores)}.`;
      const result = await sendSMS(number, message);

      // Only mark these slots as sent if the send actually succeeded.
      // Marking on failure would permanently suppress that reminder for the
      // week with no way to recover; leaving it unmarked means a restart
      // that re-ticks the same minute will retry it.
      if (result && result.success) {
        for (const { slotKey, dateStr } of info.slotKeys) {
          state.lastAutoSent[slotKey] = dateStr;
        }
      } else {
        console.error(`Scheduled reminder to ${info.name} failed to send — not marked, will not retry until next scheduled slot.`);
      }
    }

    saveState(state);
  } catch (err) {
    // A bug here should never take down the whole server — just skip this
    // tick and try again next minute.
    console.error('Error running scheduled reminders:', err);
  }
}

// Tracks when the scheduler last actually ran, so the status dashboard can
// show real evidence it's alive rather than just assuming so.
let lastTickAt = null;

// Compute the next future occurrence of a single schedule entry, for display
// purposes only (not used by the actual due-check, which only cares about
// exact-minute matches). Brute-forces forward minute by minute for up to a
// week — simple and obviously correct rather than clever, since a subtle bug
// here would only affect a status display, not any real behavior.
function computeNextOccurrence(entry, from, timeZone) {
  const start = new Date(Math.ceil(from.getTime() / 60000) * 60000); // round up to next minute
  for (let i = 0; i <= 7 * 24 * 60; i++) {
    const candidate = new Date(start.getTime() + i * 60000);
    const { weekday, hour, minute } = getLocalParts(candidate, timeZone);
    if (weekday === entry.day && hour === entry.hour && minute === entry.minute) {
      return candidate;
    }
  }
  return null; // should be unreachable given a valid entry
}

// Check once a minute. runScheduledReminders() already catches its own
// errors; this wrapper is an extra safety net on top of that.
const SCHEDULER_INTERVAL_MS = 60 * 1000;
setInterval(() => {
  lastTickAt = new Date();
  runScheduledReminders(lastTickAt).catch((err) => console.error('Unexpected scheduler error:', err));
}, SCHEDULER_INTERVAL_MS);

// Read-only debug endpoint: check what the scheduler would do at a given
// moment, without sending anything or changing state. Useful for confirming
// your SCHEDULE and TIMEZONE are set up the way you expect.
// e.g. /debug/schedule?secret=...&at=2026-08-25T15:00:00Z
app.get('/debug/schedule', (req, res) => {
  const secret = process.env.SEED_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(403).send('forbidden');
  }
  const at = req.query.at ? new Date(req.query.at) : new Date();
  if (Number.isNaN(at.getTime())) {
    return res.status(400).json({ error: 'invalid ?at= timestamp — use ISO format, e.g. 2026-08-25T15:00:00Z' });
  }
  const due = findDueReminders(at);
  res.json({
    now: at.toISOString(),
    timezone: TIMEZONE,
    local: getLocalParts(at, TIMEZONE),
    due: Array.from(due.entries()).map(([number, info]) => ({ number, name: info.name, chores: info.chores })),
  });
});

// Manually fire the scheduler right now (or for a simulated time via ?at=).
// Unlike /debug/schedule, this ACTUALLY sends messages and updates state —
// useful for testing the real send-and-mark path without waiting for the
// clock to hit an exact scheduled minute, or for manually re-sending a
// reminder you missed. Respects TEST_MODE like everything else.
app.post('/debug/trigger-schedule', async (req, res) => {
  const secret = process.env.SEED_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(403).send('forbidden');
  }
  const at = req.query.at ? new Date(req.query.at) : new Date();
  if (Number.isNaN(at.getTime())) {
    return res.status(400).json({ error: 'invalid ?at= timestamp — use ISO format, e.g. 2026-08-25T15:00:00Z' });
  }
  try {
    await runScheduledReminders(at);
    res.json({ ranAt: at.toISOString(), lastAutoSent: state.lastAutoSent });
  } catch (err) {
    console.error('Error in /debug/trigger-schedule:', err);
    res.status(500).json({ error: 'Something went wrong — check server logs.' });
  }
});

// ---------------------------------------------------------------------
// 8. One-time seed endpoint
// ---------------------------------------------------------------------
// Textbelt only routes future texts to your webhook once a reply channel has
// been opened with that number. Hit this once after deploying (from a
// browser, with your secret) to text all 3 people and arm their channels.

app.get('/seed', async (req, res) => {
  const secret = process.env.SEED_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(403).send('forbidden');
  }
  try {
    // In TEST_MODE, only seed the one test person — sendSMS() would redirect
    // the other two anyway, but skipping them here avoids spending 3 credits
    // to deliver 1 actual text.
    const peopleToSeed = TEST_MODE
      ? PEOPLE.filter((p) => normalizeNumber(p.number) === normalizeNumber(TEST_NUMBER))
      : PEOPLE;

    const results = [];
    for (const person of peopleToSeed) {
      const r = await sendSMS(
        person.number,
        `👋 Hi ${person.name}, this is your house chore bot! Text me a chore name ("trash", "vacuuming", "bathroom", "balcony") anytime, or "status" to see whose turn it is.`
      );
      results.push({ person: person.name, success: r && r.success });
      if (!state.seeded.includes(person.number)) {
        state.seeded.push(person.number);
      }
    }
    saveState(state);
    res.json({ seeded: results, testMode: TEST_MODE });
  } catch (err) {
    console.error('Error in /seed:', err);
    res.status(500).json({ error: 'Something went wrong seeding — check server logs.' });
  }
});

// ---------------------------------------------------------------------
// 9. Status dashboard
// ---------------------------------------------------------------------
// A single data function feeds both the HTML dashboard and the JSON
// endpoint, so the two views can't drift out of sync with each other.
// Deliberately excludes phone numbers and secrets — this page has no auth
// (it also serves as Render's health check target), so nothing sensitive
// belongs on it. Actions that actually send messages stay behind the
// existing SEED_SECRET-protected endpoints.

function buildStatusData() {
  const now = new Date();
  const local = getLocalParts(now, TIMEZONE);

  const schedulerActive = lastTickAt !== null && Date.now() - lastTickAt.getTime() < SCHEDULER_INTERVAL_MS * 1.5;

  const chores = Object.entries(CHORES).map(([choreId, chore]) => {
    const person = whoseTurn(choreId);
    const entries = SCHEDULE[choreId] || [];
    const parsedEntries = SCHEDULE_PARSED[choreId] || [];
    const nextDates = parsedEntries
      .map((e) => computeNextOccurrence(e, now, TIMEZONE))
      .filter(Boolean)
      .sort((a, b) => a - b);
    const next = nextDates[0] || null;

    return {
      id: choreId,
      label: chore.label,
      currentTurn: person ? person.name : 'unassigned',
      scheduleText: entries.map((e) => `${e.day} ${e.time}`).join(', ') || 'not scheduled',
      nextReminder: next
        ? next.toLocaleString('en-US', { timeZone: TIMEZONE, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : null,
    };
  });

  return {
    serverTimeISO: now.toISOString(),
    timezone: TIMEZONE,
    localTimeText: `${local.weekday} ${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`,
    testMode: TEST_MODE,
    textbeltConfigured: !!TEXTBELT_API_KEY,
    webhookBaseUrlConfigured: !!WEBHOOK_BASE_URL,
    webhookBaseUrl: WEBHOOK_BASE_URL || null,
    peopleConfiguredCount: PEOPLE.length,
    peopleNames: PEOPLE.map((p) => p.name),
    seededCount: state.seeded.length,
    schedulerActive,
    schedulerLastTickISO: lastTickAt ? lastTickAt.toISOString() : null,
    chores,
  };
}

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderDashboardHTML(data) {
  const statusDot = (ok) => (ok ? '🟢' : '🔴');

  const configRows = [
    [statusDot(data.textbeltConfigured), 'Textbelt API key', data.textbeltConfigured ? 'configured' : 'MISSING — sends will fail'],
    [statusDot(data.webhookBaseUrlConfigured), 'Webhook base URL', data.webhookBaseUrlConfigured ? escapeHTML(data.webhookBaseUrl) : 'MISSING — replies can\'t reach this server'],
    [statusDot(data.peopleConfiguredCount === 3), 'Housemates configured', `${data.peopleConfiguredCount} / 3 (${escapeHTML(data.peopleNames.join(', ') || 'none')})`],
    [statusDot(data.seededCount > 0), 'Reply channels seeded', `${data.seededCount} / ${data.peopleConfiguredCount}${data.seededCount === 0 ? ' — run /seed' : ''}`],
    [statusDot(data.schedulerActive), 'Automatic reminders', data.schedulerActive ? `active — last checked ${escapeHTML(data.schedulerLastTickISO)}` : 'not confirmed active yet (server just started, or something is wrong — wait a minute and refresh)'],
    [data.testMode ? '🧪' : '⚪', 'Test mode', data.testMode ? 'ON — all sends redirected to TEST_NUMBER' : 'off — sends go to real recipients'],
  ];

  const choreRows = data.chores
    .map(
      (c) => `
      <tr>
        <td>${escapeHTML(c.label)}</td>
        <td><strong>${escapeHTML(c.currentTurn)}</strong></td>
        <td>${escapeHTML(c.scheduleText)}</td>
        <td>${c.nextReminder ? escapeHTML(c.nextReminder) : '—'}</td>
      </tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>House Chore Bot — Status</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  .subtitle { color: #777; margin-top: 0; margin-bottom: 1.5rem; font-size: 0.9rem; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; }
  th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid rgba(128,128,128,0.25); font-size: 0.92rem; }
  th { font-weight: 600; color: #888; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em; }
  section { margin-bottom: 2rem; }
  h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: 0.03em; color: #888; margin-bottom: 0.5rem; }
  .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
  input[type="password"] { padding: 0.5rem; border-radius: 6px; border: 1px solid rgba(128,128,128,0.4); font-size: 0.9rem; }
  button { padding: 0.5rem 0.9rem; border-radius: 6px; border: 1px solid rgba(128,128,128,0.4); background: rgba(128,128,128,0.08); cursor: pointer; font-size: 0.9rem; }
  button:hover { background: rgba(128,128,128,0.18); }
  #actionResult { margin-top: 0.75rem; font-size: 0.85rem; white-space: pre-wrap; font-family: ui-monospace, monospace; background: rgba(128,128,128,0.08); padding: 0.6rem; border-radius: 6px; display: none; }
  footer { color: #999; font-size: 0.8rem; margin-top: 2rem; }
</style>
</head>
<body>
  <h1>🏠 House Chore Bot</h1>
  <p class="subtitle">Local time: ${escapeHTML(data.localTimeText)} (${escapeHTML(data.timezone)}) · Server time: ${escapeHTML(data.serverTimeISO)}</p>

  <section>
    <h2>System health</h2>
    <table>
      ${configRows.map(([dot, label, value]) => `<tr><td style="width:1.6rem">${dot}</td><td>${escapeHTML(label)}</td><td>${value}</td></tr>`).join('')}
    </table>
  </section>

  <section>
    <h2>Chore status</h2>
    <table>
      <tr><th>Chore</th><th>Whose turn</th><th>Schedule</th><th>Next auto-reminder</th></tr>
      ${choreRows}
    </table>
  </section>

  <section>
    <h2>Quick actions</h2>
    <p style="font-size:0.85rem; color:#888;">These send real messages (or nothing, in TEST_MODE). Enter your SEED_SECRET to use them.</p>
    <div class="actions">
      <input type="password" id="secretInput" placeholder="secret">
      <button onclick="runAction('/seed', 'GET')">Run /seed</button>
      <button onclick="runAction('/debug/trigger-schedule', 'POST')">Trigger scheduler now</button>
      <button onclick="runAction('/debug/schedule', 'GET')">Preview schedule (read-only)</button>
    </div>
    <pre id="actionResult"></pre>
  </section>

  <footer>This page has no login — don't share this URL publicly. It intentionally shows no phone numbers.</footer>

  <script>
    async function runAction(path, method) {
      const secret = document.getElementById('secretInput').value;
      const resultEl = document.getElementById('actionResult');
      resultEl.style.display = 'block';
      resultEl.textContent = 'Working...';
      try {
        const res = await fetch(path + '?secret=' + encodeURIComponent(secret), { method });
        const text = await res.text();
        let pretty = text;
        try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (e) {}
        resultEl.textContent = res.status + ' ' + res.statusText + '\\n' + pretty;
      } catch (err) {
        resultEl.textContent = 'Request failed: ' + err.message;
      }
    }
  </script>
</body>
</html>`;
}

app.get('/status.json', (req, res) => {
  res.json(buildStatusData());
});

// Root: the status dashboard. Also serves as the health check target for
// Render (or any other host) — it returns 200 regardless of bot health, so
// the underlying issues (config, scheduler) are surfaced ON the page rather
// than as a failed health check.
app.get('/', (req, res) => {
  res.type('html').send(renderDashboardHTML(buildStatusData()));
});

app.listen(PORT, () => {
  console.log(`House Chore Bot listening on port ${PORT}`);
  console.log('Configured people:', PEOPLE.map((p) => `${p.name} <${p.number}>`).join(', '));
  if (!WEBHOOK_BASE_URL) {
    console.warn('WEBHOOK_BASE_URL is not set — replies from Textbelt will not be able to reach this server.');
  }
});

// Last-resort safety net: log unexpected errors instead of letting the
// process crash and get stuck in a restart loop on the host.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
