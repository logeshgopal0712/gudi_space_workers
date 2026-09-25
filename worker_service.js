import { ERROR_CODES } from "./constants.js";
import { get_headers, createBranchAndUpdateFile, getDataJsonFromBranch, extractAndUploadImages, updateMetadatafile, deleteBranchFromGithub , constructBranchNameFromCompanyName } from "./website_github_util.js";
import { insertSiteRecord, getBranchNameByEmail, getPageLinkByEmail, updateSiteRecord, updateSiteRecordAsDeleted, isemailAlreadyHasSiteAndActive, branchExistsAndActive, deleteSiteRecord } from "./website_db.js";
import { verifyOtp } from "./otp_util.js";
import { deletePagesDeploymentForBranch, addCustomDomainForBranch, removeCustomDomainForBranch, getPagesDeploymentStatus } from "./website_cloudflare_util.js";
import { generatePollToken, getPollTokenTarget } from "./poll_token_util.js";

function isValidStringField(field)
{
  if (typeof field !== "string" || field.trim() === "") {
    return false;
  }
  return true;
}

export async function generatePost(request, env) {
  // 1. Get input
  let body;
  try {
    body = await request.json();
  } catch (err) {
    throw new Error("Invalid JSON");
  }

  const { otp, data } = body;

  if (!data) {
    throw new Error("data payload is required");
  }

  const email = data?.contact?.email;
  const companyName = data?.company?.companyName || null;

  if (!isValidStringField(email))
  {
    throw new Error(ERROR_CODES.INVALID_EMAIL);
  }

  await verifyOtp(env, email, otp);

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

  // Tracks which side effects have actually happened, so the catch block
  // below knows exactly what needs to be rolled back if a later step fails.
  let branchCreated = false;
  let domainCreated = false;

  try
  {
    console.log("Create: Trying to delete site record if already exists for :", safeBranchName);

    await deleteSiteRecord(env, email, safeBranchName);

    console.log("Create: Deleted site record if already exists for :", safeBranchName);

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

    await insertSiteRecord(env, safeBranchName, data, customUrl);

    console.log("Create: Inserted site record :", safeBranchName + " , previewUrl: " + customUrl);

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

    if (!isValidStringField(email))
    {
      throw new Error(ERROR_CODES.INVALID_EMAIL);
    }

    await verifyOtp(env, email, otp);

    const branchName = await getBranchNameByEmail(env, email);

    if (!isValidStringField(branchName))
    {
      throw new Error(ERROR_CODES.NO_COMPANY_EXISTS_FOR_EMAIL);
    }

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
