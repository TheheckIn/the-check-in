// netlify/functions/send-checkin.js
//
// Sends a one-tap "I'm OK" SMS to each contact using Twilio.
// Expects a POST body like:
// { "contacts": [{ "name": "Barb", "phone": "+17655550142" }, ...] }
//
// Requires an "X-App-Secret" header matching the APP_SHARED_SECRET
// environment variable, so random internet traffic can't trigger sends.

const SITE_ORIGIN = 'https://helpful-squirrel-b651a9.netlify.app';
const MAX_CONTACTS = 5;

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

  let contacts = Array.isArray(payload.contacts) ? payload.contacts : [];
  if (contacts.length === 0) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'No contacts provided.' }) };
  }

  if (contacts.length > MAX_CONTACTS) {
    contacts = contacts.slice(0, MAX_CONTACTS);
  }

  const message = payload.message || "This is my daily check-in from The Check In app — I'm okay!";
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

  const results = await Promise.all(
    contacts.map(async (contact) => {
      const toNumber = normalizePhone(contact.phone);
      if (!toNumber) {
        return { name: contact.name, phone: contact.phone, success: false, error: 'Invalid phone number.' };
      }
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
          return { name: contact.name, phone: toNumber, success: false, error: data.message || 'Twilio error.' };
        }
        return { name: contact.name, phone: toNumber, success: true, sid: data.sid };
      } catch (err) {
        return { name: contact.name, phone: toNumber, success: false, error: err.message };
      }
    })
  );

  const allSucceeded = results.every((r) => r.success);
  return {
    statusCode: allSucceeded ? 200 : 207, // 207 = partial success
    headers: corsHeaders(),
    body: JSON.stringify({ results }),
  };
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
