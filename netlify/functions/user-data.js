const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const store = getStore('checkin-users');
  const userId = event.queryStringParameters && event.queryStringParameters.userId;

  if (!userId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing userId.' }) };
  }

  if (event.httpMethod === 'GET') {
    const data = await store.get(userId, { type: 'json' });
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(data || { contacts: [], checkInHour: 9, checkInMinute: 0 }),
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
