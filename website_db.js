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

  const result = await env.gudispacedb
    .prepare(
      `INSERT INTO sites (email, business_email, company_name, branch_name, phone_number, status, page_link)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(email, businessEmail, companyName, branchName, phoneNumber, "active", previewUrl)
    .run();

  return result;
}

// ---------------------------------------------------------
// Creates a site row for this email if none exists yet, or updates the
// existing one in place otherwise - never deletes/re-inserts. This is
// what makes created_at a reliable "this email's free trial started on
// this date" marker: delete-and-recreate just updates the same row, so
// the original date survives no matter how many times someone does it.
// ---------------------------------------------------------
export async function upsertSiteRecord(env, branchName, data, previewUrl) {
  const email = data?.contact?.email;
  const businessEmail = data.company?.business_email || null;
  const companyName = data?.company?.companyName || null;
  const phoneNumber = data?.contact?.phone || null;

  if (!email || !companyName) {
    throw new Error("Missing required fields (email or company name) for DB insert");
  }

  const existing = await env.gudispacedb
    .prepare("SELECT id FROM sites WHERE email = ?")
    .bind(email)
    .first();

  if (existing) {
    return env.gudispacedb
      .prepare(
        `UPDATE sites
         SET business_email = ?, company_name = ?, branch_name = ?, phone_number = ?,
             status = 'active', page_link = ?, modified_at = datetime('now')
         WHERE email = ?`
      )
      .bind(businessEmail, companyName, branchName, phoneNumber, previewUrl, email)
      .run();
  }

  return env.gudispacedb
    .prepare(
      `INSERT INTO sites (email, business_email, company_name, branch_name, phone_number, status, page_link)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(email, businessEmail, companyName, branchName, phoneNumber, "active", previewUrl)
    .run();
}

// ---------------------------------------------------------
// Returns when this email's site row was first created - the free
// trial's real start date, regardless of how many times it's since been
// deleted/recreated (upsertSiteRecord never touches created_at on an
// update). Returns null if this email has never created a site.
// ---------------------------------------------------------
export async function getSiteCreatedAtByEmail(env, email) {
  const site = await env.gudispacedb
    .prepare("SELECT created_at FROM sites WHERE email = ?")
    .bind(email)
    .first();

  return site?.created_at || null;
}

// ---------------------------------------------------------
// All currently-active sites, with just the fields the prune job needs
// (email + created_at to work out trial age, the rest for its emails).
// Used by the scheduled worker - see prune_util.js.
// ---------------------------------------------------------
export async function getAllActiveSites(env) {
  const result = await env.gudispacedb
    .prepare(
      `SELECT email, company_name, branch_name, page_link, created_at FROM sites WHERE status = 'active'`
    )
    .all();

  return result.results || [];
}

export async function isemailAlreadyHasSiteAndActive(env, email) {
  const site = await env.gudispacedb
    .prepare("SELECT 1 FROM sites WHERE email = ? and status = ? LIMIT 1")
    .bind(email, 'active')
    .first();

  return !!site;
}

export async function branchExistsAndActive(env, branch_name) {
  const site = await env.gudispacedb
    .prepare("SELECT 1 FROM sites WHERE branch_name = ? and status = ? LIMIT 1")
    .bind(branch_name, 'active')
    .first();

  return !!site;
}

export async function getBranchNameByEmail(env, email) {
  const site = await env.gudispacedb
    .prepare("SELECT branch_name FROM sites WHERE email = ? and status = ?")
    .bind(email, 'active')
    .first();
 
  if (!site) {
    return null;
  }
 
  return site.branch_name;
}

export async function getPageLinkByEmail(env, email) {
  const site = await env.gudispacedb
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

  const result = await env.gudispacedb
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
  const result = await env.gudispacedb
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
  const result = await env.gudispacedb
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