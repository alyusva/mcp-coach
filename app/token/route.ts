import { type NextRequest } from "next/server";
import { validateCode } from "@/lib/oauth-codes";

export async function POST(req: NextRequest) {
  let body: Record<string, string> = {};
  const ct = req.headers.get("content-type") ?? "";

  if (ct.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    body = Object.fromEntries(new URLSearchParams(text));
  } else {
    body = await req.json().catch(() => ({}));
  }

  const { grant_type, code, redirect_uri } = body;

  if (grant_type !== "authorization_code") {
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  }
  if (!code || !redirect_uri) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  if (!validateCode(code, redirect_uri)) {
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  }

  return Response.json(
    {
      access_token: process.env.MCP_AUTH_TOKEN,
      token_type: "Bearer",
      expires_in: 60 * 60 * 24 * 30, // 30 days
    },
    { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } },
  );
}

export function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
