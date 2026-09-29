// ---------------------------------------------------------
// D1 helpers for the `subscriptions` table - one row per Stripe/Razorpay
// subscription, kept in sync via webhook events (see stripe_util.js).
// Mirrors the style of website_db.js.
// ---------------------------------------------------------

export async function upsertSubscription(env, sub) {
  const {
    email,
    processor,
    customerId,
    subscriptionId,
    plan,
    status,
    currency,
    amount,
    promoCode,
    currentPeriodStart,
    currentPeriodEnd,
  } = sub;

  const existing = await env.gudispacedb
    .prepare("SELECT id FROM subscriptions WHERE subscription_id = ?")
    .bind(subscriptionId)
    .first();

  if (existing) {
    return env.gudispacedb
      .prepare(
        `UPDATE subscriptions
         SET email = ?, processor = ?, customer_id = ?, plan = ?, status = ?,
             currency = ?, amount = ?, promo_code = ?,
             current_period_start = ?, current_period_end = ?,
             modified_at = datetime('now')
         WHERE subscription_id = ?`
      )
      .bind(
        email,
        processor,
        customerId,
        plan,
        status,
        currency,
        amount,
        promoCode,
        currentPeriodStart,
        currentPeriodEnd,
        subscriptionId,
      )
      .run();
  }

  return env.gudispacedb
    .prepare(
      `INSERT INTO subscriptions
        (email, processor, customer_id, subscription_id, plan, status,
         currency, amount, promo_code, current_period_start, current_period_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      email,
      processor,
      customerId,
      subscriptionId,
      plan,
      status,
      currency,
      amount,
      promoCode,
      currentPeriodStart,
      currentPeriodEnd,
    )
    .run();
}

export async function updateSubscriptionStatusById(env, subscriptionId, status) {
  return env.gudispacedb
    .prepare(
      `UPDATE subscriptions SET status = ?, modified_at = datetime('now') WHERE subscription_id = ?`
    )
    .bind(status, subscriptionId)
    .run();
}

export async function getSubscriptionByEmail(env, email) {
  return env.gudispacedb
    .prepare(
      `SELECT * FROM subscriptions WHERE email = ? ORDER BY id DESC LIMIT 1`
    )
    .bind(email)
    .first();
}

export async function isEmailSubscriptionActive(env, email) {
  const sub = await env.gudispacedb
    .prepare(
      `SELECT 1 FROM subscriptions WHERE email = ? AND status = 'active' LIMIT 1`
    )
    .bind(email)
    .first();

  return !!sub;
}
