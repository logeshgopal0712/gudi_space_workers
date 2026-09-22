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
      from: "verify@gudispace.com",
      to: email,
      subject: "Your Gudispace verification code",
      html: `<div style="font-family: -apple-system, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background-color: #ffffff;">
      <h2 style="color: #1877F2; font-size: 20px; margin-bottom: 8px;">Gudispace</h2>
      <p style="color: #4b5563; font-size: 15px; line-height: 1.5; margin-bottom: 24px;">
        Use the code below to verify your email address.
      </p>
      <div style="background-color: #e7f0fd; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
        <span style="font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #1877F2;">${otp}</span>
      </div>
      <p style="color: #6b7280; font-size: 13px; line-height: 1.5;">
        This code expires in 5 minutes. If you didn't request this, you can safely ignore this email.
      </p>
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
      <p style="color: #9ca3af; font-size: 12px;">Gudispace · gudispace.com</p>
    </div>`
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