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
  const fresh = { turn: {}, seeded: [] };
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
// 7. One-time seed endpoint
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

// Health check for hosting platforms
app.get('/', (req, res) => {
  res.send('House Chore Bot is running.');
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
