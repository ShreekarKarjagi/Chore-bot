// House Chore Bot
// A WhatsApp bot (via Twilio) that reminds housemates whose turn it is
// to do a chore, and rotates turns round-robin as chores get marked done.

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, 'state.json');

// ---------------------------------------------------------------------
// 1. Configure the 3 housemates and the 4 chores
// ---------------------------------------------------------------------

// Each person is identified by their WhatsApp number in E.164 format,
// e.g. "whatsapp:+15551234567". Set these via environment variables.
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
  const fresh = { turn: {} };
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

function findPersonByNumber(number) {
  // Twilio sends numbers like "whatsapp:+15551234567"
  return PEOPLE.find((p) => p.number === number);
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
    `Message me a chore name (e.g. "trash", "vacuuming", "bathroom", "balcony") ` +
    `and I'll remind whoever's turn it is.\n\n` +
    `Say "<chore> done" (e.g. "trash done") when it's finished to pass the turn to the next person.\n\n` +
    `Say "status" any time to see whose turn it is for everything.`
  );
}

// ---------------------------------------------------------------------
// 4. Twilio client for proactively messaging people
// ---------------------------------------------------------------------

const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

const FROM_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER; // e.g. "whatsapp:+14155238886"

async function sendWhatsApp(toNumber, body) {
  if (!twilioClient || !FROM_WHATSAPP_NUMBER) {
    console.warn('Twilio client not configured; would have sent:', toNumber, body);
    return;
  }
  await twilioClient.messages.create({
    from: FROM_WHATSAPP_NUMBER,
    to: toNumber,
    body,
  });
}

// ---------------------------------------------------------------------
// 5. Webhook
// ---------------------------------------------------------------------

app.post('/webhook', async (req, res) => {
  const from = req.body.From; // "whatsapp:+1..."
  const body = (req.body.Body || '').trim();

  const { MessagingResponse } = twilio.twiml;
  const twiml = new MessagingResponse();

  const sender = findPersonByNumber(from);
  const senderName = sender ? sender.name : 'Someone';

  try {
    if (!body) {
      twiml.message(helpMessage());
    } else if (isHelpRequest(body)) {
      twiml.message(helpMessage());
    } else if (isStatusRequest(body)) {
      twiml.message(statusMessage());
    } else {
      const choreId = findChoreInText(body);

      if (!choreId) {
        twiml.message(
          `I didn't recognize a chore in that message. ${helpMessage()}`
        );
      } else if (isDoneMessage(body)) {
        const completedBy = whoseTurn(choreId);
        const next = advanceTurn(choreId);
        twiml.message(
          `✅ Marked "${CHORES[choreId].label}" as done. Next up: ${next.name}.`
        );
        if (next.number !== from) {
          await sendWhatsApp(
            next.number,
            `🏠 Heads up ${next.name} — it's your turn for: ${CHORES[choreId].label}.`
          );
        }
      } else {
        // Reminder request
        const person = whoseTurn(choreId);
        if (!person) {
          twiml.message(`No one is configured for that chore yet.`);
        } else {
          if (person.number !== from) {
            await sendWhatsApp(
              person.number,
              `🏠 Reminder from ${senderName}: it's your turn to do — ${CHORES[choreId].label}.`
            );
            twiml.message(`Got it — I reminded ${person.name} to handle "${CHORES[choreId].label}".`);
          } else {
            twiml.message(`Looks like it's already your turn for "${CHORES[choreId].label}" — go get 'em!`);
          }
        }
      }
    }
  } catch (err) {
    console.error('Error handling message:', err);
    twiml.message('Sorry, something went wrong handling that. Please try again.');
  }

  res.type('text/xml').send(twiml.toString());
});

// Health check for hosting platforms
app.get('/', (req, res) => {
  res.send('House Chore Bot is running.');
});

app.listen(PORT, () => {
  console.log(`House Chore Bot listening on port ${PORT}`);
  console.log('Configured people:', PEOPLE.map((p) => `${p.name} <${p.number}>`).join(', '));
});
