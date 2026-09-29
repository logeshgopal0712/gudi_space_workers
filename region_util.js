// ---------------------------------------------------------
// Decides which payment processor a request should use, based on
// Cloudflare's edge-detected country - request.cf.country is populated
// automatically on every request by Cloudflare's network, no extra
// lookup/service needed.
//
// India routes to Razorpay (not implemented yet - see
// createCheckoutSession's call site in worker.js). Everywhere else uses
// Stripe. Add more country -> processor rules here as needed; nothing
// else has to change to support a new region once its processor util
// exists.
// ---------------------------------------------------------
export function resolveProcessorForRequest(request) {
  const country = request.cf?.country;
  return country === "IN" ? "razorpay" : "stripe";
}
