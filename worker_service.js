import { ERROR_CODES } from "./constants.js";
import { get_headers, createBranchAndUpdateFile, getDataJsonFromBranch, extractAndUploadImages, updateMetadatafile, deleteBranchFromGithub , constructBranchNameFromCompanyName } from "./website_github_util.js";
import { insertSiteRecord, getBranchNameByEmail, getPageLinkByEmail, updateSiteRecord, updateSiteRecordAsDeleted, isemailAlreadyHasSiteAndActive, branchExistsAndActive, deleteSiteRecord } from "./website_db.js";
import { verifyOtp } from "./otp_util.js";
import { deletePagesDeploymentForBranch, addCustomDomainForBranch, removeCustomDomainForBranch } from "./website_cloudflare_util.js";

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

  try
  {
    console.log("Create: Trying to delete site record if already exists for :", safeBranchName);

    await deleteSiteRecord(env, email, safeBranchName);

    console.log("Create: Deleted site record if already exists for :", safeBranchName);

    const result = await createBranchAndUpdateFile(env, safeBranchName, data);

    console.log("Create: Created branch and updated file :", safeBranchName);

    const customUrl = await addCustomDomainForBranch(env, safeBranchName);

    console.log("Create: Added custom domain :", customUrl);

    await insertSiteRecord(env, safeBranchName, data, customUrl);

    console.log("Create: Inserted site record :", safeBranchName + " , previewUrl: " + customUrl);

    return customUrl;
  }
  catch (err)
  {
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

    await updateMetadatafile(cleanedData, branchName, headers);

    await updateSiteRecord(env, email, data);

    const page_link = await getPageLinkByEmail(env, email);

    return page_link;
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
