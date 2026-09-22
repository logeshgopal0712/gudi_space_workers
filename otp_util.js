import { ERROR_CODES } from "./constants.js";

async function generateAndSendOtp(env, email) {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  await env.OTP_STORE.put(email, otp, { expirationTtl: 300 });

  const emailRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.EMAIL_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: "onboarding@resend.dev",
      to: email,
      subject: "Your OTP Code",
      html: `<p>Your OTP is <b>${otp}</b>. It expires in 5 minutes.</p>`
    })
  });

  if (!emailRes.ok) {
    const err = await emailRes.text();
    throw new Error(err);
  }

  return true;
}

export async function generateOtpPost(request, env)
{
  let body;
  try {
    body = await request.json();
  } catch (err) {
    throw new Error("Invalid JSON");
  }

  const { email } = body;
  if (!email || typeof email !== "string") 
  {
    throw new Error(ERROR_CODES.INVALID_EMAIL);
  }

  try 
  {
    await generateAndSendOtp(env, email);
  } 
  catch (err) 
  {
    throw new Error("Failed to send. May be wrong email. err: " + err.message);
  }
}

// ---------------------------------------------------------
// Verifies a submitted OTP against what's stored in KV for that email.
// Deletes the OTP from KV once verified (single-use), so it can't be
// reused for a second request.
// ---------------------------------------------------------
export async function verifyOtp(env, email, submittedOtp) {
  const storedOtp = await env.OTP_STORE.get(email);

  if (!submittedOtp)
  {
    throw new Error(ERROR_CODES.OTP_REQUIRED);
  }

  if (!storedOtp) {
    // No OTP found - either never requested, or it expired (5 min TTL)
    //throw new Error("OTP expired or not found. Please request a new one.");
    throw new Error(ERROR_CODES.OTP_EXPIRED);
  }

  if (storedOtp !== submittedOtp) {
    //throw new Error("Invalid OTP.");
    throw new Error(ERROR_CODES.INVALID_OTP);
  }

  // Correct - delete it now so it can't be reused
  await env.OTP_STORE.delete(email);

  return true;
}