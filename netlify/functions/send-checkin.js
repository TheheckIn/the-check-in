// netlify/functions/send-checkin.js
//
// Sends a one-tap "I'm OK" SMS to each contact using Twilio.
// Expects a POST body like:
// { "userId": "abc123", "contacts": [{ "name": "Barb", "phone": "+17655550142" }, ...] }
//
// Requires an "X-App-Secret" header matching the APP_SHARED_SECRET
// environment variable, so random internet traffic can't trigger sends.
//
// DAILY LIMIT: a user can send at most MAX_SENDS_PER_DAY check-ins per
// calendar day, where "day" is a US/Eastern calendar day (midnight to
// midnight Eastern, DST-safe). Without this, someone (accidentally or on
// purpose) tapping the button repeatedly would send — and get billed for —
// a fresh round of SMS to every contact each time. This is a real cost
// leak on a per-message-billed product, so it's enforced server-side,
// not just hidden by disabling the button in the browser (which a refresh
// or a second tab would bypass). The limit is deliberately more than 1 so
// a genuine resend (forgot a contact, mistyped a number, wanted to confirm
// it went through) isn't blocked — only sustained spamming is.
//
// This is a CALENDAR-DAY count, not a rolling window. A send at 11:55pm
// Eastern and another at 12:05am Eastern count against two different days,
// even though only 10 minutes apart — the counter simply resets at
// midnight Eastern rather than "24 hours after your last send." There is
// no "come back at X PM" cooldown; the user can send all 3 back-to-back if
// they want, they just can't send a 4th until the calendar day rolls over.

const { getStore } = require('@netlify/blobs');

const SITE_ORIGIN = 'https://helpful-squirrel-b651a9.netlify.app';
const MAX_CONTACTS = 3;
const MAX_SENDS_PER_DAY = 3;
const RESET_TIMEZONE = 'America/New_York';

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

// Returns a stable "YYYY-MM-DD" string for the given timestamp, computed
// in US/Eastern time. Two timestamps produce the same string if and only
// if they fall on the same Eastern calendar day. This automatically
// handles the EST/EDT switch because it asks the JS runtime for the wall-
// clock date in that named timezone, rather than doing manual UTC offset
// math.
function easternDateString(ts) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: RESET_TIMEZONE });
  // 'en-CA' locale formats as YYYY-MM-DD, which sorts/compares correctly
  // and is unambiguous (unlike en-US's MM/DD/YYYY).
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

  let contacts = Array.isArray(payload.contacts) ? payload.contacts : [];
  if (contacts.length === 0) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'No contacts provided.' }) };
  }

  if (contacts.length > MAX_CONTACTS) {
    contacts = contacts.slice(0, MAX_CONTACTS);
  }

  const userId = payload.userId;
  if (!userId) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Missing userId.' }) };
  }

  // Daily limit check: block if this user has already sent MAX_SENDS_PER_DAY
  // check-ins on today's Eastern calendar day.
  const sendLogStore = getConfiguredStore('checkin-send-log');
  const sendHistory = (await sendLogStore.get(userId, { type: 'json' })) || [];
  const now = Date.now();
  const todayStr = easternDateString(now);
  const todaysSends = sendHistory.filter((ts) => easternDateString(ts) === todayStr);

  if (todaysSends.length >= MAX_SENDS_PER_DAY) {
    return {
      statusCode: 429,
      headers: corsHeaders(),
      body: JSON.stringify({
        error: "You've used all 3 check-ins for today.",
        rateLimited: true,
        sendsRemaining: 0,
        maxSendsPerDay: MAX_SENDS_PER_DAY,
      }),
    };
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
  const anySucceeded = results.some((r) => r.success);

  // Only record this as a "used" send if at least one message actually went
  // out — a fully failed attempt (bad numbers, Twilio outage) shouldn't eat
  // into the user's limited sends for the day.
  let sendsRemaining = MAX_SENDS_PER_DAY - todaysSends.length;
  let checkinNumber = todaysSends.length; // 0 if this attempt fails entirely
  if (anySucceeded) {
    // Keep only today's Eastern-day sends going forward — old days are
    // irrelevant once the date string no longer matches.
    const updatedHistory = [...todaysSends, now];
    await sendLogStore.setJSON(userId, updatedHistory);
    sendsRemaining = MAX_SENDS_PER_DAY - updatedHistory.length;
    checkinNumber = updatedHistory.length;
  }

  return {
    statusCode: allSucceeded ? 200 : 207, // 207 = partial success
    headers: corsHeaders(),
    body: JSON.stringify({ results, sendsRemaining, checkinNumber, maxSendsPerDay: MAX_SENDS_PER_DAY }),
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
