import { ERROR_CODES, CONSTANTS } from "./constants.js";
import { get_headers, createBranchAndUpdateFile, getDataJsonFromBranch, extractAndUploadImages, updateMetadatafile, deleteBranchFromGithub , constructBranchNameFromCompanyName } from "./website_github_util.js";
import { upsertSiteRecord, getSiteCreatedAtByEmail, getBranchNameByEmail, getPageLinkByEmail, updateSiteRecord, updateSiteRecordAsDeleted, isemailAlreadyHasSiteAndActive, branchExistsAndActive } from "./website_db.js";
import { verifyOtp } from "./otp_util.js";
import { isEmailSubscriptionActive } from "./subscription_db.js";
import { notifySiteReadyInBackground } from "./site_email_util.js";
import { deletePagesDeploymentForBranch, addCustomDomainForBranch, removeCustomDomainForBranch, getPagesDeploymentStatus } from "./website_cloudflare_util.js";
import { generatePollToken, getPollTokenTarget } from "./poll_token_util.js";

function isValidStringField(field)
{
  if (typeof field !== "string" || field.trim() === "") {
    return false;
  }
  return true;
}

// ---------------------------------------------------------
// Pure sanity checks for a "create website" request - no OTP involved, no
// side effects. Pulled out of generatePost so it can also be called (via
// generateSanityCheckPost, below) *before* an OTP is ever sent. That way a
// misspelled/duplicate company name or an email that already has a site
// gets rejected up front instead of burning an OTP send-and-verify round
// trip on a request that was always going to fail.
//
// Still called again at the top of generatePost itself (before verifyOtp)
// so a state change between the precheck and the real submit (someone
// else grabs the same company name in between, say) is still caught -
// this is defense-in-depth, not a replacement for the real check.
// ---------------------------------------------------------
export async function validateCreateSanity(env, data) {
  if (!data) {
    throw new Error("data payload is required");
  }

  const email = data?.contact?.email;
  const companyName = data?.company?.companyName || null;

  if (!isValidStringField(email))
  {
    throw new Error(ERROR_CODES.INVALID_EMAIL);
  }

  if (!isValidStringField(companyName))
  {
    throw new Error(ERROR_CODES.INVALID_COMPANY_NAME);
  }

  if (await isemailAlreadyHasSiteAndActive(env, email))
  {
    throw new Error(ERROR_CODES.EMAIL_ALREADY_USED);
  }

  const safeBranchName = constructBranchNameFromCompanyName(companyName);

  if (await branchExistsAndActive(env, safeBranchName))
  {
    throw new Error(ERROR_CODES.COMPANY_ALREADY_USED);
  }

  // Free trial check - trial clock starts at this email's very first
  // site creation (getSiteCreatedAtByEmail) and never resets, since
  // upsertSiteRecord updates the same row in place instead of deleting
  // and re-inserting. Closes the "delete it, recreate it, get a fresh
  // trial" loophole. Paying subscribers skip this entirely.
  const createdAt = await getSiteCreatedAtByEmail(env, email);
  if (createdAt && !(await isEmailSubscriptionActive(env, email)))
  {
    const createdAtDate = new Date(createdAt.replace(" ", "T") + "Z");
    const ageDays = (Date.now() - createdAtDate.getTime()) / (1000 * 60 * 60 * 24);

    if (ageDays > CONSTANTS.FREE_TRIAL_DAYS)
    {
      throw new Error(ERROR_CODES.PAYMENT_REQUIRED);
    }
  }

  return { email, safeBranchName };
}

// ---------------------------------------------------------
// Same idea for "delete website" - confirms a company actually exists for
// the given email before the caller bothers sending an OTP for it.
// ---------------------------------------------------------
export async function validateDeleteSanity(env, email) {
  if (!isValidStringField(email))
  {
    throw new Error(ERROR_CODES.INVALID_EMAIL);
  }

  const branchName = await getBranchNameByEmail(env, email);

  if (!isValidStringField(branchName))
  {
    throw new Error(ERROR_CODES.NO_COMPANY_EXISTS_FOR_EMAIL);
  }

  return { branchName };
}

