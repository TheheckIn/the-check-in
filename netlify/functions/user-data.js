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

// Same shared secret used by send-optin.js / send-checkin.js. Blocks
// anyone who didn't load the real app page (and therefore doesn't have
// this value) from reading or overwriting another user's data by
// guessing/leaking a userId.
const APP_SECRET = 'd24a994e38134d02da9f2e877b019f6b67236a766185b1bc03689cf838735e86';

exports.handler = async (event) => {
  const providedSecret = event.headers['x-app-secret'] || event.headers['X-App-Secret'];
  if (providedSecret !== APP_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };
  }

  const store = getConfiguredStore('checkin-users');
  const userId = event.queryStringParameters && event.queryStringParameters.userId;
  if (!userId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing userId.' }) };
  }
  if (event.httpMethod === 'GET') {
    const data = await store.get(userId, { type: 'json' });
    // Also look up their most recent successful check-in send, so the
    // frontend can show "Last checked in: ..." on the home screen.
    const sendLogStore = getConfiguredStore('checkin-send-log');
    const sendHistory = (await sendLogStore.get(userId, { type: 'json' })) || [];
    const lastCheckIn = sendHistory.length > 0 ? Math.max(...sendHistory) : null;
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        ...(data || { contacts: [], checkInHour: 9, checkInMinute: 0 }),
        lastCheckIn,
      }),
    };
  }
  if (event.httpMethod === 'POST') {
    let payload;
    try {
      payload = JSON.parse(event.body);
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
    }
    // Merge onto the existing record instead of replacing it, so
    // server-only fields like foundingUser/subscriptionStatus survive
    // every contact/name edit.
    const existing = (await store.get(userId, { type: 'json' })) || {};

    // The client always sends its whole in-memory contacts array on every
    // save (add/remove/resend/rename), which can be stale relative to the
    // server if sms-webhook.js confirmed a contact in the meantime (e.g.
    // someone replied YES between when this device loaded its data and
    // when it saved). A blind overwrite here would silently revert that
    // confirmation back to "pending" with no error to anyone.
    //
    // Fix: 'confirmed' status is sticky per phone number. If the existing
    // record already has a contact confirmed at a given number, an
    // incoming payload for that same number can never downgrade it —
    // only sms-webhook.js (a real YES reply) is allowed to set the status
    // in the first place, so the client's copy is never the source of
    // truth for it. A contact the client genuinely removes just won't be
    // in payload.contacts at all, which still works as a real removal.
    let mergedPayload = payload;
    if (Array.isArray(payload.contacts) && Array.isArray(existing.contacts)) {
      const confirmedByPhone = new Map();
      for (const c of existing.contacts) {
        const norm = normalizePhone(c.phone);
        if (norm && c.status === 'confirmed') confirmedByPhone.set(norm, c);
      }
      mergedPayload = {
        ...payload,
        contacts: payload.contacts.map((c) => {
          const norm = normalizePhone(c.phone);
          if (norm && confirmedByPhone.has(norm) && c.status !== 'confirmed') {
            console.warn(`[user-data] Preventing stale downgrade of confirmed contact phone="${norm}" for userId="${userId}" (client sent status="${c.status}").`);
            return { ...c, status: 'confirmed' };
          }
          return c;
        }),
      };
    }

    const merged = { ...existing, ...mergedPayload };
    await store.setJSON(userId, merged);
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: true }),
    };
  }
  return { statusCode: 405, body: 'Method Not Allowed' };
};

// Converts a loosely formatted US number like "(765) 555-0142" into E.164 format "+17655550142"
// Kept in sync with the same helper in send-optin.js and sms-webhook.js.
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}
