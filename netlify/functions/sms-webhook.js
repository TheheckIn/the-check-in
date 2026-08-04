// netlify/functions/sms-webhook.js
//
// Twilio calls this URL whenever someone texts your Twilio number.
// We only care about a "YES" reply here — STOP/HELP are already handled
// automatically by Twilio's built-in opt-out/help management (see the
// Messaging Service "Opt-Out Management" settings in the Twilio console).
//
// SECURITY: every request is verified against Twilio's X-Twilio-Signature
// header before we trust anything in it. This proves the request really
// came from Twilio, not from someone hitting this URL directly.
//
// Requires a TWILIO_WEBHOOK_URL environment variable set to the EXACT URL
// pasted into the Twilio console's "When a message comes in" field —
// this must match character-for-character or every request will be
// (correctly) rejected as unverifiable.

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

// Netlify's automatic Blobs configuration has a known issue where it
// sometimes fails to detect the site context in production, throwing
// "MissingBlobsEnvironmentError" even though nothing is wrong with the code.
// Passing siteID/token explicitly avoids relying on that auto-detection.
function getConfiguredStore(name) {
  return getStore({
    name,
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_API_TOKEN,
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { TWILIO_AUTH_TOKEN, TWILIO_WEBHOOK_URL } = process.env;
  if (!TWILIO_AUTH_TOKEN || !TWILIO_WEBHOOK_URL) {
    // Fail closed: if we can't verify, we don't process.
    return { statusCode: 500, body: 'Webhook not configured.' };
  }

  const twilioSignature = event.headers['x-twilio-signature'];
  if (!twilioSignature) {
    return { statusCode: 403, body: 'Missing signature.' };
  }

  const params = new URLSearchParams(event.body);
  const paramsObject = {};
  for (const [key, value] of params.entries()) {
    paramsObject[key] = value;
  }

  const isValid = validateTwilioSignature(TWILIO_AUTH_TOKEN, twilioSignature, TWILIO_WEBHOOK_URL, paramsObject);
  if (!isValid) {
    return { statusCode: 403, body: 'Invalid signature.' };
  }

  const from = normalizePhone(params.get('From'));
  const body = (params.get('Body') || '').trim().toUpperCase();

  // Only act on an explicit YES. Anything else (including STOP/HELP, which
  // Twilio intercepts before this function even runs) gets no reply here.
  if (from && body === 'YES') {
    const pendingStore = getConfiguredStore('checkin-pending-optins');
    const pending = (await pendingStore.get(from, { type: 'json' })) || [];

    if (pending.length > 0) {
      const usersStore = getConfiguredStore('checkin-users');

      await Promise.all(
        pending.map(async (entry) => {
          const data = await usersStore.get(entry.userId, { type: 'json' });
          if (!data || !Array.isArray(data.contacts)) return;

          let changed = false;
          data.contacts = data.contacts.map((c) => {
            if (normalizePhone(c.phone) === from && c.status !== 'confirmed') {
              changed = true;
              return { ...c, status: 'confirmed' };
            }
            return c;
          });

          if (changed) {
            await usersStore.setJSON(entry.userId, data);
          }
        })
      );

      // Clear the pending list now that everyone waiting on this number is resolved.
      await pendingStore.delete(from);
    }

    return twiml("You're confirmed! You'll now receive check-in alerts. Reply STOP anytime to opt out.");
  }

  // No reply for anything else — avoids echoing random texts back at people.
  return twiml('');
};

// Twilio's request-signing algorithm:
// 1. Start with the exact webhook URL Twilio was configured to POST to.
// 2. Sort the POST parameters alphabetically by key, and append each
//    "key" + "value" directly to the URL string (no separators).
// 3. HMAC-SHA1 that string using your Auth Token as the key, base64-encode it.
// 4. Compare that to the X-Twilio-Signature header. Match = genuine request.
function validateTwilioSignature(authToken, twilioSignature, url, params) {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');

  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(twilioSignature);
  if (expectedBuf.length !== receivedBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

function twiml(message) {
  const body = message
    ? `<Response><Message>${escapeXml(message)}</Message></Response>`
    : '<Response></Response>';
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml' },
    body,
  };
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Converts a loosely formatted US number like "(765) 555-0142" into E.164 format "+17655550142"
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}
