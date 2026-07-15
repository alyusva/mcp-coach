import crypto from "crypto";

function key() {
  return process.env.MCP_AUTH_TOKEN ?? "dev-insecure-key";
}

export function generateCode(redirectUri: string, state: string | null): string {
  const payload = Buffer.from(
    JSON.stringify({ uri: redirectUri, state, ts: Date.now() })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", key()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function validateCode(code: string, redirectUri: string): boolean {
  const dot = code.lastIndexOf(".");
  if (dot < 0) return false;
  const payload = code.slice(0, dot);
  const sig = code.slice(dot + 1);

  const expected = crypto.createHmac("sha256", key()).update(payload).digest("base64url");
  if (sig !== expected) return false;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (parsed.uri !== redirectUri) return false;
    if (Date.now() - parsed.ts > 5 * 60 * 1000) return false; // 5 min TTL
    return true;
  } catch {
    return false;
  }
}
