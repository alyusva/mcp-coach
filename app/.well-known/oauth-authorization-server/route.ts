import { metadataCorsOptionsRequestHandler } from "@vercel/mcp-adapter";

const BASE = "https://mcp-coach.vercel.app";

export function GET() {
  return Response.json(
    {
      issuer: BASE,
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/token`,
      registration_endpoint: `${BASE}/register`,
      token_endpoint_auth_methods_supported: ["none"],
      grant_types_supported: ["authorization_code"],
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [],
    },
    { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } },
  );
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
