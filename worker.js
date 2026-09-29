/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run "npm run dev" in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run "npm run deploy" to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

// ---- CONFIG: update these to match your setup ----

import { knownError } from "./constants.js";
import { generateOtpPost } from "./otp_util.js";
import { generatePost, generateGet, generatePut , generateDelete, generateStatusGet, generateSanityCheckPost } from "./worker_service.js";
import { createCheckoutSessionForStripe, createPortalSession, getPlanPricesForStripe, verifyStripeWebhookSignature, applyStripeWebhookEvent } from "./stripe_util.js";
import { upsertSubscription, updateSubscriptionStatusById, getSubscriptionByEmail } from "./subscription_db.js";
import { resolveProcessorForRequest } from "./region_util.js";
import { verifyOtp } from "./otp_util.js";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*", // <-- this is the "*" you'll change later for production
    "Access-Control-Allow-Methods": "POST, GET, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

function handleResponse(resp){
  let response = new Response(JSON.stringify(resp),{
    headers: { "Content-Type": "application/json" }
  });

  const newHeaders = new Headers(response.headers);
  Object.entries(corsHeaders()).forEach(([k, v]) => newHeaders.set(k, v));
  return new Response(response.body, { status: response.status, headers: newHeaders });
}

export default {
  async fetch(request, env, ctx) {

    // Handle preflight requests
    if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    // Handled separately from everything else below: Stripe needs the
    // RAW request body to verify the signature (can't go through
    // request.json() first), and needs a real HTTP status code back
    // (200 = delivered, non-2xx = please retry) rather than the
    // always-200-with-success-flag shape handleResponse() gives every
    // other route.
    if (url.pathname == "/api/stripeWebhook" && request.method == "POST")
    {
      const rawBody = await request.text();
      const signature = request.headers.get("stripe-signature");

      try
      {
        await verifyStripeWebhookSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
        const event = JSON.parse(rawBody);

        await applyStripeWebhookEvent(env, event, {
          upsertSubscription,
          updateSubscriptionStatusById,
        });

        return new Response(JSON.stringify({ received: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      catch (error)
      {
        console.log("Stripe webhook error:", error.message);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    let message="";
    let resp;
    try
    {
      /*
      if (url.pathname == "/api/test")
      {
        if (request.method == "GET")
        {
          let result;
          const email = url.searchParams.get("email");
          const domain = url.searchParams.get("domain");

          if (email) {
            result = await env.gudispacedb
              .prepare("SELECT * FROM testtbl WHERE email = ?")
              .bind(email)
              .first();

          } else if (domain) {
            result = await env.gudispacedb
              .prepare("SELECT * FROM testtbl WHERE domain = ?")
              .bind(domain)
              .first();

          }
          else
          {
            result = await env.gudispacedb
            .prepare("SELECT * FROM testtbl")
            .all();
          }

          return new Response(JSON.stringify(result), {
            headers: {
              "Content-Type": "application/json"
            }
          });
        }
        else if (request.method == "POST")
        {
          const body = await request.json();

          const result = await env.gudispacedb
            .prepare(
              "INSERT INTO testtbl (name, email, domain) VALUES (?, ?, ?)"
            )
            .bind(body.name, body.email, body.domain)
            .run();

          return Response.json({
            success: true,
            id: result.meta.last_row_id
          });
        }
      }
      else
      */
      if (url.pathname == "/api/generate" && request.method == "POST")
      {
        try
        {
          const result = await generatePost(request, env);

          resp = {
            success: true,
            previewUrl: result.previewUrl,
            branch: result.branch,
            token: result.token,
            message: "Success in creating website."
          }

          //return handleResponse(resp);
        }
        catch(error)
        {
          message = "Failed to create website.";
          throw error;
        }
      }
      else if (url.pathname == "/api/generate" && request.method == "PUT")
      {
        try
        {
          const result = await generatePut(request, env);

          resp = {
            success: true,
            previewUrl: result.previewUrl,
            branch: result.branch,
            token: result.token,
            message: "Success in modifying website."
          }

          //return handleResponse(resp);
        }
        catch(error)
        {
          message = "Failed to modify website.";
          throw error;
        }
      }
      else if (url.pathname == "/api/generate" && request.method == "GET")
      {
        try
        {
          const data = await generateGet(request, env);

          resp = {
            success: true,
            data: data,
            message: "Success in getting website."
          }

          //return handleResponse(resp);
        }
        catch(error)
        {
          message = "Failed to get website.";
          throw error;
        }
      }
      else if (url.pathname == "/api/generate" && request.method == "DELETE")
      {
        try
        {
          await generateDelete(request, env);

          resp = {
            success: true,
            message: "Success in deleting website."
          }

          //return handleResponse(resp);
        }
        catch(error)
        {
          message = "Failed to delete website.";
          throw error;
        }
      }
      else if (url.pathname == "/api/generateStatus" && request.method == "GET")
      {
        try
        {
          const result = await generateStatusGet(request, env);

          resp = {
            success: true,
            ready: result.ready,
            status: result.status,
            message: "Success in checking website status."
          }
        }
        catch(error)
        {
          message = "Failed to check website status.";
          throw error;
        }
      }
      else if (url.pathname == "/api/generateSanityCheck" && request.method == "POST")
      {
        try
        {
          const result = await generateSanityCheckPost(request, env);

          resp = {
            success: true,
            branch: result.branchName,
            message: ""
          }
        }
        catch(error)
        {
          message = "Something failed. Please try in sometimes or contact team for help!";
          throw error;
        }
      }
      else if (url.pathname == "/api/generateOtp" && request.method == "POST")
      {
        try
        {
          await generateOtpPost(request, env);
          resp = {
            success: true,
            message: "Success in sending OTP."
          }
        }
        catch(error)
        {
          message = "Failed to send OTP.";
          throw error;
        }
      }
      else if (url.pathname == "/api/planPrices" && request.method == "GET")
      {
        try
        {
          const processor = resolveProcessorForRequest(request);

          let prices;
          if (processor === "stripe")
          {
            prices = await getPlanPricesForStripe(env);
          }
          else
          {
            // Razorpay not wired up yet - same stub reasoning as
            // /api/createCheckoutSession above.
            throw new Error("Pricing for this region isn't available yet.");
          }

          resp = {
            success: true,
            processor,
            prices,
            message: "Plan prices fetched."
          }
        }
        catch(error)
        {
          message = "Failed to fetch plan prices.";
          throw error;
        }
      }
      else if (url.pathname == "/api/createCheckoutSession" && request.method == "POST")
      {
        try
        {
          const body = await request.json();
          const processor = resolveProcessorForRequest(request);

          let result;
          if (processor === "stripe")
          {
            result = await createCheckoutSessionForStripe(env, body);
          }
          else
          {
            // Razorpay not wired up yet - resolveProcessorForRequest already
            // isolates the region logic, so adding it later is just:
            // write razorpay_util.js's own createCheckoutSessionForRazorpay,
            // then replace this branch with a real call to it. It will
            // never share code with the Stripe function above - the two
            // APIs are entirely different shapes.
            throw new Error("Payment for this region isn't available yet. Please try again soon or contact us.");
          }

          resp = {
            success: true,
            processor,
            url: result.url,
            message: "Checkout session created."
          }
        }
        catch(error)
        {
          message = "Failed to start checkout.";
          throw error;
        }
      }
      else if (url.pathname == "/api/createPortalSession" && request.method == "POST")
      {
        try
        {
          const body = await request.json();
          const { email, otp, returnUrl } = body;

          if (!email)
          {
            throw new Error("email is required");
          }
          if (!returnUrl)
          {
            throw new Error("returnUrl is required");
          }

          // Same reasoning as Modify/Delete - confirm it's really the
          // account owner before letting them into a page that can
          // cancel billing or swap the card on file.
          await verifyOtp(env, email, otp);

          const sub = await getSubscriptionByEmail(env, email);
          if (!sub?.customer_id)
          {
            throw new Error("No subscription found for this email.");
          }

          const result = await createPortalSession(env, {
            customerId: sub.customer_id,
            returnUrl,
          });

          resp = {
            success: true,
            url: result.url,
            message: "Billing portal session created."
          }
        }
        catch(error)
        {
          message = "Failed to open billing portal.";
          throw error;
        }
      }
      else if (url.pathname == "/api/paymentStatus" && request.method == "GET")
      {
        try
        {
          const email = url.searchParams.get("email");
          if (!email)
          {
            throw new Error("email is required");
          }

          const sub = await getSubscriptionByEmail(env, email);

          resp = {
            success: true,
            status: sub?.status || "none",
            plan: sub?.plan || null
          }
        }
        catch(error)
        {
          message = "Failed to check payment status.";
          throw error;
        }
      }
    }
    catch(error)
    {
      console.log("Error: " + error.message);

      // A known error (invalid email, company already used, no company
      // exists for this email, etc.) is already a clear, user-facing
      // message on its own - show just that, not the generic
      // "Failed to ..." prefix glued in front of it. Only fall back to
      // the generic prefix message for unexpected/unknown errors.
      const displayMessage = knownError(error.message)
        ? error.message
        : message;

      resp = {
        success: false,
        message: displayMessage,
        error_message: error.message
      }
    }

    return handleResponse(resp);
  }
}

