import { CONSTANTS } from "./constants.js";
import { getAllActiveSites, updateSiteRecordAsDeleted } from "./website_db.js";
import { isEmailSubscriptionActive } from "./subscription_db.js";
import { get_headers, deleteBranchFromGithub } from "./website_github_util.js";
import { deletePagesDeploymentForBranch, removeCustomDomainForBranch } from "./website_cloudflare_util.js";

// ---------------------------------------------------------
// How many free-trial days an unpaid site gets, and how many days before
// that deadline the reminder email goes out - both come from
// constants.js, so changing FREE_TRIAL_DAYS there (7 -> 2, or 7 -> 30)
// automatically changes both what the create-time gate allows
// (worker_service.js) and what this prune job does. Nothing else to
// touch.
// ---------------------------------------------------------
function ageInDays(createdAt) {
  const createdAtDate = new Date(createdAt.replace(" ", "T") + "Z");
  return (Date.now() - createdAtDate.getTime()) / (1000 * 60 * 60 * 24);
}

async function sendTrialEndingReminderEmail(env, { email, companyName, siteUrl, daysLeft }) {
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
      subject: `${daysLeft} day${daysLeft === 1 ? "" : "s"} left to keep ${companyName || "your website"} live`,
      html: `<div style="font-family: -apple-system, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background-color: #ffffff;">
      <h2 style="color: #1877F2; font-size: 20px; margin-bottom: 8px;">Gudispace</h2>
      <p style="color: #4b5563; font-size: 15px; line-height: 1.5; margin-bottom: 24px;">
        Your free trial for <b>${companyName || "your website"}</b> ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.
        After that, your site will be removed unless you add a plan.
      </p>
      <div style="text-align: center; margin-bottom: 24px;">
        <a href="${siteUrl}" style="color: #1877F2; font-size: 14px; display: block; margin-bottom: 12px;">View your site</a>
        <a href="${manageUrl}" style="display: inline-block; background-color: #1877F2; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600;">Add a plan</a>
      </div>
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
      <p style="color: #9ca3af; font-size: 12px;">Gudispace · gudispace.com</p>
    </div>`
    })
  });

  if (!emailRes.ok) {
    const err = await emailRes.text();
    throw new Error(err);
  }
}

async function sendSiteRemovedEmail(env, { email, companyName }) {
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
      subject: `${companyName || "Your website"} has been removed`,
      html: `<div style="font-family: -apple-system, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background-color: #ffffff;">
      <h2 style="color: #1877F2; font-size: 20px; margin-bottom: 8px;">Gudispace</h2>
      <p style="color: #4b5563; font-size: 15px; line-height: 1.5; margin-bottom: 24px;">
        Your free trial ended and <b>${companyName || "your website"}</b> has been taken down.
        Add a plan any time to rebuild it.
      </p>
      <div style="text-align: center; margin-bottom: 24px;">
        <a href="${manageUrl}" style="display: inline-block; background-color: #1877F2; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600;">Add a plan</a>
      </div>
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
      <p style="color: #9ca3af; font-size: 12px;">Gudispace · gudispace.com</p>
    </div>`
    })
  });

  if (!emailRes.ok) {
    const err = await emailRes.text();
    throw new Error(err);
  }
}

// ---------------------------------------------------------
// Fully removes an unpaid, expired site - same steps as the manual
// "delete website" flow (GitHub branch, Pages deployment, custom
// domain), then marks the DB row deleted and emails the owner.
// Wrapped so one site's failure doesn't stop the rest of the batch.
// ---------------------------------------------------------
async function pruneSite(env, site) {
  try
  {
    const headers = await get_headers(env);
    await deleteBranchFromGithub(headers, site.branch_name);
  }
  catch (err)
  {
    console.log("pruneSite: failed to delete github branch for", site.branch_name, "-", err.message);
  }

  try
  {
    await deletePagesDeploymentForBranch(env, site.branch_name);
  }
  catch (err)
  {
    console.log("pruneSite: failed to delete pages deployment for", site.branch_name, "-", err.message);
  }

  try
  {
    await removeCustomDomainForBranch(env, site.branch_name);
  }
  catch (err)
  {
    console.log("pruneSite: failed to remove custom domain for", site.branch_name, "-", err.message);
  }

  await updateSiteRecordAsDeleted(env, site.email);

  try
  {
    await sendSiteRemovedEmail(env, { email: site.email, companyName: site.company_name });
  }
  catch (err)
  {
    console.log("pruneSite: failed to send removal email for", site.email, "-", err.message);
  }
}

// ---------------------------------------------------------
// Runs once per scheduled trigger (see worker.js's `scheduled` export).
// Walks every active site, skips paying subscribers entirely, and for
// everyone else: sends the reminder at the configured day, or prunes the
// site once it's past CONSTANTS.FREE_TRIAL_DAYS.
// ---------------------------------------------------------
export async function runPruneJob(env) {
  const sites = await getAllActiveSites(env);
  const reminderDay = CONSTANTS.FREE_TRIAL_DAYS - CONSTANTS.TRIAL_REMINDER_DAYS_BEFORE_DEADLINE;

  let pruned = 0;
  let reminded = 0;

  for (const site of sites)
  {
    try
    {
      if (await isEmailSubscriptionActive(env, site.email))
      {
        continue; // paying subscriber - never touched by this job
      }

      const days = ageInDays(site.created_at);

      if (days >= CONSTANTS.FREE_TRIAL_DAYS)
      {
        await pruneSite(env, site);
        pruned++;
      }
      else if (Math.floor(days) === reminderDay)
      {
        await sendTrialEndingReminderEmail(env, {
          email: site.email,
          companyName: site.company_name,
          siteUrl: site.page_link,
          daysLeft: CONSTANTS.FREE_TRIAL_DAYS - Math.floor(days),
        });
        reminded++;
      }
    }
    catch (err)
    {
      console.log("runPruneJob: failed for", site.branch_name, "-", err.message);
    }
  }

  console.log(`runPruneJob: checked ${sites.length}, reminded ${reminded}, pruned ${pruned}`);
  return { checked: sites.length, reminded, pruned };
}
