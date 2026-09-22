// ---------------------------------------------------------
// Inserts a new row into the sites table after a website
// has been successfully generated (branch + Pages deployment ready).
// ---------------------------------------------------------
export async function insertSiteRecord(env, branchName, data, previewUrl) {
  // Adjust these field paths to match wherever email/phone/company name
  // actually live inside your `data` payload.
  const email = data?.contact?.email;
  const businessEmail = data.company?.business_email || null;
  const companyName = data?.company?.companyName || null;
  const phoneNumber = data?.contact?.phone || null;

  if (!email || !companyName) {
    throw new Error("Missing required fields (email or company name) for DB insert");
  }

  const result = await env.testbdb
    .prepare(
      `INSERT INTO sites (email, business_email, company_name, branch_name, phone_number, status, page_link)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(email, businessEmail, companyName, branchName, phoneNumber, "active", previewUrl)
    .run();

  return result;
}

export async function isemailAlreadyHasSiteAndActive(env, email) {
  const site = await env.testbdb
    .prepare("SELECT 1 FROM sites WHERE email = ? and status = ? LIMIT 1")
    .bind(email, 'active')
    .first();

  return !!site;
}

export async function branchExistsAndActive(env, branch_name) {
  const site = await env.testbdb
    .prepare("SELECT 1 FROM sites WHERE branch_name = ? and status = ? LIMIT 1")
    .bind(branch_name, 'active')
    .first();

  return !!site;
}

export async function getBranchNameByEmail(env, email) {
  const site = await env.testbdb
    .prepare("SELECT branch_name FROM sites WHERE email = ?")
    .bind(email)
    .first();
 
  if (!site) {
    return null;
  }
 
  return site.branch_name;
}

export async function getPageLinkByEmail(env, email) {
  const site = await env.testbdb
    .prepare("SELECT page_link FROM sites WHERE email = ?")
    .bind(email)
    .first();
 
  if (!site) {
    return null;
  }
 
  return site.page_link;
}

export async function updateSiteRecord(env, email, data) {
  // Same field paths as insertSiteRecord, kept consistent
  const companyName = data?.company?.companyName || null;
  const phoneNumber = data?.contact?.phone || null;
  const businessEmail = data?.company?.business_email || null;

  const result = await env.testbdb
    .prepare(
      `UPDATE sites
       SET company_name = ?, phone_number = ?, business_email = ?, modified_at = datetime('now')
       WHERE email = ?`
    )
    .bind(companyName, phoneNumber, businessEmail, email)
    .run();

  if (result.meta.changes === 0) {
    throw new Error("No website found for this email to update");
  }

  return result;
}

export async function updateSiteRecordAsDeleted(env, email, data) {
  const result = await env.testbdb
    .prepare(
      `UPDATE sites SET status = ?, modified_at = datetime('now') WHERE email = ?`
    )
    .bind("deleted", email)
    .run();
 
  if (result.meta.changes === 0) {
    throw new Error("No website found for this email to delete");
  }
 
  return result;
}

export async function deleteSiteRecord(env, email, branchName) {
  const result = await env.testbdb
    .prepare(
      `DELETE FROM sites WHERE email = ? OR branch_name = ?`
    )
    .bind(email, branchName)
    .run();
 
  if (result.meta.changes === 0) 
  {
    //throw new Error("No website found for this email or branch name");
    console.log("No website found for this email: " + email + " or branch name: " + branchName);
  }
 
  return result;
}