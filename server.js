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
// 1. Configure the 3 housemates and the 4 built-in chores
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
// These 4 are permanent (built into the code). Housemates can add MORE tasks
// from the dashboard at runtime — those live in state.customChores (see
// section 2) and behave identically once added.
const CHORES = {
  vacuuming: { label: 'Vacuuming', keywords: ['vacuum', 'vacuuming', 'hoover'] },
  bathroom: { label: 'Cleaning the bathroom', keywords: ['bathroom', 'toilet'] },
  balcony: { label: 'Cleaning the balcony', keywords: ['balcony', 'patio'] },
  trash: { label: 'Taking out the trash', keywords: ['trash', 'garbage', 'rubbish', 'bins', 'bin'] },
};

// Valid schedule days, and the "HH:MM" 24-hour format shared by every
// scheduling entry point (dashboard form, /api endpoints, DEFAULT_SCHEDULE).
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Starter weekly schedule — only used to seed state.schedule the very first
// time the bot ever runs (i.e. when state.json doesn't exist yet). After
// that, state.schedule is the live, editable truth — edit it from the
// dashboard, no code changes or redeploys required.
const DEFAULT_SCHEDULE = {
  vacuuming: [{ day: 'sat', time: '10:00' }],
  bathroom: [{ day: 'wed', time: '18:00' }],
  balcony: [{ day: 'sun', time: '11:00' }],
  trash: [
    { day: 'mon', time: '08:00' },
    { day: 'thu', time: '08:00' },
  ],
};

// ---------------------------------------------------------------------
// 2. Persisted state — rotation, schedule, and dashboard-added chores
// ---------------------------------------------------------------------
// state.turn[choreId] = index into PEOPLE array = whose turn it currently is.
// Rotation order is the same for every chore: PEOPLE[0] -> PEOPLE[1] -> PEOPLE[2] -> repeat.
// state.schedule[choreId] = [{ day, time }, ...] — the live weekly schedule.
// state.customChores[choreId] = { label, keywords } — tasks added from the dashboard.

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
      console.error('Failed to parse state.json, starting fresh:', e);
    }
  }
  const fresh = {
    turn: {},
    lastAutoSent: {},
    schedule: JSON.parse(JSON.stringify(DEFAULT_SCHEDULE)),
    customChores: {},
  };
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
// Backfill defaults for state.json files written before a given feature
// existed, so upgrading never requires a manual migration step. (A leftover
// `seeded` key from older state.json files, back when there was a separate
// /seed step, is harmless and just ignored — see section 8's comment.)
if (!state.lastAutoSent) state.lastAutoSent = {};
if (!state.schedule) state.schedule = JSON.parse(JSON.stringify(DEFAULT_SCHEDULE));
if (!state.customChores) state.customChores = {};

