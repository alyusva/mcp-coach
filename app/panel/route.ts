import { type NextRequest } from "next/server";
import { Marked } from "marked";
import { athleteByPin, type Athlete } from "@/lib/athletes";
import { getGarminScheduledWorkouts, type ScheduledWorkout } from "@/lib/garmin-client";
import { getPanelDocs } from "@/lib/github-memory";
import { athleteFromCookie, clearPanelCookie, createPanelCookie } from "@/lib/panel-session";
import { releasePinAttempt, reservePinAttempt } from "@/lib/redis";

export const maxDuration = 30;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Markdown de la memoria → HTML. El HTML crudo se escapa y solo se permiten
// enlaces http(s), así que un texto guardado en la memoria no puede inyectar script.
const md = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      return /^https?:\/\//i.test(href)
        ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank">${label}</a>`
        : label;
    },
    image({ text }) {
      return escapeHtml(text);
    },
  },
});

function render(markdown: string | null, empty: string): string {
  if (!markdown?.trim()) return `<p class="muted">${escapeHtml(empty)}</p>`;
  return md.parse(markdown, { async: false }) as string;
}

const STYLE = `
:root{--bg:#f6f6f4;--card:#fff;--text:#1c1c1a;--muted:#6b6b66;--line:#e4e4df;--accent:#111;--accent-text:#fff;--err:#b00020}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1f1f1d;--text:#ececea;--muted:#a3a39d;--line:#33332f;--accent:#ececea;--accent-text:#141413;--err:#ff6b81}}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
main{max-width:760px;margin:0 auto;padding:24px 16px 48px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-bottom:20px}
h1{font-size:1.4rem;margin:0}
h2{font-size:1.05rem;margin:0 0 8px}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 18px 8px;margin-bottom:16px;overflow-x:auto}
section h1{font-size:1.1rem}section h2{font-size:1rem}section h3{font-size:.95rem}
table{border-collapse:collapse;width:100%;font-size:.92rem;margin-bottom:12px}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.muted{color:var(--muted)}
.btn{display:inline-block;background:var(--accent);color:var(--accent-text);text-decoration:none;border:0;padding:10px 18px;border-radius:10px;font-size:.95rem;font-weight:600;cursor:pointer}
.link{background:none;border:0;color:var(--muted);text-decoration:underline;cursor:pointer;font-size:.9rem;padding:0}
.cal{list-style:none;padding:0;margin:0 0 12px}.cal li{padding:8px 0;border-bottom:1px solid var(--line)}
.cal b{display:inline-block;min-width:110px}
details summary{cursor:pointer;color:var(--muted);margin-bottom:8px}
.login{max-width:360px;margin:12vh auto;text-align:center}
.login form{display:flex;flex-direction:column;gap:12px;text-align:left;margin-top:16px}
.login input{font-size:1.1rem;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--text)}
.error{color:var(--err)}
`;

function page(title: string, body: string, status = 200, setCookie?: string): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  return new Response(
    `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`,
    { status, headers },
  );
}

function loginPage(message: string | null, status = 200): Response {
  return page(
    "Mi coach",
    `<main class="login"><div style="font-size:2.4rem">🏃</div><h1>Mi coach</h1>
     <p class="muted">Escribe tu PIN para ver tu plan.</p>
     ${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}
     <form method="POST" action="/panel">
       <input type="hidden" name="action" value="login">
       <input name="pin" type="password" autocomplete="current-password" aria-label="PIN" required autofocus>
       <button class="btn" type="submit">Entrar</button>
     </form></main>`,
    status,
  );
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fmtDay(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("es-ES", {
    weekday: "long",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

async function calendar(athlete: Athlete): Promise<string> {
  const today = new Date();
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() + 7);
  let workouts: ScheduledWorkout[];
  try {
    workouts = await getGarminScheduledWorkouts(athlete, isoDate(today), isoDate(end));
  } catch {
    return `<p class="muted">No se ha podido leer Garmin ahora mismo.</p>`;
  }
  if (workouts.length === 0) return `<p class="muted">No hay entrenos programados en Garmin para los próximos 7 días.</p>`;
  return `<ul class="cal">${workouts
    .map((w) => `<li><b>${escapeHtml(fmtDay(w.scheduledDate))}</b> ${escapeHtml(w.name)}</li>`)
    .join("")}</ul>`;
}

async function dashboard(athlete: Athlete): Promise<Response> {
  const [docs, cal] = await Promise.all([getPanelDocs(athlete), calendar(athlete)]);
  const chat = athlete.claudeProjectUrl ?? "https://claude.ai/new";
  const body = `<main>
    <header>
      <h1>Hola, ${escapeHtml(athlete.name)}</h1>
      <a class="btn" href="${escapeHtml(chat)}" target="_blank" rel="noopener noreferrer">Hablar con mi coach</a>
    </header>
    <section><h2>Próximos 7 días en Garmin</h2>${cal}</section>
    <section><h2>Plan de la semana</h2>${render(
      docs.semana?.replace(/^workouts_created:\s*(true|false)\s*$/gm, "") ?? null,
      "Aún no hay plan. Pídeselo a tu coach.",
    )}</section>
    ${docs.resumen ? `<section><h2>Lo que dice el coach</h2>${render(docs.resumen, "")}</section>` : ""}
    <section><h2>Objetivo</h2>${render(docs.objetivos, "Aún no hay objetivo. Cuéntaselo a tu coach.")}</section>
    <section><h2>Cuándo puedes entrenar</h2>${render(docs.disponibilidad, "Aún no has dicho qué días puedes entrenar.")}</section>
    ${docs.planGlobal ? `<section><details><summary>Plan completo hasta el objetivo</summary>${render(docs.planGlobal, "")}</details></section>` : ""}
    <form method="POST" action="/panel"><input type="hidden" name="action" value="logout"><button class="link" type="submit">Salir</button></form>
  </main>`;
  return page("Mi coach", body);
}

function clientIp(req: NextRequest): string {
  return req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

export async function GET(req: NextRequest) {
  const athlete = athleteFromCookie(req.headers.get("cookie"));
  return athlete ? dashboard(athlete) : loginPage(null);
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  if (form.get("action") === "logout") {
    return new Response(null, { status: 303, headers: { Location: "/panel", "Set-Cookie": clearPanelCookie() } });
  }

  const ip = clientIp(req);
  if (!(await reservePinAttempt(ip))) {
    return loginPage("Demasiados intentos. Espera 15 minutos y vuelve a probar.", 429);
  }
  const pin = form.get("pin");
  const athlete = typeof pin === "string" ? athleteByPin(pin) : undefined;
  if (!athlete) return loginPage("PIN incorrecto.", 401);
  await releasePinAttempt(ip);

  return new Response(null, { status: 303, headers: { Location: "/panel", "Set-Cookie": createPanelCookie(athlete) } });
}
