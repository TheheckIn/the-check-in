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
// UTC calendar day. Without this, someone (accidentally or on
// purpose) tapping the button repeatedly would send — and get billed for —
// a fresh round of SMS to every contact each time. This is a real cost
// leak on a per-message-billed product, so it's enforced server-side,
// not just hidden by disabling the button in the browser (which a refresh
// or a second tab would bypass). The limit is deliberately more than 1 so
// a genuine resend (forgot a contact, mistyped a number, wanted to confirm
// it went through) isn't blocked — only sustained spamming is.
//
// The count resets at midnight US/Eastern time (not UTC, and not per-user —
// there's no reliable way to know an individual contact's timezone, so one
// fixed zone is used for everyone). This is intentionally different from
// the midnight-UTC boundary used elsewhere in the app (status banner,
// missed check-in logic); Eastern was chosen here specifically so the
// reset lines up with when Robert and his beta testers actually experience
// "midnight," since that's who the app currently serves. This is NOT a
// rolling 24-hour window — a send at 11:55pm Eastern and another at
// 12:05am Eastern count against two different days, even though only
// 10 minutes apart.

const { getStore } = require('@netlify/blobs');

const SITE_ORIGIN = 'https://helpful-squirrel-b651a9.netlify.app';
const MAX_CONTACTS = 3;
const MAX_SENDS_PER_DAY = 3;

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

// Returns the timestamp (ms) of the most recent midnight US/Eastern time
// (handles the EST/EDT switch automatically). Any send at or after this
// timestamp counts as "today."
//
// This is intentionally hardcoded to Eastern, not per-user — the app has
// no reliable way to know an individual contact's timezone, so one fixed
//
