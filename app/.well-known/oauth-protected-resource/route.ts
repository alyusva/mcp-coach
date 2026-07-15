import { protectedResourceHandler, metadataCorsOptionsRequestHandler } from "@vercel/mcp-adapter";

const BASE = "https://mcp-coach.vercel.app";

const h = protectedResourceHandler({
  authServerUrls: [BASE],
  resourceUrl: `${BASE}/mcp`,
});

export const GET = h;
export const OPTIONS = metadataCorsOptionsRequestHandler();
