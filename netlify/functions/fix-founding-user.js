// netlify/functions/fix-founding-user.js
//
// ONE-TIME FIX. Sets foundingUser: true on the account tied to a phone number.
// Visit: https://checkinapp.org/.netlify/functions/fix-founding-user?phone=7702894666
//
// Delete this file (and remove it from GitHub) once you've confirmed the fix worked.

const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN;

  const rawPhone = event.queryStringParameters && event.queryStringParameters.phone;
  if (!rawPhone) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Pass ?phone=XXXXXXXXXX (digits only)" }),
    };
  }
  const phone = rawPhone.replace(/\D/g, "");

  try {
    const phoneIndex = getStore({ name: "checkin-phone-index", siteID, token });
    const users = getStore({ name: "checkin-users", siteID, token });

    const candidateKeys = [phone, `+1${phone}`, `1${phone}`];
    let userId = null;
    let matchedKey = null;
    for (const key of candidateKeys) {
      const val = await phoneIndex.get(key);
      if (val) {
        userId = val;
        matchedKey = key;
        break;
      }
    }

    if (!userId) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "No phone-index entry found", triedKeys: candidateKeys }),
      };
    }

    const raw = await users.get(userId);
    if (!raw) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "No user record found for that userId", userId }),
      };
    }

    let record = JSON.parse(raw);

    const before = {
      foundingUser: record.foundingUser,
      subscriptionStatus: record.subscriptionStatus,
    };

    record.foundingUser = true;

    await users.set(userId, JSON.stringify(record));

    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          message: "foundingUser set to true",
          userId,
          matchedKey,
          before,
          after: { foundingUser: record.foundingUser, subscriptionStatus: record.subscriptionStatus },
        },
        null,
        2
      ),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message, stack: err.stack }),
    };
  }
};
