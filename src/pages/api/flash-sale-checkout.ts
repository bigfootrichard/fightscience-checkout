export const prerender = false;

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getProductById } from '../../data/flash-sale-products';

const stripe = new Stripe(import.meta.env.STRIPE_SECRET_KEY);

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
        source: 'flash-sale',
      },
      success_url: 'https://sale.fightscience.com/flash-sale-success?session_id={CHECKOUT_SESSION_ID}',
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
