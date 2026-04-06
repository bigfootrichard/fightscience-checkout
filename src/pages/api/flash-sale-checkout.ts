export const prerender = false;

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getProductById } from '../../data/flash-sale-products';

const stripe = new Stripe(import.meta.env.STRIPE_SECRET_KEY);
const ONTRAPORT_API_KEY = import.meta.env.ONTRAPORT_API_KEY || 'TEb2KY9mn3y0BC5';
const ONTRAPORT_APP_ID = import.meta.env.ONTRAPORT_APP_ID || '2_188475_25BL5Wepb';
const FLASH_SALE_STARTED_TAG = 'Flash Sale Started';

async function ontraportRequest(method: string, endpoint: string, body?: Record<string, unknown>) {
  const url = `https://api.ontraport.com/1/${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Api-Key': ONTRAPORT_API_KEY,
      'Api-Appid': ONTRAPORT_APP_ID,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
}

async function captureAbandonmentContact(email: string, firstName: string, lastName: string, productNames: string[]) {
  try {
    // Find or create contact
    const searchResult = await ontraportRequest('GET',
      `Contacts?search=${encodeURIComponent(email)}&searchNotes=true&range=1`
    );
    let contactId: string;
    if (searchResult?.data?.length > 0) {
      contactId = searchResult.data[0].id;
      await ontraportRequest('PUT', 'Contacts', {
        id: contactId,
        firstname: firstName,
        lastname: lastName,
      });
    } else {
      const createResult = await ontraportRequest('POST', 'Contacts', {
        firstname: firstName,
        lastname: lastName,
        email,
      });
      contactId = createResult?.data?.id;
    }

    if (contactId) {
      // Add "Flash Sale Started" tag
      await ontraportRequest('PUT', 'Contacts/tag', {
        objectID: 0,
        ids: [parseInt(contactId)],
        add_list: [FLASH_SALE_STARTED_TAG],
      });
    }
  } catch (err) {
    console.error('Failed to capture abandonment contact (non-blocking):', err);
  }
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const { email, firstName, lastName, productIds } = await request.json();

    if (!email || !firstName || !lastName || !productIds?.length) {
      return new Response(JSON.stringify({
        error: 'Missing required fields: email, firstName, lastName, productIds',
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Build Stripe line items from selected products
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
    const validProductIds: string[] = [];

    for (const id of productIds) {
      const product = getProductById(id);
      if (!product) continue;

      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: product.name,
            description: `${product.videoCount} videos — ${product.instructor}`,
            images: [`https://fightscience.com${product.image}`],
          },
          unit_amount: product.salePrice * 100, // cents
        },
        quantity: 1,
      });
      validProductIds.push(id);
    }

    if (!lineItems.length) {
      return new Response(JSON.stringify({
        error: 'No valid products selected',
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Calculate total for Meta pixel
    const totalAmount = validProductIds.reduce((sum, id) => {
      const p = getProductById(id);
      return sum + (p ? p.salePrice : 0);
    }, 0);
    const numItems = validProductIds.length;

    // Capture contact in Ontraport for abandonment tracking (non-blocking)
    const productNames = validProductIds.map(id => getProductById(id)?.name || '').filter(Boolean);
    captureAbandonmentContact(email, firstName, lastName, productNames).catch(() => {});

    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      line_items: lineItems,
      metadata: {
        firstName,
        lastName,
        email,
        productIds: validProductIds.join(','),
        source: 'checkout',
      },
      success_url: `https://sale.fightscience.com/flash-sale-success?session_id={CHECKOUT_SESSION_ID}&total=${totalAmount}&items=${numItems}`,
      cancel_url: 'https://sale.fightscience.com/',
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
