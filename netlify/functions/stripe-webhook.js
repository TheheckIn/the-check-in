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
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const signature = event.headers['stripe-signature'];
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : event.body;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const userId = session.client_reference_id;

    if (userId) {
      const store = getConfiguredStore('checkin-users');
      const existing = (await store.get(userId, { type: 'json' })) || {};
      const updated = {
        ...existing,
        subscriptionStatus: 'active',
        stripeCustomerId: session.customer,
        subscribedAt: Date.now(),
      };
      await store.setJSON(userId, updated);
      console.log(`User ${userId} marked as subscribed.`);
    } else {
      console.error('Checkout session completed but no client_reference_id found.');
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
