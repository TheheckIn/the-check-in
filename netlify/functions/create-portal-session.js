const Stripe = require('stripe');
const { getStore } = require('@netlify/blobs');

function getConfiguredStore(name) {
  return getStore({
    name,
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_API_TOKEN,
  });
}

exports.handler = async (event) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const { userId } = JSON.parse(event.body || '{}');

    if (!userId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing userId' })
      };
    }

    const store = getConfiguredStore('checkin-users');
    const userData = await store.get(userId, { type: 'json' });
    const stripeCustomerId = userData && userData.stripeCustomerId;

    if (!stripeCustomerId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No active subscription found for this account' })
      };
    }

    const siteUrl = process.env.URL || 'https://checkinapp.org';
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: siteUrl,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ url: session.url })
    };
  } catch (error) {
    console.error('Portal session error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to create portal session' })
    };
  }
};
