import { getPagesDeploymentStatus } from "./website_cloudflare_util.js";
import { CONSTANTS } from "./constants.js";

const POLL_INTERVAL_MS = 10000; // 10s between checks
const MAX_POLL_ATTEMPTS = 30;   // ~5 minutes total before giving up

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------
// Waits for the Pages deployment to actually go live, then sends the
// "your site is ready" email. Meant to be run inside ctx.waitUntil() so
// it keeps going in the background after the response has already gone
// back to the browser - the email still goes out even if the user
// closes the tab, reloads, or loses power right after clicking Create.
// ---------------------------------------------------------
export async function notifySiteReadyInBackground(env, { email, companyName, branchName, commitSha, siteUrl }) {
  try
  {
    let ready = false;

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++)
    {
      const result = await getPagesDeploymentStatus(env, branchName, commitSha);
      if (result.ready)
      {
        ready = true;
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }

    if (!ready)
    {
      console.log("notifySiteReadyInBackground: gave up waiting for deployment to go live:", branchName);
      return;
    }

    await sendSiteReadyEmail(env, { email, companyName, siteUrl });
    console.log("notifySiteReadyInBackground: sent site-ready email for:", branchName);
  }
  catch (err)
  {
    console.log("notifySiteReadyInBackground: failed for", branchName, "-", err.message);
  }
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
