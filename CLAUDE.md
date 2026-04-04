# FightScience Sale / Flash Sale Checkout — Claude Workspace

**Site:** https://sale.fightscience.com
**Repo:** github.com/bigfootrichard/fightscience-checkout (private — verify)
**Hosted:** Vercel (serverless, @astrojs/vercel adapter)
**Stack:** Astro 6.0 (SSR) + Stripe 21 + Ontraport API

This is the **flash sale checkout app**. Customers land here during flash sales, pick one or more courses, pay via Stripe Checkout, and get course access automatically. It's a thin app — a landing page, a checkout API, and a Stripe webhook that fans out fulfillment.

**Companion repos:**
- `../members-area/fs-members-replit/` — receives the grant-access webhook call (fightscience.tv)
- `../main-site/fightscience/` — the marketing site (fightscience.com)

---

## What this app does

### User flow
1. Customer lands at `sale.fightscience.com` (during a flash sale)
2. Picks one or more products from the flash sale menu (`src/data/flash-sale-products.ts`)
3. Enters email + name, clicks checkout
4. App creates a Stripe Checkout Session and redirects customer to Stripe
5. Customer pays
6. Stripe fires `checkout.session.completed` webhook → `/api/stripe-webhook`
7. Webhook grants course access + logs the transaction in Ontraport + tags the contact
8. Customer is redirected to `/flash-sale-success` with session ID in URL
9. Customer receives delivery email (sent by Ontraport automations per product, NOT by this app)
10. Customer logs into fightscience.tv with temp password `fs2026`, forced to change on first login

### Abandonment tracking
When a checkout session is CREATED (before payment), `/api/flash-sale-checkout` also captures the contact in Ontraport and tags them `"Flash Sale Started"`. This is fire-and-forget (non-blocking, `.catch(() => {})`). If they complete the purchase, `/api/stripe-webhook` removes that tag and adds `"Flash Sale Purchased"` instead. Un-converted contacts keep the "Flash Sale Started" tag for abandonment follow-up sequences.

---

## The fulfillment chain (critical)

**When a flash sale purchase completes, 3 things happen server-side, in order:**

### Step 1 — Grant course access via members-area webhook
For each `productId` in the Stripe session metadata, POST to:
```
https://fightscience.tv/api/webhook/ontraport
```
With body:
```json
{
  "email": "...",
  "first_name": "...",
  "last_name": "...",
  "action": "purchase",
  "product_id": "468",
  "secret": "<ONTRAPORT_WEBHOOK_SECRET>"
}
```
This is the SAME endpoint that Ontraport's own automations use. The members-area webhook looks up the product_id in its `PRODUCT_MAP` → grants Supabase access. See `../members-area/fs-members-replit/CLAUDE.md` for how the other end works.

**This means:** the `product_id` values in `FLASH_SALE_PRICES` (stripe-webhook.ts:64-70) and in `src/data/flash-sale-products.ts` MUST match Ontraport product IDs (SKU-468 through SKU-503, plus bundles 460/461/465). If they drift, grants will fail silently.

### Step 2 — Log transaction in Ontraport
Via Ontraport API `transaction/processManual` with `chargeNow: 'chargeLog'` (logs the charge without actually charging — Stripe already did the charging). Uses the `FLASH_SALE_PRICES` table to record amounts.

**Why log manually:** Ontraport doesn't know about Stripe. Without this, Ontraport revenue reports don't include flash sale purchases.

### Step 3 — Update tags
- Remove `"Flash Sale Started"` tag (set during checkout creation)
- Add `"Flash Sale Purchased"` tag

---

## Flash sale product catalog

**Source of truth:** `src/data/flash-sale-products.ts`

Each product entry needs:
- `id` — must match an Ontraport product ID (SKU-468 through SKU-503, or a bundle)
- `name`, `description`, `image`, `instructor`, `videoCount`
- `salePrice` — flash sale price in USD (e.g., 27, 37, 47, 97)

**Pricing table is duplicated** in `src/pages/api/stripe-webhook.ts` (`FLASH_SALE_PRICES`) for transaction logging. **Both must stay in sync.** If you change a sale price, change it in both places.

**Product name table is duplicated a THIRD time** in `stripe-webhook.ts` (the admin notification email block, lines ~157-172). Also must stay in sync.

⚠️ **Triple-duplication is a footgun.** When adding/renaming a product, update:
1. `src/data/flash-sale-products.ts`
2. `stripe-webhook.ts` `FLASH_SALE_PRICES`
3. `stripe-webhook.ts` admin notification `names` map
4. The corresponding entry in `../members-area/fs-members-replit/src/pages/api/webhook/ontraport.ts` (`PRODUCT_MAP` + `ACCESS_LEVEL_MAP` + `BUNDLE_COURSE_FIELDS` + `ACCESS_LEVEL_NICHE`)

