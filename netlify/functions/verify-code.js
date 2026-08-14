// netlify/functions/verify-code.js
const { getStore } = require('@netlify/blobs');

const MAX_ATTEMPTS = 5;

// Phone numbers that permanently bypass any future paywall — the 5 sisters
// plus Addie (niece). Whoever verifies with one of these numbers gets
// foundingUser: true set on their account, forever, no matter which device
// or how many times they re-verify.
const FOUNDING_USER_PHONES = new Set([
  '+17657144648', // Linda
  '+13174472083', // Addie
  '+13174428412', // Barb
  '+12165334230', // Kathy
  '+17706864485', // Sally
  '+19103672518', // Jane
  '+17702894666', // Robert (owner)
]);

function normalizePhone(raw) {
  const digits = (raw || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const phone = normalizePhone(body.phone);
  const submittedCode = String(body.code || '').trim();
  const clientUserId = body.userId || null; // the caller's current localStorage userId, if any

  if (!phone || !submittedCode) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Phone and code are required.' }) };
  }

  const codesStore = getStore({
    name: 'checkin-verify-codes',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_API_TOKEN,
  });

  const raw = await codesStore.get(phone);
  if (!raw) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No pending code for this number. Request a new one.' }) };
  }

  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Verification record corrupted. Request a new code.' }) };
  }

  if (Date.now() > record.expiresAt) {
    await codesStore.delete(phone);
    return { statusCode: 400, body: JSON.stringify({ error: 'Code expired. Request a new one.' }) };
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    await codesStore.delete(phone);
    return { statusCode: 429, body: JSON.stringify({ error: 'Too many attempts. Request a new code.' }) };
  }

  if (submittedCode !== record.code) {
    record.attempts += 1;
    await codesStore.set(phone, JSON.stringify(record));
    return { statusCode: 400, body: JSON.stringify({ error: 'Incorrect code.' }) };
  }

  // Code correct — clear it so it can't be reused
  await codesStore.delete(phone);

  // Look up (or create) the phone -> userId link
  const indexStore = getStore({
    name: 'checkin-phone-index',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_API_TOKEN,
  });

  const existingUserId = await indexStore.get(phone);

  let userId;
  if (existingUserId) {
    // Returning user — new device / cleared cache. Hand back their original account.
    userId = existingUserId;
  } else if (clientUserId) {
    // First-time verification — link their current local account to this phone.
    userId = clientUserId;
    await indexStore.set(phone, userId);
  } else {
    // No existing link and no local userId supplied — create a fresh one.
    userId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    await indexStore.set(phone, userId);
  }

  // If this phone belongs to a founding user, make sure their account is
  // permanently flagged — merge into whatever record already exists rather
  // than overwriting it, so contacts/history are never touched.
  if (FOUNDING_USER_PHONES.has(phone)) {
    const usersStore = getStore({
      name: 'checkin-users',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });
    const existingData = (await usersStore.get(userId, { type: 'json' })) || {
      contacts: [],
      checkInHour: 9,
      checkInMinute: 0,
    };
    if (!existingData.foundingUser) {
      existingData.foundingUser = true;
      await usersStore.setJSON(userId, existingData);
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, userId, phone }),
  };
};