// ---------------------------------------------------------
// Handler for POST /api/generateSanityCheck - runs the checks above with
// no OTP and no side effects, so the frontend can call it right when
// "Create website" / "Delete website" is clicked, *before* triggering an
// OTP send. Body shape: { action: "create", data } or { action: "delete",
// email }.
// ---------------------------------------------------------
export async function generateSanityCheckPost(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    throw new Error("Invalid JSON");
  }

  const { action, data, email } = body;

  if (action === "delete")
  {
    const { branchName } = await validateDeleteSanity(env, email);
    return { branchName };
  }

  // Default to "create" so existing callers that don't pass `action`
  // still work.
  const { safeBranchName } = await validateCreateSanity(env, data);
  return { branchName: safeBranchName };
}

export async function generatePost(request, env, ctx) {
  // 1. Get input
  let body;
  try {
    body = await request.json();
  } catch (err) {
    throw new Error("Invalid JSON");
  }

  const { otp, data } = body;

  const { email, safeBranchName } = await validateCreateSanity(env, data);

  await verifyOtp(env, email, otp);

  // Tracks which side effects have actually happened, so the catch block
  // below knows exactly what needs to be rolled back if a later step fails.
  let branchCreated = false;
  let domainCreated = false;

  try
  {
    const result = await createBranchAndUpdateFile(env, safeBranchName, data);
    branchCreated = true;

    console.log("Create: Created branch and updated file :", safeBranchName, ", commit:", result.commitSha);

    const customUrl = await addCustomDomainForBranch(env, safeBranchName);
    domainCreated = true;

    console.log("Create: Added custom domain :", customUrl);

    // Issue a short-lived poll token so the frontend can check build
    // status itself via "/api/generateStatus" instead of the API blocking
    // here - this is what closes the 522 timing gap without making the
    // customer stare at a frozen "Create" button. Carries the exact
    // data.json commit SHA so the status check can't lock onto an earlier
    // deployment of this same (brand new) branch - see getPagesDeploymentStatus.
    let pollToken = null;
    try
    {
      pollToken = await generatePollToken(env, safeBranchName, result.commitSha);
    }
    catch (tokenErr)
    {
      console.log("Create: Failed to generate poll token for:", safeBranchName, "-", tokenErr.message);
    }

    await upsertSiteRecord(env, safeBranchName, data, customUrl);

    console.log("Create: Upserted site record :", safeBranchName + " , previewUrl: " + customUrl);

    // Fire-and-forget: keeps polling the Pages deployment in the
    // background (via ctx.waitUntil, which keeps the worker alive after
    // the response is already sent) and only emails the "your site is
    // ready" link once it's actually live - not the moment this request
    // returns. Runs independently of the browser/tab staying open.
    if (ctx && typeof ctx.waitUntil === "function")
    {
      ctx.waitUntil(
        notifySiteReadyInBackground(env, {
          email,
          companyName: data?.company?.companyName,
          branchName: safeBranchName,
          commitSha: result.commitSha,
          siteUrl: customUrl,
        })
      );
    }

    return { previewUrl: customUrl, branch: safeBranchName, token: pollToken };
  }
  catch (err)
  {
    console.log("Create: Failed for", safeBranchName, "- rolling back. Reason:", err.message);

    // Undo whatever side effects already happened, in reverse order, so we
    // never leave an orphaned custom domain/DNS record or GitHub branch
    // behind with no matching DB row (which would also permanently block
    // retrying the same company name, since the branch would still exist).
    if (domainCreated)
    {
      try
      {
        await removeCustomDomainForBranch(env, safeBranchName);
        console.log("Create: Rollback - removed custom domain for:", safeBranchName);
      }
      catch (rollbackErr)
      {
        console.log("Create: Rollback failed to remove custom domain for:", safeBranchName, "-", rollbackErr.message);
      }
    }

    if (branchCreated)
    {
      try
      {
        const headers = await get_headers(env);
        await deleteBranchFromGithub(headers, safeBranchName);
        console.log("Create: Rollback - deleted github branch for:", safeBranchName);
      }
      catch (rollbackErr)
      {
        console.log("Create: Rollback failed to delete github branch for:", safeBranchName, "-", rollbackErr.message);
      }
    }

    throw new Error(err.message);
  }
}

