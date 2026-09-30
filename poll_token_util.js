// ---------------------------------------------------------
// Short-lived tokens that let the frontend poll "/api/generateStatus"
// for a branch without re-using the (single-use, human-entered) OTP.
//
// Reuses the same OTP_STORE KV namespace as otp_util.js - just under a
// different key prefix so the two don't collide - so there's no new
// infra to wire up. A token is issued once (at create/modify time) and
// can be polled with repeatedly until it expires; unlike OTP it is NOT
// deleted after a single use.
//
// Stores {branchName, commitSha} rather than just the branch name.
// Creating/modifying a site is actually several commits to the same
// branch (branch creation off main, one per uploaded image, then the
// real data.json) - each triggers its own Cloudflare Pages build, so
// "find a deployment for this branch" can resolve to an earlier one
// that still has main's blank template data.json. Carrying the exact
// commit SHA lets the status check match the ONE deployment that's
// actually built from the real data.
// ---------------------------------------------------------

const TOKEN_PREFIX = "buildtoken:";
const TOKEN_TTL_SECONDS = 600; // 10 minutes - generous buffer over expected build time

export async function generatePollToken(env, branchName, commitSha = null, email = null, companyName = null) {
  const token = crypto.randomUUID();
  await env.OTP_STORE.put(
    `${TOKEN_PREFIX}${token}`,
    JSON.stringify({ branchName, commitSha, email, companyName }),
    { expirationTtl: TOKEN_TTL_SECONDS },
  );
  return token;
}

// ---------------------------------------------------------
// Every entry that still carries an email - i.e. every create (not
// modify) whose "site is ready" email hasn't been sent yet. Used by the
// once-a-minute cron job (see site_email_util.js's
// checkPendingSiteReadyNotifications) instead of a new DB table: this
// KV entry already exists for polling, already expires on its own after
// TOKEN_TTL_SECONDS if nothing ever picks it up, so there's nothing new
// to keep clean.
// ---------------------------------------------------------
export async function listPendingBuildTokensWithEmail(env) {
  const results = [];
  let cursor;

  do {
    const page = await env.OTP_STORE.list({ prefix: TOKEN_PREFIX, cursor });

    for (const key of page.keys) {
      const raw = await env.OTP_STORE.get(key.name);
      if (!raw) continue;

      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.email) {
          results.push({ keyName: key.name, ...parsed });
        }
      } catch (err) {
        // Old-format token (bare branch name string, pre-dates email
        // being stored here) - nothing to notify, skip it.
      }
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return results;
}

export async function deletePollToken(env, keyName) {
  await env.OTP_STORE.delete(keyName);
}

// Returns { branchName, commitSha } for a token, or null if it's missing
// or expired. Tolerates tokens issued before this change (which stored
// the bare branch name string) by treating unparseable content as
// { branchName: <that string>, commitSha: null }.
export async function getPollTokenTarget(env, token) {
  if (!token) {
    return null;
  }
  const raw = await env.OTP_STORE.get(`${TOKEN_PREFIX}${token}`);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.branchName) {
      return parsed;
    }
  } catch (err) {
    // Not JSON - must be an old, pre-upgrade token that stored the bare
    // branch name string directly.
  }
  return { branchName: raw, commitSha: null };
}
