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
    await store.setJSON(userId, payload);
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: true }),
    };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