export async function generateGet(request, env)
{
  try
  {
    const url = new URL(request.url);
    const email = url.searchParams.get("email");

    if (!isValidStringField(email))
    {
      throw new Error(ERROR_CODES.INVALID_EMAIL);
    }

    const branchName = await getBranchNameByEmail(env, email);

    if (!isValidStringField(branchName))
    {
      throw new Error(ERROR_CODES.NO_COMPANY_EXISTS_FOR_EMAIL);
    }

    const data = await getDataJsonFromBranch(env, branchName);

    return data;
  }
  catch (err)
  {
    console.log("Get error: " + err.message);
    throw new Error(err.message);
  }
}

export async function generatePut(request, env) {
  // 1. Get input
  let body;
  try {
    body = await request.json();
  } catch (err)
  {
    throw new Error("Invalid JSON");
  }

  const { otp, data } = body;

  const email = data?.contact?.email;

  if (!isValidStringField(email))
  {
    throw new Error(ERROR_CODES.INVALID_EMAIL);
  }

  await verifyOtp(env, email, otp);

  try
  {
    const branchName = await getBranchNameByEmail(env, email);
    if (!isValidStringField(branchName))
    {
      throw new Error(ERROR_CODES.NO_COMPANY_EXISTS_FOR_EMAIL);
    }

    const cleanedData = await extractAndUploadImages(env, branchName, data);
    const headers = await get_headers(env);

    const commitSha = await updateMetadatafile(cleanedData, branchName, headers);

    await updateSiteRecord(env, email, data);

    const page_link = await getPageLinkByEmail(env, email);

    // Editing a site re-triggers a Pages build for that branch too, so
    // hand back a poll token here as well - same "/api/generateStatus"
    // flow the frontend already uses after create. Same commit-SHA
    // reasoning as create: image uploads are separate commits too, so
    // pin to the exact commit that carries this edit's real data.json.
    let pollToken = null;
    try
    {
      pollToken = await generatePollToken(env, branchName, commitSha);
    }
    catch (tokenErr)
    {
      console.log("Modify: Failed to generate poll token for:", branchName, "-", tokenErr.message);
    }

    return { previewUrl: page_link, branch: branchName, token: pollToken };
  }
  catch (err) {
    throw new Error(err.message);
  }
}

export async function generateDelete(request, env) {
  try{
    const url = new URL(request.url);
    const email = url.searchParams.get("email");
    const otp = url.searchParams.get("otp");

    const { branchName } = await validateDeleteSanity(env, email);

    await verifyOtp(env, email, otp);

    // 2. Delete the branch on GitHub (also takes down the Pages preview)
    const headers = await get_headers(env);
    await deleteBranchFromGithub(headers, branchName);

    console.log("Delete: Deleted github branch:", branchName);

    await deletePagesDeploymentForBranch(env, branchName);

    console.log("Delete: Deleted deployment from cloud flare for branch:", branchName);

    await removeCustomDomainForBranch(env, branchName);

    console.log("Delete: Removed custom domain from cloud flare for branch:", branchName);

    // 3. Mark the DB row as deleted (soft delete, keeps history)
    await updateSiteRecordAsDeleted(env, email);
  }
  catch (err)
  {
    throw new Error(err.message);
  }
}

export async function generateStatusGet(request, env) {
  try
  {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");

    if (!isValidStringField(token))
    {
      throw new Error("token is required");
    }

    const target = await getPollTokenTarget(env, token);

    if (!target || !isValidStringField(target.branchName))
    {
      throw new Error("Invalid or expired token");
    }

    const { ready, status } = await getPagesDeploymentStatus(env, target.branchName, target.commitSha);

    return { ready, status };
  }
  catch (err)
  {
    throw new Error(err.message);
  }
}