**Consider refactoring** to a single shared data file at some point. Not urgent.

---

## Pages & Routes

| Route | File | Purpose |
|---|---|---|
| `/` | `src/pages/index.astro` | Flash sale landing — product selection + checkout form |
| `/flash-sale-success` | `src/pages/flash-sale-success.astro` | Post-purchase thank you page (receives `session_id`, `total`, `items` from Stripe redirect) |
| `POST /api/flash-sale-checkout` | `src/pages/api/flash-sale-checkout.ts` | Creates Stripe Checkout Session + captures abandonment contact |
| `POST /api/stripe-webhook` | `src/pages/api/stripe-webhook.ts` | Stripe webhook → grants access, logs transaction, updates tags |

**Layouts:** `BaseLayout.astro`, `SalesLayout.astro`.

---

## Environment Variables (Vercel)

See `.env.example` for the full list with instructions. Summary:

- `STRIPE_SECRET_KEY` — Stripe secret (prod: `sk_live_...`, test: `sk_test_...`)
- `STRIPE_WEBHOOK_SECRET` — Verifies incoming Stripe webhook signatures (`whsec_...`)
- `ONTRAPORT_API_KEY`, `ONTRAPORT_APP_ID` — For contact creation, transaction logging, tag updates
- `ONTRAPORT_WEBHOOK_SECRET` — Must match the one set in `fightscience.tv` (members-area). If these drift, access grants fail silently.

**Critical:** `ONTRAPORT_WEBHOOK_SECRET` here and in members-area **must be identical**. If you rotate one, rotate the other in the same deploy.

---

## Stripe Webhook Setup (one-time)

The Stripe webhook endpoint (`POST /api/stripe-webhook`) must be registered in the Stripe dashboard:
- **URL:** `https://sale.fightscience.com/api/stripe-webhook`
- **Event:** `checkout.session.completed`
- **Signing secret:** copy to `STRIPE_WEBHOOK_SECRET` env var in Vercel

If this isn't set, Stripe can't verify the webhook signature and everything fails at `constructEvent`.

---

## Dev Loop

```bash
npm install
npm run dev      # astro dev — local on :4321
npm run build    # builds for Vercel serverless
npm run preview  # preview production build
```

**Testing locally:**
- Use Stripe test mode keys (`sk_test_...`)
- Use Stripe CLI to forward webhooks to localhost: `stripe listen --forward-to localhost:4321/api/stripe-webhook`
- The CLI provides a webhook signing secret — use that as `STRIPE_WEBHOOK_SECRET` for local dev
- Test purchases use Stripe test cards (4242 4242 4242 4242)

**Deploy:** push to `main` → Vercel auto-deploys. Env vars live in Vercel dashboard.

---

## Security notes

- `stripe-webhook.ts` verifies signature via `stripe.webhooks.constructEvent(body, sig, STRIPE_WEBHOOK_SECRET)`. Never bypass this. Without verification, anyone can POST fake purchase events and grant themselves free courses.
- `flash-sale-checkout.ts` does NOT verify anything on input — it just takes email/name/productIds from the client. That's fine because the actual money still has to clear Stripe before access is granted.
- Ontraport API key + webhook secret have **hardcoded fallback values in the source code** (stripe-webhook.ts:8-10, flash-sale-checkout.ts:8-9). These leak into git history. Not urgent to fix, but prefer env vars over fallbacks — remove the fallbacks at some point.
- `ADMIN_EMAIL = 'support@fightinstrong.org'` is currently a log-only reference. No admin email is actually sent — it's just a console.log. If you want real admin notifications, wire up Resend or SendGrid.

---

## Rules for working on this codebase

1. **Never break the members-area webhook call.** Test the full purchase flow end-to-end (Stripe test mode → real webhook → members-area dev env) before deploying pricing or product changes.
2. **Product data lives in 4 places (see "Flash sale product catalog"). Updates must be atomic — all 4 in one commit.** Otherwise Stripe charges for one product and members-area grants access to a different one.
3. **Never hardcode prices in pages.** Pull from `src/data/flash-sale-products.ts`.
4. **Stripe webhook signature verification is load-bearing security.** Don't disable or short-circuit it, even for debugging.
5. **Ontraport API calls are non-blocking by design.** The main flow (Stripe → members-area webhook) must succeed even if Ontraport tagging/logging fails. Preserve that pattern.
6. **`ONTRAPORT_WEBHOOK_SECRET` must match fightscience.tv.** Changing one without the other = silent access grant failures.
7. **Deploy is automatic on push to `main`.** Test in Stripe test mode before merging.
8. **When testing live, use a throwaway email.** Test purchases create real contacts in Ontraport and real users in Supabase. Clean them up afterward or they pollute reports.
9. **Delivery emails come from Ontraport automations, NOT from this app.** Don't add email-sending code here — add an automation on the product in Ontraport.
