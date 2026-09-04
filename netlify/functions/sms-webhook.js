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
    console.error('[sms-webhook] Missing TWILIO_AUTH_TOKEN or TWILIO_WEBHOOK_URL env vars.');
    return { statusCode: 500, body: 'Webhook not configured.' };
  }

  const twilioSignature = event.headers['x-twilio-signature'];
  if (!twilioSignature) {
    console.warn('[sms-webhook] Request missing X-Twilio-Signature header.');
    return { statusCode: 403, body: 'Missing signature.' };
  }

  const params = new URLSearchParams(event.body);
  const paramsObject = {};
  for (const [key, value] of params.entries()) {
    paramsObject[key] = value;
  }

  const isValid = validateTwilioSignature(TWILIO_AUTH_TOKEN, twilioSignature, TWILIO_WEBHOOK_URL, paramsObject);
  if (!isValid) {
    console.warn('[sms-webhook] Signature validation FAILED. Request rejected.');
    return { statusCode: 403, body: 'Invalid signature.' };
  }

  const from = normalizePhone(params.get('From'));
  const body = (params.get('Body') || '').trim().toUpperCase();

  console.log(`[sms-webhook] Inbound message. rawFrom="${params.get('From')}" normalizedFrom="${from}" body="${body}"`);

  // Only act on an explicit YES. Anything else (including STOP/HELP, which
  // Twilio intercepts before this function even runs) gets no reply here.
  if (from && body === 'YES') {
    const pendingStore = getConfiguredStore('checkin-pending-optins');
    const pending = (await pendingStore.get(from, { type: 'json' })) || [];

    console.log(`[sms-webhook] Looked up pending optins for "${from}": ${JSON.stringify(pending)}`);

    if (pending.length === 0) {
      // Nothing was ever sent to this exact number — either no one has
      // added them yet, or (very likely, based on real incidents) whoever
      // added them typed in a different/wrong number, so the original
      // opt-in text went somewhere else entirely and this person never
      // saw it. Previously this replied "You're confirmed!" anyway, which
      // was actively misleading — this person confirmed nothing.
      console.warn(`[sms-webhook] No pending optin record found for "${from}". Nothing to confirm.`);
      return twiml("We don't have a pending check-in request for this number. Ask whoever added you to double-check the number they have on file and resend the request, then reply YES again.");
    }

    const usersStore = getConfiguredStore('checkin-users');
    const matchedEntries = [];
    const unmatchedEntries = [];

    await Promise.all(
      pending.map(async (entry) => {
        console.log(`[sms-webhook] Checking pending entry userId="${entry.userId}" name="${entry.name}"`);

        const data = await usersStore.get(entry.userId, { type: 'json' });
        if (!data || !Array.isArray(data.contacts)) {
          console.warn(`[sms-webhook] No user data (or no contacts array) found for userId="${entry.userId}". Skipping.`);
          unmatchedEntries.push(entry);
          return;
        }

        console.log(`[sms-webhook] userId="${entry.userId}" has contacts: ${JSON.stringify(data.contacts.map(c => ({ name: c.name, phone: c.phone, status: c.status })))}`);

        let matchedThisUser = false;
        let changed = false;
        data.contacts = data.contacts.map((c) => {
          const normalized = normalizePhone(c.phone);
          const matches = normalized === from;
          console.log(`[sms-webhook]   comparing contact "${c.name}" phone="${c.phone}" normalized="${normalized}" against from="${from}" -> ${matches ? 'MATCH' : 'no match'} (current status: ${c.status})`);
          if (matches) {
            matchedThisUser = true;
            if (c.status !== 'confirmed') {
              changed = true;
              return { ...c, status: 'confirmed' };
            }
          }
          return c;
        });

        if (changed) {
          console.log(`[sms-webhook] Writing updated contacts back for userId="${entry.userId}".`);
          await usersStore.setJSON(entry.userId, data);
        } else {
          console.log(`[sms-webhook] No change needed for userId="${entry.userId}" (${matchedThisUser ? 'already confirmed' : 'no matching contact found'}).`);
        }

        (matchedThisUser ? matchedEntries : unmatchedEntries).push(entry);
      })
    );

    if (matchedEntries.length > 0) {
      // Only clear the requests we actually resolved. Anything unmatched
      // stays in the pending list — it's a real mismatch worth being able
      // to trace later, not something to silently erase.
      if (unmatchedEntries.length > 0) {
        console.warn(`[sms-webhook] Partial match for "${from}": resolved ${matchedEntries.length}, leaving ${unmatchedEntries.length} unmatched entries in place.`);
        await pendingStore.setJSON(from, unmatchedEntries);
      } else {
        console.log(`[sms-webhook] Clearing pending optins for "${from}" (fully resolved).`);
        await pendingStore.delete(from);
      }
      return twiml("You're confirmed! You'll now receive check-in alerts. Reply STOP anytime to opt out.");
    }

    // Pending entries existed for this number, but not one of them matched
    // a contact on file — almost always means the number on the requester's
    // side doesn't match this phone (a typo, or home vs. mobile). Leave the
    // pending record in place (in case it gets corrected and re-checked
    // later) and tell the person the truth instead of "You're confirmed!"
    console.error(`[sms-webhook] WARNING: pending list for "${from}" was non-empty but NO entry matched. Nothing confirmed.`);
    return twiml("We got your YES, but couldn't match it to a pending request — the number on file for you may be different from this one. Ask them to double-check it and resend.");
  }

  // No reply for anything else — avoids echoing random texts back at people.
  console.log(`[sms-webhook] Message did not match YES handling (from="${from}" body="${body}"). No action taken.`);
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
