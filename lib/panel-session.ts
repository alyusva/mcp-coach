import crypto from "crypto";
import { getAthlete, type Athlete } from "@/lib/athletes";
import { signingKey } from "@/lib/oauth-codes";

/** Cookie firmada (HMAC) del panel: id del atleta + caducidad. Sin estado en servidor. */
export const PANEL_COOKIE = "coach_panel";
const MAX_AGE_SECS = 30 * 24 * 3600;

function sign(payload: string): string {
  return crypto.createHmac("sha256", `panel:${signingKey()}`).update(payload).digest("base64url");
}

export function createPanelCookie(athlete: Athlete): string {
  const payload = Buffer.from(
    JSON.stringify({ id: athlete.id, exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECS }),
  ).toString("base64url");
  const value = `${payload}.${sign(payload)}`;
  return `${PANEL_COOKIE}=${value}; Path=/panel; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE_SECS}`;
}

export function clearPanelCookie(): string {
  return `${PANEL_COOKIE}=; Path=/panel; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function athleteFromCookie(header: string | null): Athlete | undefined {
  const raw = header
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${PANEL_COOKIE}=`))
    ?.slice(PANEL_COOKIE.length + 1);
  if (!raw) return undefined;
  const dot = raw.lastIndexOf(".");
  if (dot < 0) return undefined;
  const payload = raw.slice(0, dot);
  const sig = Buffer.from(raw.slice(dot + 1));
  const expected = Buffer.from(sign(payload));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return undefined;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as { id: string; exp: number };
    if (data.exp < Date.now() / 1000) return undefined;
    return getAthlete(data.id);
  } catch {
    return undefined;
  }
}
