const Stripe = require('stripe');
const { getStore } = require('@netlify/blobs');

function getConfiguredStore(name) {
  return getStore({
    name,
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_API_TOKEN,
  });
}

// Finds the userId whose record has the given Stripe customer id. Checks
// the fast checkin-customer-index lookup first (populated going forward
// at checkout time, below), then falls back to a one-time scan of
// checkin-users for any account that predates that index — like Robert's,
// subscribed before this handler existed. Backfills the index once found
// so the scan is never needed twice for the same customer.
async function findUserIdByCustomerId(customerId) {
  const customerIndex = getConfiguredStore('checkin-customer-index');
  const mapped = await customerIndex.get(customerId);
  if (mapped) return mapped;

  const usersStore = getConfiguredStore('checkin-users');
  const { blobs } = await usersStore.list();
  for (const { key } of blobs) {
    const data = await usersStore.get(key, { type: 'json' });
    if (data && data.stripeCustomerId === customerId) {
      await customerIndex.set(customerId, key);
      return key;
    }
  }
  return null;
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

      // Keep customer -> userId indexed so a later cancellation event
      // (which only carries the Stripe customer id, not our userId) can
      // find its way back to the right account.
      if (session.customer) {
        const customerIndex = getConfiguredStore('checkin-customer-index');
        await customerIndex.set(session.customer, userId);
      }

      console.log(`User ${userId} marked as subscribed.`);
    } else {
      console.error('Checkout session completed but no client_reference_id found.');
    }
  }

  if (stripeEvent.type === 'customer.subscription.deleted') {
    const subscription = stripeEvent.data.object;
    const customerId = subscription.customer;
    const userId = await findUserIdByCustomerId(customerId);

    if (userId) {
      const store = getConfiguredStore('checkin-users');
      const existing = (await store.get(userId, { type: 'json' })) || {};
      await store.setJSON(userId, {
        ...existing,
        subscriptionStatus: 'canceled',
        canceledAt: Date.now(),
      });
      console.log(`User ${userId} subscription canceled.`);
    } else {
      console.error(`Subscription deleted for customer ${customerId}, but no matching user was found.`);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