// Merge built-in chores with any added from the dashboard. Custom chores use
// the exact same { label, keywords } shape as built-in ones, so every other
// function in this file (matching, messaging, scheduling) treats them
// identically without needing to know which is which.
function getChores() {
  return Object.assign({}, CHORES, state.customChores);
}

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
  for (const [choreId, chore] of Object.entries(getChores())) {
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
  const lines = Object.entries(getChores()).map(([choreId, chore]) => {
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

    const choreLabel = getChores()[choreId].label;

    if (isDoneMessage(body)) {
      const next = advanceTurn(choreId);
      await sendSMS(replyTo, `✅ Marked "${choreLabel}" as done. Next up: ${next.name}.`);
      if (normalizeNumber(next.number) !== normalizeNumber(fromNumber)) {
        await sendSMS(next.number, `🏠 Heads up ${next.name} — it's your turn for: ${choreLabel}.`);
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
      await sendSMS(person.number, `🏠 Reminder from ${senderName}: it's your turn to do — ${choreLabel}.`);
      await sendSMS(replyTo, `Got it — I reminded ${person.name} to handle "${choreLabel}".`);
    } else {
      await sendSMS(replyTo, `Looks like it's already your turn for "${choreLabel}" — go get 'em!`);
    }
  } catch (err) {
    console.error('Error handling message:', err);
    await sendSMS(replyTo, 'Sorry, something went wrong handling that. Please try again.').catch(() => {});
  }
});

// ---------------------------------------------------------------------
// 7. Scheduled reminders — weekly times per chore, editable at runtime
// ---------------------------------------------------------------------
// The live schedule lives in state.schedule (persisted to state.json), so it
// can be edited from the dashboard without touching code or redeploying.
// DEFAULT_SCHEDULE (section 1) only seeds it the very first time the bot runs.

const TIMEZONE = process.env.TIMEZONE || 'America/Los_Angeles';

// Precompute {hour, minute} from a stored "HH:MM" string.
function parseHHMM(str) {
  const [hour, minute] = String(str).split(':').map((n) => parseInt(n, 10));
  return { hour, minute };
}

// Recomputed on every use rather than cached at startup, since state.schedule
// can change at runtime via the dashboard — this data is tiny, so recomputing
// costs nothing.
function getScheduleParsed() {
  const parsed = {};
  for (const [choreId, entries] of Object.entries(state.schedule)) {
    parsed[choreId] = entries.map((e) => ({ day: e.day, ...parseHHMM(e.time) }));
  }
  return parsed;
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
  const chores = getChores();

  for (const [choreId, entries] of Object.entries(getScheduleParsed())) {
    for (const entry of entries) {
      if (entry.day !== weekday || entry.hour !== hour || entry.minute !== minute) continue;

      const slotKey = `${choreId}|${entry.day}|${String(entry.hour).padStart(2, '0')}:${String(entry.minute).padStart(2, '0')}`;
      // Already sent for this exact calendar occurrence? Skip — prevents a
      // duplicate send if the ticker fires more than once inside the same
      // minute, or the server restarts right at the boundary.
      if (state.lastAutoSent[slotKey] === dateStr) continue;

      const person = whoseTurn(choreId);
      if (!person) continue;
      const chore = chores[choreId];
      if (!chore) continue; // schedule entry left over from a deleted chore

      if (!duePerPerson.has(person.number)) {
        duePerPerson.set(person.number, { name: person.name, chores: [], slotKeys: [] });
      }
      const forPerson = duePerPerson.get(person.number);
      forPerson.chores.push(chore.label);
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

// Given a wall-clock date/time as the user meant it in TIMEZONE, find the
// UTC instant that renders as exactly that local time. Starts from a naive
// UTC guess and iteratively corrects using the actual UTC offset Intl
// reports for that guess — this re-derives the offset each pass instead of
// assuming a fixed one, so it stays correct across DST transitions (a
// couple of passes is always enough for it to converge).
function localWallTimeToUTC(dateStr, hour, minute, timeZone) {
  const [y, m, d] = dateStr.split('-').map((n) => parseInt(n, 10));
  let guess = new Date(Date.UTC(y, m - 1, d, hour, minute, 0));
  for (let iter = 0; iter < 3; iter++) {
    const parts = getLocalParts(guess, timeZone);
    const renderedAsUTC = Date.UTC(
      parseInt(parts.dateStr.slice(0, 4), 10),
      parseInt(parts.dateStr.slice(5, 7), 10) - 1,
      parseInt(parts.dateStr.slice(8, 10), 10),
      parts.hour,
      parts.minute,
      0
    );
    const wantedAsUTC = Date.UTC(y, m - 1, d, hour, minute, 0);
    const diffMs = wantedAsUTC - renderedAsUTC;
    if (diffMs === 0) break;
    guess = new Date(guess.getTime() + diffMs);
  }
  return guess;
}

// Compute the next future occurrence of a single schedule entry, for display
// purposes only (not used by the actual due-check, which only cares about
// exact-minute matches). Searches forward day by day (at most 8 checks) for
// the right weekday, then solves for the exact UTC instant of that day's
// wall-clock time — equivalent to the old minute-by-minute brute force, but
// roughly a thousand times fewer Intl calls, which is what was making every
// dashboard load/action take multiple seconds. Verified byte-for-byte
// identical to the brute-force version across many timezones (including a
// half-hour-DST-shift zone), all weekdays/times, and both 2026 US DST
// transition boundaries before this replaced it.
function computeNextOccurrence(entry, from, timeZone) {
  const start = new Date(Math.ceil(from.getTime() / 60000) * 60000); // round up to next minute
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const probe = new Date(start.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const probeParts = getLocalParts(probe, timeZone);
    if (probeParts.weekday !== entry.day) continue;
    const candidate = localWallTimeToUTC(probeParts.dateStr, entry.hour, entry.minute, timeZone);
    if (candidate.getTime() >= start.getTime()) return candidate;
  }
  return null; // should be unreachable given a valid entry
}

// Build a "click to add" Google Calendar link for one schedule entry. This
// needs no Google account/API credentials on our side — Google Calendar
// supports creating a pre-filled event (including a weekly recurrence)
// purely from URL parameters. The housemate still has to click "Save" on
// Google's own page, so this can never create an event without their
// explicit action.
function buildGoogleCalendarUrl(choreLabel, entry, timeZone) {
  const { hour, minute } = parseHHMM(entry.time);
  const start = computeNextOccurrence({ day: entry.day, hour, minute }, new Date(), timeZone);
  if (!start) return null;
  const end = new Date(start.getTime() + 30 * 60 * 1000); // 30-minute placeholder duration

  const toGCalUTC = (d) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const byday = { sun: 'SU', mon: 'MO', tue: 'TU', wed: 'WE', thu: 'TH', fri: 'FR', sat: 'SA' }[entry.day];

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Chore: ${choreLabel}`,
    dates: `${toGCalUTC(start)}/${toGCalUTC(end)}`,
    details: `Reminder from House Chore Bot — it's your turn for: ${choreLabel}.`,
    recur: `RRULE:FREQ=WEEKLY;BYDAY=${byday}`,
    ctz: timeZone,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// Check once a minute. runScheduledReminders() already catches its own
// errors; this wrapper is an extra safety net on top of that.
const SCHEDULER_INTERVAL_MS = 60 * 1000;
setInterval(() => {
  lastTickAt = new Date();
  runScheduledReminders(lastTickAt).catch((err) => console.error('Unexpected scheduler error:', err));
}, SCHEDULER_INTERVAL_MS);

// Checks the ?secret= query param against SEED_SECRET. Skipped entirely
// while TEST_MODE is on — a test deploy only ever touches TEST_NUMBER
// anyway, so requiring the admin key there is just friction, not safety.
function requireSecret(req, res) {
  if (TEST_MODE) return true;
  const secret = process.env.SEED_SECRET;
  if (secret && req.query.secret !== secret) {
    res.status(403).json({ error: 'forbidden — wrong or missing admin key' });
    return false;
  }
  return true;
}

// Read-only debug endpoint: check what the scheduler would do at a given
// moment, without sending anything or changing state. Useful for confirming
// your schedule and TIMEZONE are set up the way you expect.
// e.g. /debug/schedule?secret=...&at=2026-08-25T15:00:00Z
app.get('/debug/schedule', (req, res) => {
  if (!requireSecret(req, res)) return;
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
  if (!requireSecret(req, res)) return;
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
// 7b. Schedule & task management API — powers the dashboard's editor
// ---------------------------------------------------------------------
// The three mutating endpoints below are protected by requireSecret() (see
// above) — same admin key as the /debug endpoints, same TEST_MODE bypass.
// The gcal-link endpoint is read-only (just computes a URL) so it needs no
// secret at all, in or out of TEST_MODE.

// Add one schedule entry — either to an existing chore (choreId), or to a
// brand-new one created on the fly (newChoreLabel + optional newChoreKeywords).
app.post('/api/schedule/add', (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const { choreId, newChoreLabel, newChoreKeywords, day, time } = req.body || {};

    if (!DAYS.includes(day)) {
      return res.status(400).json({ error: 'invalid day — use sun/mon/tue/wed/thu/fri/sat' });
    }
    if (!TIME_RE.test(time || '')) {
      return res.status(400).json({ error: 'invalid time — use 24-hour HH:MM' });
    }

    const chores = getChores();
    let targetChoreId = choreId;

    if (!targetChoreId) {
      const label = (newChoreLabel || '').trim();
      if (!label) {
        return res.status(400).json({ error: 'a task name is required when not selecting an existing task' });
      }
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
      if (!slug) {
        return res.status(400).json({ error: 'could not derive an id from that task name — try letters or numbers' });
      }
      if (chores[slug]) {
        return res.status(409).json({ error: `"${label}" already exists — pick it from the dropdown instead of creating it again` });
      }
      const keywords = (newChoreKeywords || label)
        .split(',')
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean);
      state.customChores[slug] = { label, keywords: keywords.length ? keywords : [slug] };
      if (state.turn[slug] === undefined) state.turn[slug] = 0;
      targetChoreId = slug;
    } else if (!chores[targetChoreId]) {
      return res.status(400).json({ error: 'unknown choreId' });
    }

    if (!state.schedule[targetChoreId]) state.schedule[targetChoreId] = [];
    const alreadyScheduled = state.schedule[targetChoreId].some((e) => e.day === day && e.time === time);
    if (alreadyScheduled) {
      return res.status(409).json({ error: 'that day/time is already scheduled for this task' });
    }
    state.schedule[targetChoreId].push({ day, time });
    saveState(state);
    res.json({ ok: true, choreId: targetChoreId, schedule: state.schedule[targetChoreId] });
  } catch (err) {
    console.error('Error in /api/schedule/add:', err);
    res.status(500).json({ error: 'Something went wrong — check server logs.' });
  }
});

// Remove one schedule entry (an exact day+time) from a task.
app.post('/api/schedule/remove', (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const { choreId, day, time } = req.body || {};
    if (!state.schedule[choreId]) {
      return res.status(404).json({ error: 'unknown task or it has no schedule' });
    }
    const before = state.schedule[choreId].length;
    state.schedule[choreId] = state.schedule[choreId].filter((e) => !(e.day === day && e.time === time));
    if (state.schedule[choreId].length === before) {
      return res.status(404).json({ error: 'that schedule entry was not found' });
    }
    saveState(state);
    res.json({ ok: true, schedule: state.schedule[choreId] });
  } catch (err) {
    console.error('Error in /api/schedule/remove:', err);
    res.status(500).json({ error: 'Something went wrong — check server logs.' });
  }
});

// Delete a task created from the dashboard entirely (schedule + turn state).
// Only dashboard-added tasks can be removed this way — the 4 built-in chores
// can only be unscheduled (via /api/schedule/remove), never deleted, since
// they're wired into the code.
app.post('/api/chore/remove', (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const { choreId } = req.body || {};
    if (!choreId || !state.customChores[choreId]) {
      return res.status(400).json({ error: 'unknown or built-in task — only dashboard-added tasks can be deleted' });
    }
    delete state.customChores[choreId];
    delete state.schedule[choreId];
    delete state.turn[choreId];
    saveState(state);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error in /api/chore/remove:', err);
    res.status(500).json({ error: 'Something went wrong — check server logs.' });
  }
});

// Manually set whose turn it is for a task (the dashboard's per-task
// dropdown) — an on-demand override alongside the normal advance-on-"done"
// flow, not a replacement for it. personIndex is an index into PEOPLE.
app.post('/api/chore/set-turn', (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const { choreId, personIndex } = req.body || {};
    if (!getChores()[choreId]) {
      return res.status(400).json({ error: 'unknown task' });
    }
    const idx = Number(personIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= PEOPLE.length) {
      return res.status(400).json({ error: 'invalid personIndex' });
    }
    state.turn[choreId] = idx;
    saveState(state);
    res.json({ ok: true, choreId, currentTurn: PEOPLE[idx].name });
  } catch (err) {
    console.error('Error in /api/chore/set-turn:', err);
    res.status(500).json({ error: 'Something went wrong — check server logs.' });
  }
});

// Manually send a reminder for one task, right now, to whoever's currently
// assigned — independent of the schedule (doesn't wait for a scheduled
// slot, doesn't mark anything in state.lastAutoSent). Goes through the
// exact same sendSMS() path as every other message the bot sends, so it
// respects TEST_MODE and re-arms the recipient's reply channel like normal.
app.post('/api/chore/send-reminder', async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const { choreId } = req.body || {};
    const chore = getChores()[choreId];
    if (!chore) return res.status(400).json({ error: 'unknown task' });
    const person = whoseTurn(choreId);
    if (!person) return res.status(400).json({ error: 'no one is configured for that task yet' });

    const result = await sendSMS(person.number, `🏠 Reminder ${person.name} — it's your turn for: ${chore.label}.`);
    res.json({ ok: true, sentTo: person.name, success: !!(result && result.success) });
  } catch (err) {
    console.error('Error in /api/chore/send-reminder:', err);
    res.status(500).json({ error: 'Something went wrong — check server logs.' });
  }
});

