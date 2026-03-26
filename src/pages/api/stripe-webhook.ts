export const prerender = false;

import type { APIRoute } from 'astro';
import Stripe from 'stripe';

const stripe = new Stripe(import.meta.env.STRIPE_SECRET_KEY);
const STRIPE_WEBHOOK_SECRET = import.meta.env.STRIPE_WEBHOOK_SECRET;
const ONTRAPORT_WEBHOOK_SECRET = import.meta.env.ONTRAPORT_WEBHOOK_SECRET || 'yPp!MxFhN33@JyDrNANSM9MpehG8N';
const ONTRAPORT_API_KEY = import.meta.env.ONTRAPORT_API_KEY || 'TEb2KY9mn3y0BC5';
const ONTRAPORT_APP_ID = import.meta.env.ONTRAPORT_APP_ID || '2_188475_25BL5Wepb';
const MEMBERS_WEBHOOK_URL = 'https://fightscience.tv/api/webhook/ontraport';
const FLASH_SALE_DELIVERY_AUTOMATION_ID = 251;
const ADMIN_EMAIL = 'support@fightinstrong.org';
const FLASH_SALE_STARTED_TAG = 'Flash Sale Started';
const FLASH_SALE_PURCHASED_TAG = 'Flash Sale Purchased';

async function ontraportRequest(method: string, endpoint: string, body?: Record<string, unknown>) {
  const url = `https://api.ontraport.com/1/${endpoint}`;
  const options: RequestInit = {
    method,
    headers: {
      'Api-Key': ONTRAPORT_API_KEY,
      'Api-Appid': ONTRAPORT_APP_ID,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
}

async function findOrCreateContact(email: string, firstName: string, lastName: string) {
  const searchResult = await ontraportRequest('GET',
    `Contacts?search=${encodeURIComponent(email)}&searchNotes=true&range=1`
  );
  if (searchResult?.data?.length > 0) {
    return searchResult.data[0].id;
  }
  const createResult = await ontraportRequest('POST', 'Contacts', {
    firstname: firstName,
    lastname: lastName,
    email: email,
  });
  return createResult?.data?.id;
}

async function grantCourseAccess(email: string, firstName: string, lastName: string, productId: string) {
  const res = await fetch(MEMBERS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      first_name: firstName,
      last_name: lastName,
      action: 'purchase',
      product_id: productId,
      secret: ONTRAPORT_WEBHOOK_SECRET,
    }),
  });
  return res.ok;
}

const FLASH_SALE_PRICES: Record<string, number> = {
  '468': 27, '469': 27, '470': 27, '471': 19, '472': 37, '473': 27,
  '474': 47, '475': 17, '476': 27, '477': 47, '478': 37, '479': 27,
  '480': 47, '460': 99, '461': 197, '485': 37, '486': 37, '487': 37,
  '488': 47, '490': 37, '491': 37, '492': 27, '493': 19, '494': 37,
  '495': 37, '496': 47, '497': 47, '498': 19, '465': 99,
};

async function logOntraportTransaction(contactId: string, productIds: string[]) {
  try {
    await ontraportRequest('POST', 'transaction/processManual', {
      contact_id: parseInt(contactId),
      chargeNow: 'chargeLog',
      offer: {
        products: productIds.map(id => ({
          id: parseInt(id),
          quantity: 1,
          total: FLASH_SALE_PRICES[id] || 0,
          price: [{ price: FLASH_SALE_PRICES[id] || 0, payment_count: 1, unit: 'month' }],
        })),
      },
    });
  } catch (err) {
    console.error('Failed to log Ontraport transaction (non-blocking):', err);
  }
}

export const POST: APIRoute = async ({ request }) => {
  const body = await request.text();
  const sig = request.headers.get('stripe-signature');

  if (!sig) {
    return new Response('Missing stripe-signature header', { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Stripe webhook signature verification failed:', message);
    return new Response(`Webhook Error: ${message}`, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const metadata = session.metadata || {};

    const email = metadata.email || session.customer_email || '';
    const firstName = metadata.firstName || '';
    const lastName = metadata.lastName || '';
    const productIds = (metadata.productIds || '').split(',').filter(Boolean);

    if (!email || !productIds.length) {
      console.error('Missing email or productIds in session metadata');
      return new Response('Missing metadata', { status: 400 });
    }

    // Step 1: Grant course access for each product via Replit webhook
    const results: { productId: string; success: boolean }[] = [];
    for (const productId of productIds) {
      const success = await grantCourseAccess(email, firstName, lastName, productId);
      results.push({ productId, success });
      if (!success) {
        console.error(`Failed to grant access for product ${productId}, email: ${email}`);
      }
    }

    // Step 2: Log the transaction in Ontraport + send delivery email
    const contactId = await findOrCreateContact(email, firstName, lastName);
    if (contactId) {
      await logOntraportTransaction(contactId, productIds);

      // Step 3: Add contact to Flash Sale Delivery automation to send confirmation email
      try {
        await ontraportRequest('PUT', 'objects/subscribe', {
          objectID: 0,
          ids: [parseInt(contactId)],
          add_list: [FLASH_SALE_DELIVERY_AUTOMATION_ID],
        });
      } catch (err) {
        console.error('Failed to add contact to delivery automation (non-blocking):', err);
      }

      // Step 4: Remove "Flash Sale Started" tag, add "Flash Sale Purchased" tag
      try {
        await ontraportRequest('DELETE', 'Contacts/tag', {
          objectID: 0,
          ids: [parseInt(contactId)],
          remove_list: [FLASH_SALE_STARTED_TAG],
        });
        await ontraportRequest('PUT', 'Contacts/tag', {
          objectID: 0,
          ids: [parseInt(contactId)],
          add_list: [FLASH_SALE_PURCHASED_TAG],
        });
      } catch (err) {
        console.error('Failed to update tags (non-blocking):', err);
      }
    }

    // Step 5: Send admin notification email
    const totalAmount = (session.amount_total || 0) / 100;
    const productNames = productIds.map(id => {
      const names: Record<string, string> = {
        '468': 'Back Attacks 101', '469': 'Gi Chokes 101', '470': 'Triangle 101',
        '471': 'Kneebar 101', '472': 'Escapes & Counters', '473': 'Closed Guard 101',
        '474': 'BJJ Academy', '475': 'Arm Drag Formula', '476': 'Breaking Guard',
        '477': 'Ground Forces Grappling Assault', '478': 'Unorthodox Leglocks',
        '479': 'Jeff Glover Half Guard', '480': 'Anibal Braga Collection',
        '460': "Babu's BJJ Mastermind", '461': 'Ultimate Muay Thai',
        '485': 'Master Toddy MT', '486': 'Clinch Wizard', '487': 'Punishment MT',
        '488': 'Keatkhamtorn MT', '490': 'Ground & Pound Bible',
        '491': 'Chute Boxe MMA', '492': 'The Law (Lindland)',
        '493': 'Half Hook (Lindland)', '494': 'Rock Solid Wrestling',
        '495': 'Takedowns & Doubles', '496': 'Bulletproof Wrestling Drills',
        '497': 'Clinch Domination', '498': 'Arm Drag & Throws',
        '465': 'How To Win A Street Fight',
      };
      return names[id] || id;
    });
    console.log(`ADMIN NOTIFICATION — Flash Sale Purchase:
      Customer: ${firstName} ${lastName} (${email})
      Total: $${totalAmount}
      Products: ${productNames.join(', ')}
      Stripe Session: ${session.id}`);

    console.log(`Flash sale fulfilled: ${email}, products: ${productIds.join(',')}, results:`, results);
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
