// ---------------------------------------------------------
// Deletes the Cloudflare Pages deployment(s) tied to a specific branch.
// Requires env.CLOUDFLARE_API_TOKEN (Pages:Edit permission) and
// your Cloudflare account ID + Pages project name.
// ---------------------------------------------------------
//const CF_ACCOUNT_ID = "your-cloudflare-account-id"; // find this in dashboard sidebar
//const CF_PAGES_PROJECT_NAME = "your-pages-project-name"; // e.g. "cloudflaretest-aa3"

import { CONSTANTS } from "./constants.js";

async function getCfHeaders(env) {
  if (!env.CLOUDFLARE_API_TOKEN) 
  {
    console.log("getCfHeaders: CLOUDFLARE_API_TOKEN is not set as a Worker secret");
    throw new Error("CLOUDFLARE_API_TOKEN is not set as a Worker secret");
  }
  return {
    "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
    "Content-Type": "application/json"
  };
}

export async function deletePagesDeploymentForBranch(env, branchName) {
  const headers = await getCfHeaders(env);

  // 1. List deployments for this Pages project
  const listRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CONSTANTS.CF_ACCOUNT_ID}/pages/projects/${CONSTANTS.CF_PAGES_PROJECT_NAME}/deployments`,
    { headers }
  );
  if (!listRes.ok) {
    console.log("deletePagesDeploymentForBranch: Failed to list Pages deployments");
    throw new Error(`Failed to list Pages deployments: ${await listRes.text()}`);
  }
  const listData = await listRes.json();

  // 2. Find deployment(s) matching this branch
  const matchingDeployments = listData.result.filter(
    (d) => d.deployment_trigger?.metadata?.branch === branchName
  );

  if (matchingDeployments.length === 0) {
    console.log("deletePagesDeploymentForBranch: Nothing to delete:", branchName);
    return; // nothing to delete
  }

  // 3. Delete each matching deployment
  for (const deployment of matchingDeployments) {
    const delRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CONSTANTS.CF_ACCOUNT_ID}/pages/projects/${CONSTANTS.CF_PAGES_PROJECT_NAME}/deployments/${deployment.id}?force=true`,
      { method: "DELETE", headers }
    );
    if (!delRes.ok) {
      console.log("deletePagesDeploymentForBranch: Failed to delete for deployementId: " + deployment.id);
      throw new Error(`Failed to delete deployment ${deployment.id}: ${await delRes.text()}`);
    }
  }
}