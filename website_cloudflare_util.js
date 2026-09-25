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
export async function getPagesDeploymentStatus(env, branchName, commitSha = null) {
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

  // Creating/modifying a site is actually several commits to the same
  // branch (branch creation off main, one per uploaded image, then the
  // real data.json) - Cloudflare Pages builds each commit as its own
  // deployment. Matching by branch alone can resolve to an EARLIER one
  // (e.g. the branch-creation commit, which still has main's blank
  // template data.json) instead of the one that actually carries the
  // real data. Match the exact commit when we have it; branch-only match
  // is just a fallback for tokens issued before this existed.
  const deployment = commitSha
    ? listData.result.find(
        (d) => d.deployment_trigger?.metadata?.commit_hash === commitSha
      )
    : listData.result.find(
        (d) => d.deployment_trigger?.metadata?.branch === branchName
      );

  const status = deployment?.latest_stage?.status || "pending";

  if (status !== "success") {
    // Covers "pending"/"idle"/"active" (still building) as well as a
    // genuine "failure"/"canceled" - either way we're not ready yet.
    return { ready: false, status };
  }

  // Even once the right build reports "success", confirm the
  // customer-facing custom domain (branchName.ROOT_DOMAIN) is actually
  // serving it - domain activation and Cloudflare's edge cache can both
  // lag behind the build finishing. Check for a real, non-empty company
  // name specifically (not just that the "company" key exists, since
  // that key is always present even on a blank template) - a real site
  // always has one, since it's required to create the branch at all.
  try {
    const liveCheck = await fetch(
      `https://${branchName}.${CONSTANTS.ROOT_DOMAIN}/data/data.json`,
      { cf: { cacheTtl: 0, cacheEverything: false } }
    );

    if (!liveCheck.ok) {
      console.log(`getPagesDeploymentStatus: live domain check for ${branchName} returned ${liveCheck.status}`);
      return { ready: false, status: "pending" };
    }

    const liveData = await liveCheck.json();
    if (!liveData?.company?.companyName) {
      console.log(`getPagesDeploymentStatus: live domain check for ${branchName} still shows a blank/default company name`);
      return { ready: false, status: "pending" };
    }
  } catch (err) {
    console.log(`getPagesDeploymentStatus: live domain check for ${branchName} failed:`, err.message);
    return { ready: false, status: "pending" };
  }

  return { ready: true, status: "success" };
}
