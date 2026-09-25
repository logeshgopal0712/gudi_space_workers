// ---------------------------------------------------------
// Short-lived tokens that let the frontend poll "/api/generateStatus"
// for a branch without re-using the (single-use, human-entered) OTP.
//
// Reuses the same OTP_STORE KV namespace as otp_util.js - just under a
// different key prefix so the two don't collide - so there's no new
// infra to wire up. A token is issued once (at create/modify time) and
// can be polled with repeatedly until it expires; unlike OTP it is NOT
// deleted after a single use.
// ---------------------------------------------------------

const TOKEN_PREFIX = "buildtoken:";
const TOKEN_TTL_SECONDS = 600; // 10 minutes - generous buffer over expected build time

export async function generatePollToken(env, branchName) {
  const token = crypto.randomUUID();
  await env.OTP_STORE.put(`${TOKEN_PREFIX}${token}`, branchName, { expirationTtl: TOKEN_TTL_SECONDS });
  return token;
}

export async function isPollTokenValidForBranch(env, token, branchName) {
  if (!token || !branchName) {
    return false;
  }
  const storedBranch = await env.OTP_STORE.get(`${TOKEN_PREFIX}${token}`);
  return storedBranch === branchName;
}
