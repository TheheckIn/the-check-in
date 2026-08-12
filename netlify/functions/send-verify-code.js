// netlify/functions/send-verify-code.js
const { getStore } = require('@netlify/blobs');

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_PHONE_NUMBER; // +19382225810

const CODE_TTL_MS = 10 * 60 * 1000;      // code valid for 10 minutes
const RESEND_COOLDOWN_MS = 60 * 1000;    // 60s between sends to same number

function normalizePhone(raw) {
  // very light E.164 normalizer — assumes US numbers if no country code given
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
  if (!phone) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid phone number' }) };
  }

  const store = getStore({
    name: 'checkin-verify-codes',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_API_TOKEN,
  });

  // Rate limit: check for an existing unexpired entry sent recently
  const existingRaw = await store.get(phone);
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw);
      const sinceLastSend = Date.now() - existing.lastSentAt;
      if (sinceLastSend < RESEND_COOLDOWN_MS) {
        const waitSec = Math.ceil((RESEND_COOLDOWN_MS - sinceLastSend) / 1000);
        return {
          statusCode: 429,
          body: JSON.stringify({ error: `Please wait ${waitSec}s before requesting another code.` }),
        };
      }
    } catch {
      // malformed entry, fall through and overwrite
    }
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const record = {
    code,
    expiresAt: Date.now() + CODE_TTL_MS,
    lastSentAt: Date.now(),
    attempts: 0,
  };

  await store.set(phone, JSON.stringify(record));

  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH}`).toString('base64');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;

  try {
    const params = new URLSearchParams({
      To: phone,
      From: TWILIO_FROM,
      Body: `Your The Check In verification code is ${code}. It expires in 10 minutes.`,
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.error('Twilio send error:', data);
      return { statusCode: 502, body: JSON.stringify({ error: data.message || 'Failed to send verification text.' }) };
    }
  } catch (err) {
    console.error('Twilio send error:', err);
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to send verification text.' }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, message: 'Verification code sent.' }),
  };
};
