import crypto from "crypto";
import { metadataCorsOptionsRequestHandler } from "@vercel/mcp-adapter";

// RFC 7591 — Dynamic Client Registration
// Claude mobile and claude.ai web call this before starting the OAuth flow.
// Since this is a personal single-user server we accept any client and return
// a deterministic client_id derived from the redirect URI.

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const redirectUris = (body.redirect_uris as string[]) ?? [];
  if (!redirectUris.length) {
    return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
  }

  // Deterministic client_id from the first redirect URI — no storage needed.
  const clientId = crypto
    .createHash("sha256")
    .update(redirectUris[0])
    .digest("hex")
    .slice(0, 24);

  return Response.json(
    {
      client_id: clientId,
      client_name: body.client_name ?? "claude",
      redirect_uris: redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    },
  );
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
