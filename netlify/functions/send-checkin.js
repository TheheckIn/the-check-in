// netlify/functions/send-checkin.js
//
// Sends a one-tap "I'm OK" SMS to each contact using Twilio.
// Expects a POST body like:
// { "contacts": [{ "name": "Barb", "phone": "+17655550142" }, ...] }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Twilio environment variables are not configured.' }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
  }

  const contacts = Array.isArray(payload.contacts) ? payload.contacts : [];
  if (contacts.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No contacts provided.' }) };
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
    body: JSON.stringify({ results }),
  };
};

// Converts a loosely formatted US number like "(765) 555-0142" into E.164 format "+17655550142"
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
