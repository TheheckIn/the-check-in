// netlify/functions/lookup-user.js
//
// READ-ONLY diagnostic endpoint. Does not modify any data.
// Visit: https://checkinapp.org/.netlify/functions/lookup-user?phone=7702894666
//
// Looks up the phone-index record, then the matching user record,
// and returns the key fields needed to diagnose founding-user status.

const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN;

  const rawPhone = event.queryStringParameters && event.queryStringParameters.phone;
  if (!rawPhone) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Pass ?phone=XXXXXXXXXX (digits only, no dashes/parens)" }),
    };
  }
  // Normalize: strip everything except digits
  const phone = rawPhone.replace(/\D/g, "");

  try {
    const phoneIndex = getStore({ name: "checkin-phone-index", siteID, token });
    const users = getStore({ name: "checkin-users", siteID, token });

    // Try a couple of likely key formats since we don't know the exact convention
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
        body: JSON.stringify({
          error: "No phone-index entry found for that number",
          triedKeys: candidateKeys,
        }),
      };
    }

    const userRecordRaw = await users.get(userId);
    if (!userRecordRaw) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          error: "Phone index pointed to a userId with no matching user record",
          userId,
          matchedKey,
        }),
      };
    }

    let userRecord;
    try {
      userRecord = JSON.parse(userRecordRaw);
    } catch (e) {
      userRecord = userRecordRaw; // in case it's stored as a plain string
    }

    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          matchedPhoneKey: matchedKey,
          userId,
          foundingUser: userRecord.foundingUser,
          subscriptionStatus: userRecord.subscriptionStatus,
          isFoundingUser: userRecord.isFoundingUser, // in case this derived field is stored too
          fullRecord: userRecord,
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
