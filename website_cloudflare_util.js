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

// ---------------------------------------------------------
// Adds a custom domain (branchName.gudispace.com) to the Pages project,
// then creates the DNS CNAME record pointing it at that branch's
// auto-generated Pages preview (branchName.<PAGES_PROJECT>).
// Requires env.CLOUDFLARE_API_TOKEN with Pages:Edit + DNS:Edit permissions,
// and CONSTANTS.ROOT_DOMAIN + CONSTANTS.CF_ZONE_ID set.
// ---------------------------------------------------------
export async function addCustomDomainForBranch(env, branchName) {
  const headers = await getCfHeaders(env);
  const customDomain = `${branchName}.${CONSTANTS.ROOT_DOMAIN}`;
  const pagesTarget = `${branchName}.${CONSTANTS.PAGES_PROJECT}`;

  // 1. Register the custom domain on the Pages project
  const domainRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CONSTANTS.CF_ACCOUNT_ID}/pages/projects/${CONSTANTS.CF_PAGES_PROJECT_NAME}/domains`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ name: customDomain })
    }
  );
  if (!domainRes.ok) {
    const err = await domainRes.text();
    console.log("addCustomDomainForBranch: Failed to add Pages custom domain:", err);
    throw new Error(`Failed to add custom domain: ${err}`);
  }

  // 2. Create the DNS CNAME record pointing at the branch's Pages preview
  const dnsRes = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${CONSTANTS.CF_ZONE_ID}/dns_records`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "CNAME",
        name: customDomain,
        content: pagesTarget,
        proxied: true
      })
    }
  );
  if (!dnsRes.ok) {
    const err = await dnsRes.text();
    console.log("addCustomDomainForBranch: Failed to create DNS record:", err);
    throw new Error(`Failed to create DNS record: ${err}`);
  }

  return `https://${customDomain}`;
}

// ---------------------------------------------------------
// Removes the custom domain and its DNS record for a branch that's
// being deleted. Safe to call even if either one is already gone.
// ---------------------------------------------------------
export async function removeCustomDomainForBranch(env, branchName) {
  const headers = await getCfHeaders(env);
  const customDomain = `${branchName}.${CONSTANTS.ROOT_DOMAIN}`;

  // 1. Find and delete the DNS record for this custom domain
  const listRes = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${CONSTANTS.CF_ZONE_ID}/dns_records?name=${customDomain}`,
    { headers }
  );
  if (listRes.ok) {
    const listData = await listRes.json();
    for (const record of listData.result) {
      const delRes = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${CONSTANTS.CF_ZONE_ID}/dns_records/${record.id}`,
        { method: "DELETE", headers }
      );
      if (!delRes.ok) {
        console.log("removeCustomDomainForBranch: Failed to delete DNS record:", await delRes.text());
      }
    }
  } else {
    console.log("removeCustomDomainForBranch: Failed to list DNS records:", await listRes.text());
  }

  // 2. Remove the custom domain from the Pages project
  const domainDelRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CONSTANTS.CF_ACCOUNT_ID}/pages/projects/${CONSTANTS.CF_PAGES_PROJECT_NAME}/domains/${customDomain}`,
    { method: "DELETE", headers }
  );
  if (!domainDelRes.ok && domainDelRes.status !== 404) {
    console.log("removeCustomDomainForBranch: Failed to remove Pages custom domain:", await domainDelRes.text());
  }
}

// ---------------------------------------------------------
// Single, non-looping check of a branch's Pages deployment status.
// Used by the "/api/generateStatus" poll endpoint - the frontend calls
// this repeatedly (every few seconds) and drives its own timer/stage
// UI, instead of the Worker blocking a single request for a long time.
//
// Returns { ready, status }:
//   ready  - true only once latest_stage.status is "success"
//   status - the raw stage status ("active"/"idle"/"success"/"failure"/
//            "canceled"), or "pending" if the deployment hasn't shown
//            up in the list yet (e.g. called right after branch creation).
// ---------------------------------------------------------
export async function getPagesDeploymentStatus(env, branchName) {
  const headers = await getCfHeaders(env);

  const listRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CONSTANTS.CF_ACCOUNT_ID}/pages/projects/${CONSTANTS.CF_PAGES_PROJECT_NAME}/deployments`,
    { headers }
  );

  if (!listRes.ok) {
    console.log("getPagesDeploymentStatus: failed to list deployments:", await listRes.text());
    throw new Error("Failed to check deployment status");
  }

  const listData = await listRes.json();
  const deployment = listData.result.find(
    (d) => d.deployment_trigger?.metadata?.branch === branchName
  );

  const status = deployment?.latest_stage?.status || "pending";
  const ready = status === "success";

  return { ready, status };
}
