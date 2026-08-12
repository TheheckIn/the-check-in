// netlify/functions/admin-reset-phone-link.js
// TEMPORARY / ONE-TIME USE ONLY. Delete this file from the repo once used.
// Removes a phone number's entry from the checkin-phone-index store so it
// can be correctly re-claimed by verifying again.
const { getStore } = require('@netlify/blobs');

const ONE_TIME_SECRET = 'checkin-fix-8827-temp'; // change/remove after use

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

  if (body.secret !== ONE_TIME_SECRET) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  const phone = normalizePhone(body.phone);
  if (!phone) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid phone number' }) };
  }

  const indexStore = getStore({
    name: 'checkin-phone-index',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_API_TOKEN,
  });

  const existing = await indexStore.get(phone);
  await indexStore.delete(phone);

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, phone, previouslyLinkedTo: existing || null }),
  };
};
