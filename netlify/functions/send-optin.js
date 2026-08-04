// netlify/functions/send-optin.js
//
// Sends a one-time opt-in confirmation SMS to a newly added contact,
// and records the (userId, contact) pair as "pending" so the inbound
// SMS webhook (sms-webhook.js) knows who to confirm when the contact replies YES.
//
// Expects a POST body like:
// { "userId": "abc123", "ownerName": "Robert", "contact": { "name": "Barb", "phone": "+17655550142" } }
//
// Requires an "X-App-Secret" header matching the APP_SHARED_SECRET
// environment variable, so random internet traffic can't trigger sends.

const { getStore } = require('@netlify/blobs');

const SITE_ORIGIN = 'https://helpful-squirrel-b651a9.netlify.app';

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
  // Browsers send an OPTIONS preflight request before the real POST,
  // because we're sending a custom header (X-App-Secret). This has to
  // succeed or the real request never gets sent by the browser at all.
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders(),
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: 'Method Not Allowed' };
  }

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, APP_SHARED_SECRET } = process.env;

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Twilio environment variables are not configured.' }),
    };
  }

  if (!APP_SHARED_SECRET) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'APP_SHARED_SECRET is not configured on the server.' }),
    };
  }

  const providedSecret = event.headers['x-app-secret'];
  if (providedSecret !== APP_SHARED_SECRET) {
    return {
      statusCode: 401,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Unauthorized.' }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Invalid JSON body.' }) };
  }

  const { userId, ownerName, contact } = payload;
  if (!userId || !contact || !contact.phone || !contact.name) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Missing userId or contact.' }) };
  }

  const toNumber = normalizePhone(contact.phone);
  if (!toNumber) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Invalid phone number.' }) };
  }

  const displayOwnerName = (ownerName && ownerName.trim()) || 'Someone';
  const message = `${displayOwnerName} added you as a check-in contact on The Check In. Reply YES to confirm you'll receive daily check-in alerts from them. Reply STOP to opt out.`;

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

  try {
    const params = new URLSearchParams({
      To: toNumber,
      From: TWILIO_PHONE_NUMBER,
      Body: message,
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await res.json();
    if (!res.ok) {
      return {
        statusCode: 502,
        headers: corsHeaders(),
        body: JSON.stringify({ success: false, error: data.message || 'Twilio error.' }),
      };
    }

    // Record this (userId, contact) pair as pending, keyed by the contact's phone number,
    // so the inbound webhook can resolve a later "YES" reply back to the right user/contact.
    const pendingStore = getConfiguredStore('checkin-pending-optins');
    const existing = (await pendingStore.get(toNumber, { type: 'json' })) || [];
    const filtered = existing.filter((p) => p.userId !== userId); // replace any prior pending entry for this pair
    filtered.push({ userId, name: contact.name, ownerName: displayOwnerName, sentAt: Date.now() });
    await pendingStore.setJSON(toNumber, filtered);

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ success: true, sid: data.sid }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': SITE_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
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
