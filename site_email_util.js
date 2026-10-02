import { getPagesDeploymentStatus } from "./website_cloudflare_util.js";
import { listPendingBuildTokensWithEmail, deletePollToken } from "./poll_token_util.js";
import { CONSTANTS } from "./constants.js";

// ---------------------------------------------------------
// Runs once a minute (see worker.js's `scheduled` export). Checks every
// pending "site is being built" KV entry that still has an email
// attached (i.e. every create that hasn't been notified yet), and sends
// the "your site is ready" email the moment each one is actually live.
//
// Deliberately NOT a long-running ctx.waitUntil() poll attached to the
// create request - Cloudflare only guarantees ~30 seconds of extra time
// for that, which real deployments regularly exceed. A cron job has its
// own 15-minute budget per run and isn't tied to any request's
// lifetime, so it isn't at risk of being cut off mid-check.
// ---------------------------------------------------------
export async function checkPendingSiteReadyNotifications(env) {
  const pending = await listPendingBuildTokensWithEmail(env);
  let sent = 0;

  for (const entry of pending) {
    try {
      const result = await getPagesDeploymentStatus(env, entry.branchName, entry.commitSha);

      if (result.ready) {
        const siteUrl = `https://${entry.branchName}.${CONSTANTS.ROOT_DOMAIN}`;
        await sendSiteReadyEmail(env, {
          email: entry.email,
          companyName: entry.companyName,
          siteUrl,
        });
        await deletePollToken(env, entry.keyName);
        sent++;
      }
      // Not ready yet - leave it. Either the next run (1 minute later)
      // catches it, or the KV entry's own TTL expires it eventually if
      // the build never finishes.
    }
    catch (err)
    {
      console.log("checkPendingSiteReadyNotifications: failed for", entry.branchName, "-", err.message);
    }
  }

  if (pending.length > 0) {
    console.log(`checkPendingSiteReadyNotifications: checked ${pending.length}, sent ${sent}`);
  }

  return { checked: pending.length, sent };
}

async function sendSiteReadyEmail(env, { email, companyName, siteUrl }) {
  const manageUrl = `https://${CONSTANTS.ROOT_DOMAIN}/manage_plan.html?email=${encodeURIComponent(email)}`;

  const emailRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.EMAIL_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: "verify@gudispace.com",
      to: email,
      subject: `${companyName || "Your website"} is live!`,
      html: `<div style="font-family: -apple-system, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background-color: #ffffff;">
      <h2 style="color: #1877F2; font-size: 20px; margin-bottom: 8px;">Gudispace</h2>
      <p style="color: #4b5563; font-size: 15px; line-height: 1.5; margin-bottom: 24px;">
        Your website is live! Here's your link:
      </p>
      <div style="text-align: center; margin-bottom: 24px;">
        <a href="${siteUrl}" style="display: inline-block; background-color: #1877F2; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600;">View your site</a>
      </div>
      <p style="color: #4b5563; font-size: 14px; line-height: 1.5; margin-bottom: 8px;">
        It's free to try. To keep it live, add a plan any time here:
      </p>
      <div style="text-align: center; margin-bottom: 24px;">
        <a href="${manageUrl}" style="color: #1877F2; font-size: 14px;">Manage your plan</a>
      </div>
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
      <p style="color: #9ca3af; font-size: 12px;">Gudispace · gudispace.com</p>
    </div>`
    })
  });

  if (!emailRes.ok)
  {
    const err = await emailRes.text();
    throw new Error(err);
  }

  return true;
}
