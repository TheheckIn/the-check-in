// netlify/functions/admin-delete-users.js
// TEMPORARY / ONE-TIME USE ONLY. Delete this file from the repo once used.
// Deletes specific accounts (by userId) from checkin-users, plus any
// leftover entries in checkin-send-log and checkin-missed-alerts, so
// they stop showing up anywhere including future missed-checkin runs.
const { getStore } = require('@netlify/blobs');

const ONE_TIME_SECRET = 'checkin-fix-8827-temp';

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

  const userIds = Array.isArray(body.userIds) ? body.userIds : [];
  if (userIds.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userIds array is required.' }) };
  }

  const getConfiguredStore = (name) =>
    getStore({
      name,
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });

  const usersStore = getConfiguredStore('checkin-users');
  const sendLogStore = getConfiguredStore('checkin-send-log');
  const missedAlertsStore = getConfiguredStore('checkin-missed-alerts');

  const deleted = [];
  for (const userId of userIds) {
    await usersStore.delete(userId);
    await sendLogStore.delete(userId);
    await missedAlertsStore.delete(userId);
    deleted.push(userId);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, deleted }),
  };
};