// Read-only: build an "Add to Google Calendar" link for one schedule entry.
// No admin key needed — it doesn't touch state, just computes a URL.
app.get('/api/gcal-link', (req, res) => {
  try {
    const { choreId, day, time } = req.query;
    const chore = getChores()[choreId];
    if (!chore) return res.status(404).json({ error: 'unknown task' });
    if (!DAYS.includes(day)) return res.status(400).json({ error: 'invalid day' });
    if (!TIME_RE.test(time || '')) return res.status(400).json({ error: 'invalid time' });

    const url = buildGoogleCalendarUrl(chore.label, { day, time }, TIMEZONE);
    if (!url) return res.status(500).json({ error: 'could not compute a date for that entry' });
    res.json({ url });
  } catch (err) {
    console.error('Error in /api/gcal-link:', err);
    res.status(500).json({ error: 'Something went wrong — check server logs.' });
  }
});

// ---------------------------------------------------------------------
// 8. (formerly a one-time /seed endpoint — no longer needed)
// ---------------------------------------------------------------------
// Textbelt only routes someone's texts to the bot's webhook once a reply
// channel has been opened with that number — but sendSMS() (section 4)
// already sets replyWebhookUrl on every single message it sends, not just a
// dedicated "seed" message. That means whichever message actually goes out
// first — a scheduled reminder, a "Send reminder now" click from the
// dashboard, or a reply to something someone texted the bot — arms that
// person's channel just as well as a standalone seed message would. So
// there's no separate priming step to run: priming happens automatically,
// as a side effect of the first real reminder. The one gap this leaves is a
// housemate texting the bot completely cold, before it has ever sent them
// anything — with nothing to attach the reply to, that first message won't
// route back. Sending everyone one reminder (manually, via "Send reminder
// now") right after deploying closes that gap in one click.

