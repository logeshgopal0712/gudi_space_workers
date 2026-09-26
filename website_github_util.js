//const GITHUB_OWNER = "logeshgopal0712";
//const GITHUB_REPO = "cloudflareTest";
//const FILE_PATH = "data/data.json";           // path to the file inside the repo
//const PAGES_PROJECT = "cloudflaretest-aa3.pages.dev"; // e.g. "my-site" -> my-site.pages.dev
import { ERROR_CODES , CONSTANTS } from "./constants.js";

export async function get_headers(env)
{
  return {
    "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "my-worker"
  };
}

export function constructBranchNameFromCompanyName(companyName)
{
  // sanitize branch name for safe URL/subdomain use - strip everything except letters and numbers
  const safeBranchName = companyName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return safeBranchName;
}

// Decodes a base64 data URL ("data:image/jpeg;base64,....") and commits it
// to the given path on the given branch via GitHub's contents API.
async function uploadImageToGithub(headers, branchName, path, dataUrl, { checkExisting = true } = {}) {
  // dataUrl looks like: data:image/jpeg;base64,AAAA....
  const base64Content = dataUrl.split(",")[1];
  if (!base64Content) {
    throw new Error(`Invalid image data for path ${path}`);
  }

  // Check if file already exists on this branch. Skipped entirely on a
  // brand-new create branch (checkExisting: false) - nothing can already
  // be there, so this GET is pure wasted latency in that case.
  let existingSha = null;
  if (checkExisting) {
    const existingRes = await fetch(
      `https://api.github.com/repos/${CONSTANTS.GITHUB_OWNER}/${CONSTANTS.GITHUB_REPO}/contents/${path}?ref=${branchName}`,
      { headers }
    );
    if (existingRes.ok) {
      const existingInfo = await existingRes.json();
      existingSha = existingInfo.sha;
    }
  }

  const putBody = {
    message: `Add image ${path} for branch ${branchName}`,
    content: base64Content, // GitHub wants raw base64, no "data:image/..." prefix
    branch: branchName
  };
  if (existingSha) {
    putBody.sha = existingSha; // required if overwriting an existing file
  }

  const uploadRes = await fetch(
    `https://api.github.com/repos/${CONSTANTS.GITHUB_OWNER}/${CONSTANTS.GITHUB_REPO}/contents/${path}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify(putBody)
    }
  );

  if (!uploadRes.ok) {
    throw new Error(`Failed to upload image ${path}: ${await uploadRes.text()}`);
  }
}

// Runs job(item) over items with at most `limit` running at once. Stops
// launching new work after the first failure (in-flight jobs are allowed
// to settle) and rethrows it - same fail-fast behavior as a sequential
// for-loop, just parallelized for the happy path.
async function runWithConcurrency(items, limit, job) {
  let nextIndex = 0;
  let firstError = null;

  async function worker() {
    while (nextIndex < items.length) {
      if (firstError) return;
      const current = nextIndex++;
      try {
        await job(items[current], current);
      } catch (err) {
        if (!firstError) firstError = err;
        return;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));

  if (firstError) throw firstError;
}

// ---------------------------------------------------------
// Extracts every {*_path, *_src} image pair from the payload,
// uploads each image to GitHub at its given path,
// and strips the *_src key out of the returned data object.
// ---------------------------------------------------------
export async function extractAndUploadImages(env, branchName, data, { isNewBranch = false } = {}) {
  const headers = await get_headers(env);

  // Collect every image {path, src} pair to upload, from all the known locations
  const imageJobs = [];

  if (data.company?.image_src && data.company?.image_path) {
    imageJobs.push({
      path: data.company.image_path,
      src: data.company.image_src,
      clear: () => { delete data.company.image_src; }
    });
  }

  if (data.template?.background_image_src && data.template?.background_image_path) {
    imageJobs.push({
      path: data.template.background_image_path,
      src: data.template.background_image_src,
      clear: () => { delete data.template.background_image_src; }
    });
  }

  if (Array.isArray(data.services)) {
    data.services.forEach((service) => {
      if (service.image_src && service.image_path) {
        imageJobs.push({
          path: service.image_path,
          src: service.image_src,
          clear: () => { delete service.image_src; }
        });
      }
    });
  }

  if (Array.isArray(data.gallery)) {
    data.gallery.forEach((item) => {
      if (item.image_src && item.image_path) {
        imageJobs.push({
          path: item.image_path,
          src: item.image_src,
          clear: () => { delete item.image_src; }
        });
      }
    });
  }

  // Upload each image to GitHub (one commit per image, on the branch).
  // On a brand-new create branch, nothing can collide with anything else
  // (each image is its own file path), so run several uploads at once and
  // skip the existing-file check. On modify, keep the old sequential +
  // existence-check behavior since files may already exist there.
  await runWithConcurrency(imageJobs, isNewBranch ? 5 : 1, async (job) => {
    await uploadImageToGithub(headers, branchName, job.path, job.src, {
      checkExisting: !isNewBranch,
    });
    job.clear(); // remove *_src from the data object now that it's stored
  });

  return data; // same object, mutated: *_src keys removed, *_path values remain
}

export async function updateMetadatafile(cleanedData /*json with no src data for image*/, branchName, headers)
{
  // a
  // Get current file SHA on the new branch, if it already exists.
  // A 404 here just means data.json doesn't exist yet on this branch - that's fine,
  // it means we're creating it fresh (no sha needed for a brand new file).

  let fileSha = null;
  const fileRes = await fetch(
    `https://api.github.com/repos/${CONSTANTS.GITHUB_OWNER}/${CONSTANTS.GITHUB_REPO}/contents/${CONSTANTS.FILE_PATH}?ref=${branchName}`,
    { headers }
  );
  if (fileRes.ok) {
    const fileInfo = await fileRes.json();
    fileSha = fileInfo.sha;
  } else if (fileRes.status !== 404) {
    // Any error other than "not found" is a real problem
    throw new Error(`Failed to get file info: ${await fileRes.text()}`);
  }

  // b 
  // Create/update file content (must be base64 encoded) - now uses cleanedData, no *_src fields
  const newContent = btoa(JSON.stringify(cleanedData, null, 2));

  const putBody = {
    message: `Update ${CONSTANTS.FILE_PATH} for branch ${branchName}`,
    content: newContent,
    branch: branchName
  };
  if (fileSha) {
    putBody.sha = fileSha; // only required when overwriting an existing file
  }

  const updateRes = await fetch(
    `https://api.github.com/repos/${CONSTANTS.GITHUB_OWNER}/${CONSTANTS.GITHUB_REPO}/contents/${CONSTANTS.FILE_PATH}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify(putBody)
    }
  );
  if (!updateRes.ok) {
    throw new Error(`Failed to update file: ${await updateRes.text()}`);
  }

  // Hand back the commit SHA for this exact data.json write, so callers
  // can poll for the Pages deployment built from THIS commit specifically -
  // branch creation and each image upload are separate commits too, each
  // triggering their own build, so "some deployment for this branch" can
  // resolve to an earlier one that still has main's blank data.json.
  const updateInfo = await updateRes.json();
  return updateInfo?.commit?.sha || null;
}

export async function createBranchAndUpdateFile(env, branchName, data) {
  const headers = await get_headers(env);

  // 2a. Get latest commit SHA of main
  const mainRefRes = await fetch(
    `https://api.github.com/repos/${CONSTANTS.GITHUB_OWNER}/${CONSTANTS.GITHUB_REPO}/git/ref/heads/main`,
    { headers }
  );
  if (!mainRefRes.ok) {
    throw new Error(`Failed to get main branch ref: ${await mainRefRes.text()}`);
  }
  const mainRef = await mainRefRes.json();
  const mainSha = mainRef.object.sha;

  // 2b. Create new branch pointing to that same commit
  const createBranchRes = await fetch(
    `https://api.github.com/repos/${CONSTANTS.GITHUB_OWNER}/${CONSTANTS.GITHUB_REPO}/git/refs`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        ref: `refs/heads/${branchName}`,
        sha: mainSha
      })
    }
  );
  if (!createBranchRes.ok) {
    const err = await createBranchRes.text();

    if (createBranchRes.status === 422) {
      // 422 here specifically means the branch ref already exists
      throw new Error(ERROR_CODES.COMPANY_ALREADY_USED);
    }
    // If branch already exists, GitHub returns 422 - decide how you want to handle this
    throw new Error(`Failed to create branch: ${err}`);
  }

  // 2c. Extract all images from the payload, upload each one to the new branch,
  //     and strip the *_src fields out of `data` before it gets committed as JSON.
  const cleanedData = await extractAndUploadImages(env, branchName, data, { isNewBranch: true });

  // 3a. update metadata file. if already exists, fetch first and update.
  const commitSha = await updateMetadatafile(cleanedData, branchName, headers);

  // 4. Build the preview URL Cloudflare Pages will auto-generate for this branch
  const previewUrl = `https://${branchName}.${CONSTANTS.PAGES_PROJECT}`;

  return { previewUrl, commitSha };
}
/*
export async function getDataJsonFromBranch(env, branchName) {
  const headers = await get_headers(env);
 
  const fileRes = await fetch(
    `https://api.github.com/repos/${CONSTANTS.GITHUB_OWNER}/${CONSTANTS.GITHUB_REPO}/contents/${CONSTANTS.FILE_PATH}?ref=${branchName}`,
    { headers }
  );
 
  if (!fileRes.ok) {
    let err = 'Failed to fetch data.json for branch ${branchName}: ${await fileRes.text()}';
    console.log("getDataJsonFromBranch: " + err);
    throw new Error(err);
  }
 
  const fileInfo = await fileRes.json();
  console.log("getDataJsonFromBranch: Branch: " + branchName + " , FileInfo: " + fileInfo.content);
  const decodedContent = atob(fileInfo.content.replace(/\n/g, ""));
  console.log("getDataJsonFromBranch: DecodedContent: " + decodedContent);

  if (fileInfo.content == "")
  {
    console.log("getDataJsonFromBranch: fileInfo.content is empty");
  }

  if (decodedContent == "")
  {
    console.log("getDataJsonFromBranch: decodedContent is empty");
  }
  
  return JSON.parse(decodedContent);
}
*/
export async function getDataJsonFromBranch(env, branchName) {
  const headers = await get_headers(env);

  // 1. Get file metadata (this works even for large files - just the content field is empty)
  const fileRes = await fetch(
    `https://api.github.com/repos/${CONSTANTS.GITHUB_OWNER}/${CONSTANTS.GITHUB_REPO}/contents/${CONSTANTS.FILE_PATH}?ref=${branchName}`,
    { headers }
  );

  if (!fileRes.ok) {
    const err = `Failed to fetch data.json for branch ${branchName}: ${await fileRes.text()}`;
    console.log("getDataJsonFromBranch: " + err);
    throw new Error(err);
  }

  const fileInfo = await fileRes.json();

  if (!fileInfo.sha) {
    throw new Error(`No sha returned for data.json on branch ${branchName}`);
  }

  // 2. Fetch the actual content via the Git Blobs API - this works for large files (up to 100MB),
  // unlike the Contents API above which leaves `content` empty for files over ~1MB.
  const blobRes = await fetch(
    `https://api.github.com/repos/${CONSTANTS.GITHUB_OWNER}/${CONSTANTS.GITHUB_REPO}/git/blobs/${fileInfo.sha}`,
    { headers }
  );

  if (!blobRes.ok) {
    const err = `Failed to fetch blob for data.json on branch ${branchName}: ${await blobRes.text()}`;
    console.log("getDataJsonFromBranch: " + err);
    throw new Error(err);
  }

  const blobInfo = await blobRes.json();
  const decodedContent = atob(blobInfo.content.replace(/\n/g, ""));

  if (decodedContent.trim() === "") {
    throw new Error(`data.json content is empty for branch ${branchName}`);
  }

  return JSON.parse(decodedContent);
}

export async function deleteBranchFromGithub(headers, branchName) {
  const res = await fetch(
    `https://api.github.com/repos/${CONSTANTS.GITHUB_OWNER}/${CONSTANTS.GITHUB_REPO}/git/refs/heads/${branchName}`,
    { method: "DELETE", headers }
  );
 
  console.log("deleteBranchFromGithub: Delete response: res: ", res.ok + " , response status: " + res.status + " for branch: " + branchName);

  if (!res.ok && res.status !== 404) 
  {
    if (res.status == 422)
    {
      console.log("422 means already deleted");
    }
    else
    {
      // 404 just means the branch was already gone - not a real failure
      throw new Error(`Failed to delete branch ${branchName}: ${await res.text()}`);
    }
  }
}

