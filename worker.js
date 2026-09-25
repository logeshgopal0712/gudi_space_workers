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
import { generatePost, generateGet, generatePut , generateDelete, generateStatusGet } from "./worker_service.js";

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
    }
    catch(error)
    {
      console.log("Error: " + error.message);
      let reason="";
      if (knownError(error.message))
      {
        reason = " Reason: " + error.message;
      }

      resp = {
        success: false,
        message: message + reason,
        error_message: error.message
      }
    }

    return handleResponse(resp);
  }
}

