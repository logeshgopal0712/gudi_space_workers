import { CONSTANTS } from "./constants.js";

const STRIPE_API_BASE = "https://api.stripe.com/v1";

function priceIdForPlan(plan) {
  if (plan === "yearly") return CONSTANTS.STRIPE_PRICE_YEARLY;
  return CONSTANTS.STRIPE_PRICE_MONTHLY; // default to monthly
}

// ---------------------------------------------------------
// Creates a Stripe Checkout Session (subscription mode, Stripe-hosted
// page) for the given email + plan ("monthly" | "yearly"). Returns the
// URL to redirect the browser to.
//
// successUrl/cancelUrl are passed in by the caller (the frontend knows
// its own origin) rather than hardcoded here, so this works the same
// whether it's called from the local dev server or the real deployed
// site.
// ---------------------------------------------------------
export async function createCheckoutSessionForStripe(env, { email, plan, successUrl, cancelUrl }) {
  if (!email || typeof email !== "string") {
    throw new Error("email is required");
  }
  if (!successUrl || !cancelUrl) {
    throw new Error("successUrl and cancelUrl are required");
  }

  const priceId = priceIdForPlan(plan);
  const resolvedPlan = plan === "yearly" ? "yearly" : "monthly";

  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("line_items[0][price]", priceId);
  params.set("line_items[0][quantity]", "1");
  params.set("customer_email", email);
  params.set("allow_promotion_codes", "true");
  params.set("success_url", successUrl);
  params.set("cancel_url", cancelUrl);
  // Stashed on the Checkout Session itself (handy for debugging in the
  // Stripe dashboard) and, more importantly, on the Subscription object
  // via subscription_data.metadata below - that's what lets the webhook
  // resolve which email a given subscription belongs to, since the
  // subscription/invoice webhook events don't carry the email directly.
  params.set("metadata[email]", email);
  params.set("metadata[plan]", resolvedPlan);
  params.set("subscription_data[metadata][email]", email);
  params.set("subscription_data[metadata][plan]", resolvedPlan);

  const response = await fetch(`${STRIPE_API_BASE}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const data = await response.json();

  if (!response.ok) {
    console.log("Stripe checkout session creation failed:", data);
    throw new Error(data?.error?.message || "Could not start checkout.");
  }

  return { url: data.url, sessionId: data.id };
}

// ---------------------------------------------------------
// Creates a Stripe Billing Portal session for an existing customer - the
// Stripe-hosted page where they can cancel, switch between the
// monthly/yearly prices (proration handled by Stripe), or update their
// card. Nothing to build ourselves here beyond this one call.
// ---------------------------------------------------------
export async function createPortalSession(env, { customerId, returnUrl }) {
  if (!customerId) {
    throw new Error("customerId is required");
  }
  if (!returnUrl) {
    throw new Error("returnUrl is required");
  }

  const params = new URLSearchParams();
  params.set("customer", customerId);
  params.set("return_url", returnUrl);

  const response = await fetch(`${STRIPE_API_BASE}/billing_portal/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const data = await response.json();

  if (!response.ok) {
    console.log("Stripe portal session creation failed:", data);
    throw new Error(data?.error?.message || "Could not open the billing portal.");
  }

  return { url: data.url };
}

// ---------------------------------------------------------
// Verifies a Stripe webhook's signature by hand (Workers can't use
// Stripe's Node SDK helper). Must be called with the RAW, untouched
// request body text - never a re-parsed/re-stringified version, or the
// signature won't match.
//
// Implements Stripe's documented scheme: HMAC-SHA256 over
// "<timestamp>.<rawBody>", compared against the v1 signature in the
// Stripe-Signature header. Also rejects anything older than 5 minutes,
// to block replay attacks.
// ---------------------------------------------------------
export async function verifyStripeWebhookSignature(rawBody, signatureHeader, webhookSecret) {
  if (!signatureHeader) {
    throw new Error("Missing Stripe-Signature header");
  }
  if (!webhookSecret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
  }

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((part) => part.split("="))
  );
  const timestamp = parts.t;
  const expectedSignature = parts.v1;

  if (!timestamp || !expectedSignature) {
    throw new Error("Malformed Stripe-Signature header");
  }

  const signedPayload = `${timestamp}.${rawBody}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signedPayload),
  );
  const computedSignature = Array.from(new Uint8Array(signatureBuffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  if (computedSignature !== expectedSignature) {
    throw new Error("Signature verification failed");
  }

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (ageSeconds > 300) {
    throw new Error("Webhook timestamp too old");
  }

  return true;
}

// ---------------------------------------------------------
// Maps a Stripe subscription object (from a webhook event) into the row
// shape subscription_db.js expects. Handles both API-version layouts for
// the period fields (older accounts carry them on the subscription
// itself, newer ones on the subscription item).
// ---------------------------------------------------------
function subscriptionFromStripeObject(subscription) {
  const item = subscription.items?.data?.[0];
  const price = item?.price;
  const interval = price?.recurring?.interval; // "month" | "year"

  const periodStart = subscription.current_period_start ?? item?.current_period_start;
  const periodEnd = subscription.current_period_end ?? item?.current_period_end;

  const promotionCode =
    subscription.discount?.promotion_code ||
    subscription.discounts?.[0]?.promotion_code ||
    null;

  return {
    email: subscription.metadata?.email || null,
    processor: "stripe",
    customerId: subscription.customer,
    subscriptionId: subscription.id,
    plan: interval === "year" ? "yearly" : "monthly",
    status: subscription.status,
    currency: price?.currency || null,
    amount: price?.unit_amount ?? null,
    promoCode: promotionCode,
    currentPeriodStart: periodStart ? new Date(periodStart * 1000).toISOString() : null,
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
  };
}

// ---------------------------------------------------------
// Applies a verified Stripe webhook event to the subscriptions table.
// `dbFns` is passed in (rather than imported directly) purely so
// worker.js's existing import list stays the single place that wires up
// D1 helpers - keeps this file free of a direct D1 dependency.
// ---------------------------------------------------------
export async function applyStripeWebhookEvent(env, event, { upsertSubscription, updateSubscriptionStatusById }) {
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const subscription = event.data.object;
      const row = subscriptionFromStripeObject(subscription);

      if (!row.email) {
        console.log(
          "Stripe webhook: subscription has no email in metadata, skipping.",
          subscription.id,
        );
        return;
      }

      await upsertSubscription(env, row);
      return;
    }
    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      await updateSubscriptionStatusById(env, subscription.id, "canceled");
      return;
    }
    default:
      // Ignore anything else - we only care about subscription lifecycle.
      return;
  }
}
