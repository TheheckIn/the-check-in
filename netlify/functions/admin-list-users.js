// netlify/functions/admin-list-users.js
// TEMPORARY / ONE-TIME USE ONLY. Delete this file from the repo once used.
// Read-only listing of every account in checkin-users, so orphaned/test
// accounts from development can be identified before cleanup.
const { getStore } = require('@netlify/blobs');

const ONE_TIME_SECRET = 'checkin-fix-8827-temp'; // same secret pattern as before, change/remove after use

exports.handler = async (event) => {
  const secret = (event.queryStringParameters && event.queryStringParameters.secret) || '';
  if (secret !== ONE_TIME_SECRET) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  const usersStore = getStore({
    name: 'checkin-users',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_API_TOKEN,
  });

  const { blobs } = await usersStore.list();

  const results = [];
  for (const { key: userId } of blobs) {
    const data = await usersStore.get(userId, { type: 'json' });
    results.push({
      userId,
      ownerName: (data && data.ownerName) || null,
      foundingUser: !!(data && data.foundingUser),
      contacts: (data && Array.isArray(data.contacts))
        ? data.contacts.map((c) => `${c.name || '?'} (${c.phone || '?'}) [${c.status || '?'}]`)
        : [],
    });
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: results.length, users: results }, null, 2),
  };
};
