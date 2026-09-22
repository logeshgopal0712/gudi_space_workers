export const ERROR_CODES = {
    INVALID_EMAIL: "Invalid email.",
    EMAIL_ALREADY_USED: "Email already used.",
    INVALID_COMPANY_NAME: "Invalid company name.",
    COMPANY_ALREADY_USED: "Company name already used. Try another name or contact team for help!",
    NO_COMPANY_EXISTS_FOR_EMAIL: "No company exists for provided email.",
    OTP_SENT: "OTP generated and sent.",
    //FAILED_TO_SEND_OTP: "Failed to send OTP.",
    OTP_EXPIRED: "OTP expired or not found. Please request a new one.",
    INVALID_OTP: "Invalid OTP.",
    OTP_REQUIRED: "OTP required."
};

export function knownError(errorMessage)
{
  return Object.values(ERROR_CODES).includes(errorMessage);
}

export const CONSTANTS = {
  CF_ACCOUNT_ID : "9171502d93ce6d0dc734a387010b2365",
  CF_PAGES_PROJECT_NAME : "cloudflaretest",
  GITHUB_OWNER : "logeshgopal0712",
  GITHUB_REPO : "cloudflareTest",
  FILE_PATH : "data/data.json",          // path to the file inside the repo
  PAGES_PROJECT : "cloudflaretest-aa3.pages.dev" // e.g. "my-site" -> my-site.pages.dev
};