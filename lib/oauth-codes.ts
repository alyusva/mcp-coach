import crypto from "crypto";

function key(): string {
  const secret = process.env.OAUTH_SIGNING_SECRET || process.env.INTERNAL_API_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV !== "production") return "dev-insecure-key";
  throw new Error("Falta OAUTH_SIGNING_SECRET (o INTERNAL_API_SECRET) para firmar códigos OAuth");
}

const CODE_TTL_MS = 5 * 60 * 1000;

interface CodePayload {
  uri: string;
  state: string | null;
  athleteId: string;
  /** PKCE (S256), obligatorio. */
  challenge: string;
  ts: number;
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", key()).update(payload).digest("base64url");
}

export function generateCode(params: {
  redirectUri: string;
  state: string | null;
  athleteId: string;
  codeChallenge: string;
}): string {
  const body: CodePayload = {
    uri: params.redirectUri,
    state: params.state,
    athleteId: params.athleteId,
    challenge: params.codeChallenge,
    ts: Date.now(),
  };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Devuelve el id del atleta si el código es válido, o null. */
export function validateCode(
  code: string,
  redirectUri: string,
  codeVerifier: string | undefined,
): string | null {
  const dot = code.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = code.slice(0, dot);
  const sig = Buffer.from(code.slice(dot + 1));
  const expected = Buffer.from(sign(payload));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as CodePayload;
    if (parsed.uri !== redirectUri) return null;
    if (Date.now() - parsed.ts > CODE_TTL_MS) return null;
    if (!parsed.challenge || !codeVerifier) return null;
    const computed = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    if (computed !== parsed.challenge) return null;
    return typeof parsed.athleteId === "string" ? parsed.athleteId : null;
  } catch {
    return null;
  }
}

/**
 * Solo se entregan códigos a callbacks de Claude (o a localhost para Claude Code).
 * OAUTH_ALLOWED_REDIRECT_HOSTS permite añadir más hosts separados por comas.
 */
export function isAllowedRedirect(redirectUri: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.protocol === "http:") {
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  }
  if (url.protocol !== "https:") return false;
  const hosts = (process.env.OAUTH_ALLOWED_REDIRECT_HOSTS ?? "claude.ai,claude.com")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return hosts.includes(url.hostname.toLowerCase());
}
