import { type NextRequest } from "next/server";
import { athleteByPin } from "@/lib/athletes";
import { generateCode, isAllowedRedirect } from "@/lib/oauth-codes";
import { pinAttemptsAllowed, recordPinFailure } from "@/lib/redis";

interface AuthParams {
  redirectUri: string;
  state: string | null;
  codeChallenge: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Valida los parámetros comunes; devuelve un error legible o los parámetros. */
function readParams(get: (name: string) => string | null): AuthParams | string {
  const redirectUri = get("redirect_uri");
  if (!redirectUri || get("response_type") !== "code") return "Petición de autorización incompleta.";
  if (!isAllowedRedirect(redirectUri)) return "Este cliente no está autorizado a conectarse.";
  const codeChallenge = get("code_challenge") || null;
  const method = get("code_challenge_method");
  if (codeChallenge && method && method !== "S256") return "Método PKCE no soportado.";
  return { redirectUri, state: get("state") || null, codeChallenge };
}

function page(params: AuthParams | null, message: string | null, status = 200): Response {
  const hidden = params
    ? [
        ["response_type", "code"],
        ["redirect_uri", params.redirectUri],
        ["state", params.state ?? ""],
        ["code_challenge", params.codeChallenge ?? ""],
        ["code_challenge_method", params.codeChallenge ? "S256" : ""],
      ]
        .map(([n, v]) => `<input type="hidden" name="${n}" value="${escapeHtml(v)}">`)
        .join("")
    : "";
  const form = params
    ? `<form method="POST" action="/authorize">
        ${hidden}
        <label for="pin">Tu PIN del coach</label>
        <input id="pin" name="pin" type="password" autocomplete="current-password" required autofocus>
        <button type="submit">Autorizar acceso</button>
      </form>`
    : "";
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>mcp-coach — Autorizar</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f9f9f9;padding:16px}
    .card{background:#fff;border-radius:16px;padding:40px 32px;text-align:center;max-width:360px;width:100%;box-shadow:0 2px 16px rgba(0,0,0,.08)}
    .icon{font-size:2.4rem;margin-bottom:16px}
    h2{font-size:1.2rem;font-weight:600;margin-bottom:8px}
    p{color:#666;font-size:.95rem;margin-bottom:24px;line-height:1.5}
    .error{color:#b00020}
    form{display:flex;flex-direction:column;gap:12px;text-align:left}
    label{font-size:.9rem;color:#333}
    input[type=password]{font-size:1.1rem;padding:12px;border:1px solid #ccc;border-radius:8px}
    button{background:#000;color:#fff;border:0;padding:12px 28px;border-radius:8px;font-size:1rem;font-weight:500;cursor:pointer}
    button:hover{background:#222}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🏃</div>
    <h2>mcp-coach</h2>
    <p>Claude solicita acceso a tu entrenador de running.</p>
    ${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}
    ${form}
  </div>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    },
  });
}

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export function GET(req: NextRequest) {
  const params = readParams((n) => req.nextUrl.searchParams.get(n));
  if (typeof params === "string") return page(null, params, 400);
  return page(params, null);
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const get = (n: string) => {
    const v = form.get(n);
    return typeof v === "string" ? v : null;
  };
  const params = readParams(get);
  if (typeof params === "string") return page(null, params, 400);

  const ip = clientIp(req);
  if (!(await pinAttemptsAllowed(ip))) {
    return page(params, "Demasiados intentos. Espera 15 minutos y vuelve a probar.", 429);
  }

  const athlete = athleteByPin(get("pin") ?? "");
  if (!athlete) {
    await recordPinFailure(ip);
    return page(params, "PIN incorrecto.", 401);
  }

  const code = generateCode({
    redirectUri: params.redirectUri,
    state: params.state,
    athleteId: athlete.id,
    codeChallenge: params.codeChallenge,
  });
  const callback = new URL(params.redirectUri);
  callback.searchParams.set("code", code);
  if (params.state) callback.searchParams.set("state", params.state);
  return Response.redirect(callback.toString(), 303);
}