// ---------------------------------------------------------------------
// 9. Status dashboard
// ---------------------------------------------------------------------
// A single data function feeds both the HTML dashboard and the JSON
// endpoint, so the two views can't drift out of sync with each other.
// Deliberately excludes phone numbers and secrets — this page has no auth
// (it also serves as Render's health check target), so nothing sensitive
// belongs on it. Actions that actually mutate state or send messages stay
// behind the existing SEED_SECRET-protected endpoints.

function buildStatusData() {
  const now = new Date();
  const local = getLocalParts(now, TIMEZONE);

  const schedulerActive = lastTickAt !== null && Date.now() - lastTickAt.getTime() < SCHEDULER_INTERVAL_MS * 1.5;
  const chores = getChores();
  const scheduleParsed = getScheduleParsed();

  const choreList = Object.entries(chores).map(([choreId, chore]) => {
    const person = whoseTurn(choreId);
    const entries = state.schedule[choreId] || [];
    const parsedEntries = scheduleParsed[choreId] || [];
    const nextDates = parsedEntries
      .map((e) => computeNextOccurrence(e, now, TIMEZONE))
      .filter(Boolean)
      .sort((a, b) => a - b);
    const next = nextDates[0] || null;

    return {
      id: choreId,
      label: chore.label,
      isCustom: !!state.customChores[choreId],
      currentTurn: person ? person.name : 'unassigned',
      turnIndex: state.turn[choreId] ?? 0,
      scheduleEntries: entries.map((e) => ({ day: e.day, time: e.time, display: `${e.day} ${e.time}` })),
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
    schedulerActive,
    schedulerLastTickISO: lastTickAt ? lastTickAt.toISOString() : null,
    chores: choreList,
  };
}

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeAttr(str) {
  // Same as escapeHTML — split out for readability at call sites that are
  // specifically filling an HTML attribute (onclick args, values, etc).
  return escapeHTML(str);
}

const DAY_LABELS = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };

function renderDashboardHTML(data) {
  const statusDot = (ok) => (ok ? '🟢' : '🔴');

  // The health section only renders at all while TEST_MODE is on — it's
  // debug/setup info, not something day-to-day housemates need to see, and
  // TEST_MODE is precisely the phase where you'd want it in front of you.
  const healthCards = [
    [statusDot(data.textbeltConfigured), 'Textbelt API key', data.textbeltConfigured ? 'configured' : 'MISSING — sends will fail'],
    [statusDot(data.webhookBaseUrlConfigured), 'Webhook base URL', data.webhookBaseUrlConfigured ? escapeHTML(data.webhookBaseUrl) : "MISSING — replies can't reach this server"],
    [statusDot(data.peopleConfiguredCount === 3), 'Housemates configured', `${data.peopleConfiguredCount} / 3 (${escapeHTML(data.peopleNames.join(', ') || 'none')})`],
    [statusDot(data.schedulerActive), 'Automatic reminders', data.schedulerActive ? 'active — heartbeat confirmed' : 'not confirmed yet (just started, or something is wrong — wait a minute and refresh)'],
    [data.testMode ? '🧪' : '⚪', 'Test mode', data.testMode ? 'ON — all sends redirected to TEST_NUMBER' : 'off — sends go to real recipients'],
  ];

  const healthCardsHTML = healthCards
    .map(
      ([dot, label, value]) => `
      <div class="health-card">
        <span class="dot">${dot}</span>
        <div>
          <div class="health-label">${escapeHTML(label)}</div>
          <div class="health-value">${value}</div>
        </div>
      </div>`
    )
    .join('');

  const healthSectionHTML = data.testMode
    ? `
  <section>
    <h2>System health</h2>
    <div class="health-grid">${healthCardsHTML}</div>
  </section>`
    : '';

  const choreOptionsHTML = data.chores
    .map((c) => `<option value="${escapeAttr(c.id)}">${escapeHTML(c.label)}</option>`)
    .join('');

  const dayOptionsHTML = DAYS.map((d) => `<option value="${d}">${DAY_LABELS[d]}</option>`).join('');

  const personOptionsHTML = (selectedIdx) =>
    data.peopleNames
      .map((name, i) => `<option value="${i}"${i === selectedIdx ? ' selected' : ''}>${escapeHTML(name)}</option>`)
      .join('');

  const choreCardsHTML = data.chores
    .map((c) => {
      const pills = c.scheduleEntries.length
        ? c.scheduleEntries
            .map(
              (e) => `
          <span class="pill">
            <span>${DAY_LABELS[e.day] || escapeHTML(e.day)} ${escapeHTML(e.time)}</span>
            <button type="button" class="pill-btn" title="Add to Google Calendar" onclick="addToCalendar('${escapeAttr(c.id)}','${escapeAttr(e.day)}','${escapeAttr(e.time)}')">📅</button>
            <button type="button" class="pill-btn pill-btn-danger" title="Remove this reminder" onclick="removeSchedule('${escapeAttr(c.id)}','${escapeAttr(e.day)}','${escapeAttr(e.time)}')">✕</button>
          </span>`
            )
            .join('')
        : '<span class="pill pill-empty">not scheduled</span>';

      const deleteTaskBtn = c.isCustom
        ? `<button type="button" class="link-btn link-btn-danger" onclick="removeChore('${escapeAttr(c.id)}')">Delete this task</button>`
        : '';

      return `
      <div class="chore-card">
        <div class="chore-card-top">
          <div class="chore-title">${escapeHTML(c.label)}${c.isCustom ? ' <span class="badge">added</span>' : ''}</div>
          <div class="chore-turn">
            👤 <select class="turn-select" onchange="setTurn('${escapeAttr(c.id)}', this.value)">${personOptionsHTML(c.turnIndex)}</select>
          </div>
        </div>
        <div class="pill-row">${pills}</div>
        <div class="chore-card-bottom">
          <span class="next-reminder">${c.nextReminder ? 'Next: ' + escapeHTML(c.nextReminder) : 'No upcoming reminder'}</span>
          <div class="card-actions">
            <button type="button" class="link-btn" onclick="sendReminder('${escapeAttr(c.id)}', this)">📨 Send reminder now</button>
            ${deleteTaskBtn}
          </div>
        </div>
      </div>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>House Chore Bot — Dashboard</title>
<style>
  :root { color-scheme: light dark; --accent: #6366f1; --danger: #ef4444; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem 3rem; line-height: 1.5; }
  h1 { font-size: 1.5rem; margin: 0 0 0.15rem; }
  .subtitle { color: #888; margin: 0 0 1.75rem; font-size: 0.9rem; }
  section { margin-bottom: 2.25rem; }
  h2 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.04em; color: #888; margin: 0 0 0.75rem; }
  .card-shell { border: 1px solid rgba(128,128,128,0.25); border-radius: 14px; padding: 1.1rem 1.25rem; background: rgba(128,128,128,0.04); }

  .health-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 0.6rem; }
  .health-card { display: flex; gap: 0.6rem; align-items: flex-start; border: 1px solid rgba(128,128,128,0.2); border-radius: 10px; padding: 0.7rem 0.85rem; background: rgba(128,128,128,0.04); }
  .dot { font-size: 1rem; line-height: 1.3; }
  .health-label { font-size: 0.78rem; color: #888; text-transform: uppercase; letter-spacing: 0.02em; }
  .health-value { font-size: 0.92rem; word-break: break-word; }

  .chore-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 0.75rem; margin-bottom: 1.1rem; }
  .chore-card { border: 1px solid rgba(128,128,128,0.25); border-radius: 12px; padding: 0.9rem 1rem; background: rgba(128,128,128,0.03); display: flex; flex-direction: column; gap: 0.6rem; }
  .chore-card-top { display: flex; justify-content: space-between; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
  .chore-title { font-weight: 600; font-size: 1rem; }
  .badge { font-size: 0.68rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.03em; color: var(--accent); border: 1px solid var(--accent); border-radius: 999px; padding: 0.05rem 0.4rem; vertical-align: middle; }
  .chore-turn { font-size: 0.85rem; color: #aaa; white-space: nowrap; display: flex; align-items: center; gap: 0.3rem; }
  .turn-select { font-size: 0.82rem; padding: 0.2rem 0.4rem; border-radius: 6px; }
  .pill-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .pill { display: inline-flex; align-items: center; gap: 0.35rem; background: rgba(128,128,128,0.12); border-radius: 999px; padding: 0.25rem 0.3rem 0.25rem 0.65rem; font-size: 0.82rem; }
  .pill-empty { color: #888; padding: 0.25rem 0.65rem; }
  .pill-btn { border: none; background: transparent; cursor: pointer; font-size: 0.85rem; padding: 0.1rem 0.3rem; border-radius: 999px; line-height: 1; }
  .pill-btn:hover { background: rgba(128,128,128,0.25); }
  .pill-btn-danger:hover { background: rgba(239,68,68,0.25); }
  .chore-card-bottom { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .card-actions { display: flex; align-items: center; gap: 0.7rem; flex-wrap: wrap; }
  .next-reminder { font-size: 0.78rem; color: #888; }
  .link-btn { border: none; background: transparent; color: var(--accent); font-size: 0.78rem; cursor: pointer; padding: 0; text-decoration: underline; }
  .link-btn-danger { color: var(--danger); }

  .admin-bar { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 1.25rem; }
  .admin-bar label { font-size: 0.85rem; color: #888; }
  input[type="password"], input[type="text"], input[type="time"], select {
    padding: 0.5rem 0.6rem; border-radius: 8px; border: 1px solid rgba(128,128,128,0.4);
    font-size: 0.88rem; background: transparent; color: inherit;
  }
  .add-form { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: flex-end; }
  .field { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.78rem; color: #888; }
  button.primary, button.secondary {
    padding: 0.55rem 1rem; border-radius: 8px; border: 1px solid var(--accent); cursor: pointer; font-size: 0.88rem; font-weight: 500;
  }
  button.primary { background: var(--accent); color: #fff; }
  button.primary:hover { opacity: 0.9; }
  button.secondary { background: transparent; border-color: rgba(128,128,128,0.4); color: inherit; }
  button.secondary:hover { background: rgba(128,128,128,0.15); }
  .actions-row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  #actionResult { margin-top: 0.9rem; font-size: 0.82rem; white-space: pre-wrap; font-family: ui-monospace, monospace; background: rgba(128,128,128,0.08); padding: 0.7rem 0.85rem; border-radius: 8px; display: none; max-height: 220px; overflow: auto; }
  footer { color: #999; font-size: 0.78rem; margin-top: 2rem; }
</style>
</head>
<body>
  <h1>🏠 House Chore Bot</h1>
  <p class="subtitle">Local time: ${escapeHTML(data.localTimeText)} (${escapeHTML(data.timezone)}) · Server time: ${escapeHTML(data.serverTimeISO)}</p>

  <div class="admin-bar">
    <label for="adminSecretInput">🔑 Admin key</label>
    <input type="password" id="adminSecretInput" placeholder="${data.testMode ? 'not required in TEST_MODE' : 'required to add/remove/trigger'}" ${data.testMode ? 'disabled' : ''}>
    <span style="font-size:0.78rem;color:#888;">${data.testMode ? '🧪 TEST_MODE is on — admin key is not required right now' : 'only needed for actions below — never saved anywhere'}</span>
  </div>

  <section>
    <h2>Tasks &amp; schedule</h2>
    <div class="chore-grid" id="choreGrid">${choreCardsHTML}</div>

    <div class="card-shell">
      <div style="font-size:0.85rem; font-weight:600; margin-bottom:0.75rem;">Add or Edit tasksr</div>
      <div class="add-form">
        <div class="field">
          <label for="choreSelect">Task</label>
          <select id="choreSelect" onchange="toggleNewTaskFields()">
            ${choreOptionsHTML}
            <option value="__new__">＋ New task…</option>
          </select>
        </div>
        <div class="field" id="newTaskNameField" style="display:none;">
          <label for="newTaskName">New task name</label>
          <input type="text" id="newTaskName" placeholder="e.g. Dishes">
        </div>
        <div class="field" id="newTaskKeywordsField" style="display:none;">
          <label for="newTaskKeywords">Match words (comma-separated)</label>
          <input type="text" id="newTaskKeywords" placeholder="e.g. dishes, dishwasher">
        </div>
        <div class="field">
          <label for="daySelect">Day</label>
          <select id="daySelect">${dayOptionsHTML}</select>
        </div>
        <div class="field">
          <label for="timeInput">Time</label>
          <input type="time" id="timeInput" value="09:00">
        </div>
        <button type="button" class="primary" onclick="addSchedule()">Add </button>
      </div>
    </div>
  </section>
${healthSectionHTML}

  <section>
    <h2>Quick actions</h2>
    <div class="actions-row">
      <button type="button" class="secondary" onclick="runPostAction('/debug/trigger-schedule')">Trigger scheduler now</button>
      <button type="button" class="secondary" onclick="runGetAction('/debug/schedule')">Preview schedule (read-only)</button>
    </div>
    <pre id="actionResult"></pre>
  </section>

  <footer>This page has no login — don't share this URL publicly. It intentionally shows no phone numbers or secrets.</footer>

  <script>
    function getSecret() {
      return document.getElementById('adminSecretInput').value;
    }

    function showResult(status, text) {
      var el = document.getElementById('actionResult');
      el.style.display = 'block';
      el.textContent = status + '\\n' + text;
    }

    function toggleNewTaskFields() {
      var isNew = document.getElementById('choreSelect').value === '__new__';
      document.getElementById('newTaskNameField').style.display = isNew ? 'flex' : 'none';
      document.getElementById('newTaskKeywordsField').style.display = isNew ? 'flex' : 'none';
    }

    function runGetAction(path) {
      var secret = getSecret();
      showResult('Working...', '');
      fetch(path + '?secret=' + encodeURIComponent(secret))
        .then(function (res) {
          return res.text().then(function (text) { return { res: res, text: text }; });
        })
        .then(function (r) {
          var pretty = r.text;
          try { pretty = JSON.stringify(JSON.parse(r.text), null, 2); } catch (e) {}
          showResult(r.res.status + ' ' + r.res.statusText, pretty);
        })
        .catch(function (err) { showResult('Request failed', err.message); });
    }

    function runPostAction(path) {
      var secret = getSecret();
      showResult('Working...', '');
      fetch(path + '?secret=' + encodeURIComponent(secret), { method: 'POST' })
        .then(function (res) {
          return res.text().then(function (text) { return { res: res, text: text }; });
        })
        .then(function (r) {
          var pretty = r.text;
          try { pretty = JSON.stringify(JSON.parse(r.text), null, 2); } catch (e) {}
          showResult(r.res.status + ' ' + r.res.statusText, pretty);
        })
        .catch(function (err) { showResult('Request failed', err.message); });
    }

    // Returns a real Promise now (instead of taking an onSuccess callback),
    // so callers can chain their own follow-up work with .then()/.catch()
    // instead of guessing how long to wait with setTimeout. Resolves with
    // the parsed JSON body on a 2xx response; rejects (after already
    // showing the error via showResult) on anything else — network failure
    // or a non-2xx status.
    function postJSON(path, body) {
      var secret = getSecret();
      showResult('Working...', '');
      return fetch(path + '?secret=' + encodeURIComponent(secret), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(function (res) {
          return res.text().then(function (text) { return { res: res, text: text }; });
        })
        .then(function (r) {
          var pretty = r.text;
          var parsed = null;
          try { parsed = JSON.parse(r.text); pretty = JSON.stringify(parsed, null, 2); } catch (e) {}
          showResult(r.res.status + ' ' + r.res.statusText, pretty);
          if (!r.res.ok) throw new Error('http-error');
          return parsed;
        })
        .catch(function (err) {
          if (err.message !== 'http-error') showResult('Request failed', err.message);
          throw err;
        });
    }

    var DAY_LABELS_JS = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };

    // Builds one task card as real DOM nodes (not an HTML string) — every
    // piece of task-supplied text goes through .textContent, which the
    // browser never interprets as markup, so this is safe against the same
    // kind of injection escapeHTML() guards against server-side, without
    // needing to reimplement escaping here.
    function buildChoreCard(c, peopleNames) {
      var card = document.createElement('div');
      card.className = 'chore-card';

      var top = document.createElement('div');
      top.className = 'chore-card-top';

      var title = document.createElement('div');
      title.className = 'chore-title';
      title.appendChild(document.createTextNode(c.isCustom ? c.label + ' ' : c.label));
      if (c.isCustom) {
        var badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'added';
        title.appendChild(badge);
      }

      var turnWrap = document.createElement('div');
      turnWrap.className = 'chore-turn';
      turnWrap.appendChild(document.createTextNode('👤 '));
      var select = document.createElement('select');
      select.className = 'turn-select';
      peopleNames.forEach(function (name, i) {
        var opt = document.createElement('option');
        opt.value = i;
        opt.textContent = name;
        if (i === c.turnIndex) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener('change', function () { setTurn(c.id, select.value); });
      turnWrap.appendChild(select);

      top.appendChild(title);
      top.appendChild(turnWrap);

      var pillRow = document.createElement('div');
      pillRow.className = 'pill-row';
      if (c.scheduleEntries.length === 0) {
        var emptyPill = document.createElement('span');
        emptyPill.className = 'pill pill-empty';
        emptyPill.textContent = 'not scheduled';
        pillRow.appendChild(emptyPill);
      } else {
        c.scheduleEntries.forEach(function (e) {
          var pill = document.createElement('span');
          pill.className = 'pill';

          var label = document.createElement('span');
          label.textContent = (DAY_LABELS_JS[e.day] || e.day) + ' ' + e.time;
          pill.appendChild(label);

          var calBtn = document.createElement('button');
          calBtn.type = 'button';
          calBtn.className = 'pill-btn';
          calBtn.title = 'Add to Google Calendar';
          calBtn.textContent = '📅';
          calBtn.addEventListener('click', function () { addToCalendar(c.id, e.day, e.time); });
          pill.appendChild(calBtn);

          var rmBtn = document.createElement('button');
          rmBtn.type = 'button';
          rmBtn.className = 'pill-btn pill-btn-danger';
          rmBtn.title = 'Remove this reminder';
          rmBtn.textContent = '✕';
          rmBtn.addEventListener('click', function () { removeSchedule(c.id, e.day, e.time); });
          pill.appendChild(rmBtn);

          pillRow.appendChild(pill);
        });
      }

      var bottom = document.createElement('div');
      bottom.className = 'chore-card-bottom';

      var nextSpan = document.createElement('span');
      nextSpan.className = 'next-reminder';
      nextSpan.textContent = c.nextReminder ? ('Next: ' + c.nextReminder) : 'No upcoming reminder';

      var actions = document.createElement('div');
      actions.className = 'card-actions';

      var sendBtn = document.createElement('button');
      sendBtn.type = 'button';
      sendBtn.className = 'link-btn';
      sendBtn.textContent = '📨 Send reminder now';
      sendBtn.addEventListener('click', function () { sendReminder(c.id, sendBtn); });
      actions.appendChild(sendBtn);

      if (c.isCustom) {
        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'link-btn link-btn-danger';
        delBtn.textContent = 'Delete this task';
        delBtn.addEventListener('click', function () { removeChore(c.id); });
        actions.appendChild(delBtn);
      }

      bottom.appendChild(nextSpan);
      bottom.appendChild(actions);

      card.appendChild(top);
      card.appendChild(pillRow);
      card.appendChild(bottom);
      return card;
    }

    // Re-syncs the task cards AND the "Task" dropdown from /status.json —
    // one small JSON fetch, no full-page navigation. This is what replaced
    // location.reload() everywhere below: a full reload re-fetches and
    // re-parses the entire HTML document (styles and all) just to update a
    // few numbers, which is what made every click feel slow.
    function refreshChores() {
      return fetch('/status.json')
        .then(function (res) { return res.json(); })
        .then(function (data) {
          var grid = document.getElementById('choreGrid');
          grid.innerHTML = '';
          data.chores.forEach(function (c) { grid.appendChild(buildChoreCard(c, data.peopleNames)); });

          var select = document.getElementById('choreSelect');
          var currentVal = select.value;
          select.innerHTML = '';
          data.chores.forEach(function (c) {
            var opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = c.label;
            select.appendChild(opt);
          });
          var newOpt = document.createElement('option');
          newOpt.value = '__new__';
          newOpt.textContent = '＋ New task…';
          select.appendChild(newOpt);
          if (data.chores.some(function (c) { return c.id === currentVal; })) {
            select.value = currentVal;
          }
        })
        .catch(function (err) { showResult('Refresh failed', err.message); });
    }

    function addSchedule() {
      var choreSelectVal = document.getElementById('choreSelect').value;
      var day = document.getElementById('daySelect').value;
      var time = document.getElementById('timeInput').value;
      var body = { day: day, time: time };
      if (choreSelectVal === '__new__') {
        body.newChoreLabel = document.getElementById('newTaskName').value;
        body.newChoreKeywords = document.getElementById('newTaskKeywords').value;
      } else {
        body.choreId = choreSelectVal;
      }
      postJSON('/api/schedule/add', body)
        .then(function () {
          document.getElementById('newTaskName').value = '';
          document.getElementById('newTaskKeywords').value = '';
          return refreshChores();
        })
        .catch(function () {});
    }

    function removeSchedule(choreId, day, time) {
      if (!confirm('Remove this reminder?')) return;
      postJSON('/api/schedule/remove', { choreId: choreId, day: day, time: time })
        .then(refreshChores)
        .catch(function () {});
    }

    function removeChore(choreId) {
      if (!confirm('Delete this task entirely? This removes its whole schedule and turn history.')) return;
      postJSON('/api/chore/remove', { choreId: choreId })
        .then(refreshChores)
        .catch(function () {});
    }

    function setTurn(choreId, personIndex) {
      postJSON('/api/chore/set-turn', { choreId: choreId, personIndex: personIndex })
        .then(refreshChores)
        .catch(function () {});
    }

    function sendReminder(choreId, btn) {
      var original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Sending…';
      var reset = function () {
        btn.disabled = false;
        btn.textContent = original;
      };
      postJSON('/api/chore/send-reminder', { choreId: choreId }).then(reset).catch(reset);
    }

    function addToCalendar(choreId, day, time) {
      fetch('/api/gcal-link?choreId=' + encodeURIComponent(choreId) + '&day=' + encodeURIComponent(day) + '&time=' + encodeURIComponent(time))
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.url) {
            window.open(data.url, '_blank');
          } else {
            showResult('Could not build calendar link', JSON.stringify(data));
          }
        })
        .catch(function (err) { showResult('Request failed', err.message); });
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
