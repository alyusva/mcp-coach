import { type NextRequest } from "next/server";
import { generateCode } from "@/lib/oauth-codes";

export function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const redirectUri = p.get("redirect_uri");
  const state = p.get("state");

  if (!redirectUri || p.get("response_type") !== "code") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const code = generateCode(redirectUri, state);
  const callback = new URL(redirectUri);
  callback.searchParams.set("code", code);
  if (state) callback.searchParams.set("state", state);

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>mcp-coach — Autorizar</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f9f9f9}
    .card{background:#fff;border-radius:16px;padding:40px 32px;text-align:center;max-width:340px;box-shadow:0 2px 16px rgba(0,0,0,.08)}
    .icon{font-size:2.4rem;margin-bottom:16px}
    h2{font-size:1.2rem;font-weight:600;margin-bottom:8px}
    p{color:#666;font-size:.9rem;margin-bottom:28px;line-height:1.5}
    a{display:inline-block;background:#000;color:#fff;text-decoration:none;padding:11px 28px;border-radius:8px;font-size:.95rem;font-weight:500}
    a:hover{background:#222}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🏃</div>
    <h2>mcp-coach</h2>
    <p>Claude solicita acceso a tu entrenador AI de running.</p>
    <a href="${callback.toString()}">Autorizar acceso</a>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
