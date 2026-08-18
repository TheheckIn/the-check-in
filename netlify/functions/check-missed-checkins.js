// netlify/functions/check-missed-checkins.js
//
// Scheduled function (runs hourly, on the hour — via the schedule() wrapper
// below). Running hourly (rather than once a day) keeps the alert delay close to
// the actual 24-hour threshold — worst case ~1 hour late — instead of the
// up-to-48-hour gap a once-daily check could produce depending on what
// time of day someone's last check-in happened to land.
//
// Looks at every user's most recent successful check-in send. If it's been
// more than MISSED_THRESHOLD_HOURS since that check-in, this sends a short
// alert SMS to that user's CONFIRMED contacts letting them know.
//
// Where "last check-in" comes from:
// send-checkin.js does NOT store a timestamp on the user record. The only
// record of "when did this user last check in" is the array of successful
// send timestamps in the 'checkin-send-log' store (used there for rate
// limiting). We reuse the same log here as the source of truth — the most
// recent entry in that array IS the last check-in time.
//
// A user who has NEVER checked in has no entry in that store at all. We
// deliberately skip those users rather than guessing a baseline (e.g. "when
// they signed up") — alerting a brand new user's contacts on day one, before
// they've ever tapped the button, would be a false alarm.
//
// SECURITY: this function sends real SMS to real people with no human in
// the loop, so it must not be triggerable by an arbitrary HTTP request.
// Netlify tags genuine scheduled invocations with the
// "x-netlify-event: schedule" header. We fail closed if that's missing.

const { getStore } = require('@netlify/blobs');
const { schedule } = require('@netlify/functions');

const SITE_ORIGIN = 'https://helpful-squirrel-b651a9.netlify.app';
// 30 hours, not 24: the threshold is measured in raw elapsed time, not
// calendar days, and this function polls hourly. A strict 24-hour cutoff
// means anyone who checks in even slightly later than the previous day
// (e.g. 8am Monday, then 9:30am Tuesday — completely normal) gets flagged
// as "missed" and their contacts get a false alarm. 30 hours gives real
// daily-timing variance room to breathe while still catching genuine
// multi-day silence.
const MISSED_THRESHOLD_HOURS = 30;

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

exports.handler = schedule('0 * * * *', async (event) => {
  // Fail closed: only proceed if Netlify's scheduler triggered this, not
  // an arbitrary request to the function's public URL.
  if (!event.headers || event.headers['x-netlify-event'] !== 'schedule') {
    return { statusCode: 401, body: 'This function only runs on its schedule.' };
  }

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.error('Twilio environment variables are not configured.');
    return { statusCode: 500, body: 'Twilio environment variables are not configured.' };
  }

  const usersStore = getConfiguredStore('checkin-users');
  const sendLogStore = getConfiguredStore('checkin-send-log');
  const missedAlertsStore = getConfiguredStore('checkin-missed-alerts');

  const now = Date.now();
  const thresholdMs = MISSED_THRESHOLD_HOURS * 60 * 60 * 1000;

  const { blobs } = await usersStore.list();

  const summary = { checked: 0, skippedNoHistory: 0, alreadyAlerted: 0, alerted: 0, errors: 0 };

  for (const { key: userId } of blobs) {
    summary.checked += 1;
    try {
      const userData = await usersStore.get(userId, { type: 'json' });
      if (!userData || !Array.isArray(userData.contacts)) continue;

      const confirmedContacts = userData.contacts.filter((c) => c.status === 'confirmed');
      if (confirmedContacts.length === 0) continue;

      const sendHistory = (await sendLogStore.get(userId, { type: 'json' })) || [];
      if (sendHistory.length === 0) {
        // Never checked in — no baseline to measure "missed" against.
        summary.skippedNoHistory += 1;
        continue;
      }

      const lastCheckIn = Math.max(...sendHistory);
      const hoursSinceCheckIn = (now - lastCheckIn) / (1000 * 60 * 60);

      if (hoursSinceCheckIn < MISSED_THRESHOLD_HOURS) continue;

      // Don't re-alert every day for the same missed period — only alert
      // again once the user has checked in and then gone silent again.
      const alertRecord = await missedAlertsStore.get(userId, { type: 'json' });
      if (alertRecord && alertRecord.alertedForCheckIn === lastCheckIn) {
        summary.alreadyAlerted += 1;
        continue;
      }

      const displayName = (userData.ownerName && userData.ownerName.trim()) || null;
      const message = displayName
        ? `The Check In alert: ${displayName} hasn't checked in for over 24 hours. You may want to reach out.`
        : "The Check In alert: someone who has you listed as a check-in contact hasn't checked in for over 24 hours. You may want to reach out to them.";

      const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
      const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

      const results = await Promise.all(
        confirmedContacts.map(async (contact) => {
          const toNumber = normalizePhone(contact.phone);
          if (!toNumber) return { phone: contact.phone, success: false, error: 'Invalid phone number.' };
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
            if (!res.ok) return { phone: toNumber, success: false, error: data.message || 'Twilio error.' };
            return { phone: toNumber, success: true, sid: data.sid };
          } catch (err) {
            return { phone: toNumber, success: false, error: err.message };
          }
        })
      );

      const anySucceeded = results.some((r) => r.success);
      if (anySucceeded) {
        await missedAlertsStore.setJSON(userId, {
          alertedForCheckIn: lastCheckIn,
          alertSentAt: now,
        });
        summary.alerted += 1;
      } else {
        summary.errors += 1;
        console.error(`All missed-checkin alerts failed for user ${userId}:`, results);
      }
    } catch (err) {
      summary.errors += 1;
      console.error(`Error processing missed-checkin for user ${userId}:`, err);
    }
  }

  console.log('Missed check-in run summary:', JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
});

// Converts a loosely formatted US number like "(765) 555-0142" into E.164 format "+17655550142"
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}
