import Stripe from 'stripe';

const prerender = false;
const stripe = new Stripe(undefined                                 );
const STRIPE_WEBHOOK_SECRET = undefined                                     ;
const ONTRAPORT_WEBHOOK_SECRET = "yPp!MxFhN33@JyDrNANSM9MpehG8N";
const ONTRAPORT_API_KEY = "TEb2KY9mn3y0BC5";
const ONTRAPORT_APP_ID = "2_188475_25BL5Wepb";
const MEMBERS_WEBHOOK_URL = "https://fightscience.tv/api/webhook/ontraport";
const FLASH_SALE_DELIVERY_AUTOMATION_ID = 251;
async function ontraportRequest(method, endpoint, body) {
  const url = `https://api.ontraport.com/1/${endpoint}`;
  const options = {
    method,
    headers: {
      "Api-Key": ONTRAPORT_API_KEY,
      "Api-Appid": ONTRAPORT_APP_ID,
      "Content-Type": "application/json"
    }
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}
async function findOrCreateContact(email, firstName, lastName) {
  const searchResult = await ontraportRequest(
    "GET",
    `Contacts?search=${encodeURIComponent(email)}&searchNotes=true&range=1`
  );
  if (searchResult?.data?.length > 0) {
    return searchResult.data[0].id;
  }
  const createResult = await ontraportRequest("POST", "Contacts", {
    firstname: firstName,
    lastname: lastName,
    email
  });
  return createResult?.data?.id;
}
async function grantCourseAccess(email, firstName, lastName, productId) {
  const res = await fetch(MEMBERS_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      first_name: firstName,
      last_name: lastName,
      action: "purchase",
      product_id: productId,
      secret: ONTRAPORT_WEBHOOK_SECRET
    })
  });
  return res.ok;
}
async function logOntraportTransaction(contactId, productIds) {
  try {
    await ontraportRequest("POST", "transaction/processManual", {
      contact_id: parseInt(contactId),
      chargeNow: "chargeLog",
      offer: {
        products: productIds.map((id) => ({ id: parseInt(id), quantity: 1 }))
      }
    });
  } catch (err) {
    console.error("Failed to log Ontraport transaction (non-blocking):", err);
  }
}
const POST = async ({ request }) => {
  const body = await request.text();
  const sig = request.headers.get("stripe-signature");
  if (!sig) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Stripe webhook signature verification failed:", message);
    return new Response(`Webhook Error: ${message}`, { status: 400 });
  }
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const metadata = session.metadata || {};
    const email = metadata.email || session.customer_email || "";
    const firstName = metadata.firstName || "";
    const lastName = metadata.lastName || "";
    const productIds = (metadata.productIds || "").split(",").filter(Boolean);
    if (!email || !productIds.length) {
      console.error("Missing email or productIds in session metadata");
      return new Response("Missing metadata", { status: 400 });
    }
    const results = [];
    for (const productId of productIds) {
      const success = await grantCourseAccess(email, firstName, lastName, productId);
      results.push({ productId, success });
      if (!success) {
        console.error(`Failed to grant access for product ${productId}, email: ${email}`);
      }
    }
    const contactId = await findOrCreateContact(email, firstName, lastName);
    if (contactId) {
      await logOntraportTransaction(contactId, productIds);
      try {
        await ontraportRequest("PUT", "objects/subscribe", {
          objectID: 0,
          ids: [parseInt(contactId)],
          add_list: [FLASH_SALE_DELIVERY_AUTOMATION_ID]
        });
      } catch (err) {
        console.error("Failed to add contact to delivery automation (non-blocking):", err);
      }
    }
    console.log(`Flash sale fulfilled: ${email}, products: ${productIds.join(",")}, results:`, results);
  }
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
};

const _page = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
  __proto__: null,
  POST,
  prerender
}, Symbol.toStringTag, { value: 'Module' }));

const page = () => _page;

export { page };
