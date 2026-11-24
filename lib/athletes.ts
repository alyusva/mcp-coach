import crypto from "crypto";

/**
 * Registro de atletas del servidor.
 *
 * Cada atleta tiene su propio token MCP, su PIN para autorizar el conector,
 * su repo de memoria y su sesión de Garmin. El atleta de una petición lo decide
 * SIEMPRE el token con el que llega, nunca un parámetro de las tools: así el
 * Claude de una persona no puede leer ni escribir los datos de otra.
 *
 * Se configura con la variable de entorno ATHLETES (JSON). Si no existe, el
 * servidor funciona en modo de un solo atleta con las variables antiguas
 * (MCP_AUTH_TOKEN, MEMORY_REPO, GARMIN_EMAIL/GARMIN_PASSWORD, AUTHORIZE_PIN).
 */
export interface Athlete {
  /** Identificador corto: minúsculas, números y guiones. */
  id: string;
  /** Nombre para mostrar (prompts del cron, mensajes). */
  name: string;
  /** Bearer token del conector MCP de esta persona. */
  token: string;
  /** PIN o frase para autorizar el conector en Claude (flujo OAuth). */
  pin: string | null;
  /** Repo de memoria "usuario/repo". */
  memoryRepo: string;
  /** Clave de Redis donde vive la sesión de Garmin de esta persona. */
  garminSessionKey: string;
  /** Si true, puede hacer login en Garmin con GARMIN_EMAIL/GARMIN_PASSWORD. */
  garminEnvLogin: boolean;
  /** Token de GitHub propio para su repo de memoria (si no, se usa GITHUB_TOKEN). */
  githubToken: string | null;
  /** Enlace a su proyecto de Claude para el botón del panel (opcional). */
  claudeProjectUrl: string | null;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LEGACY_SESSION_KEY = "garmin:session";

function fail(msg: string): never {
  throw new Error(`Configuración ATHLETES inválida: ${msg}`);
}

function parseAthletes(raw: string): Athlete[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    fail("no es JSON válido");
  }
  if (!Array.isArray(data) || data.length === 0) fail("debe ser una lista con al menos un atleta");

  const athletes = data.map((item, i): Athlete => {
    if (typeof item !== "object" || item === null) fail(`entrada ${i} no es un objeto`);
    const a = item as Record<string, unknown>;
    const id = String(a.id ?? "");
    if (!ID_RE.test(id)) fail(`id "${id}" no válido (minúsculas, números y guiones)`);
    const token = String(a.token ?? "");
    if (token.length < 32) fail(`el token de "${id}" debe tener al menos 32 caracteres`);
    const pin = a.pin === undefined || a.pin === null ? null : String(a.pin);
    if (pin !== null && pin.length < 6) fail(`el pin de "${id}" debe tener al menos 6 caracteres`);
    const memoryRepo = String(a.memoryRepo ?? "");
    if (!REPO_RE.test(memoryRepo)) fail(`memoryRepo de "${id}" debe ser "usuario/repo"`);
    const garminSessionKey = String(a.garminSessionKey ?? `${LEGACY_SESSION_KEY}:${id}`);
    if (!/^garmin:session(:[a-z0-9-]+)?$/.test(garminSessionKey)) {
      fail(`garminSessionKey de "${id}" no válido`);
    }
    const githubToken = a.githubToken ? String(a.githubToken) : null;
    if (githubToken !== null && !/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(githubToken)) {
      fail(`githubToken de "${id}" no parece un token de GitHub`);
    }
    const claudeProjectUrl = a.claudeProjectUrl ? String(a.claudeProjectUrl) : null;
    if (claudeProjectUrl && !/^https:\/\/claude\.ai\//.test(claudeProjectUrl)) {
      fail(`claudeProjectUrl de "${id}" debe empezar por https://claude.ai/`);
    }
    return {
      id,
      name: String(a.name ?? id),
      token,
      pin,
      memoryRepo,
      garminSessionKey,
      garminEnvLogin: a.garminEnvLogin === true,
      githubToken,
      claudeProjectUrl,
    };
  });

  const unique = (values: string[], what: string) => {
    if (new Set(values).size !== values.length) fail(`hay ${what} repetidos`);
  };
  unique(athletes.map((a) => a.id), "ids");
  unique(athletes.map((a) => a.token), "tokens");
  unique(athletes.flatMap((a) => (a.pin ? [a.pin] : [])), "pins");
  unique(athletes.map((a) => a.garminSessionKey), "garminSessionKey");
  if (athletes.filter((a) => a.garminEnvLogin).length > 1) {
    fail("solo un atleta puede usar GARMIN_EMAIL/GARMIN_PASSWORD (garminEnvLogin)");
  }
  return athletes;
}

function legacyAthlete(): Athlete[] {
  const token = process.env.MCP_AUTH_TOKEN;
  const memoryRepo = process.env.MEMORY_REPO;
  if (!token || !memoryRepo) return [];
  return [
    {
      id: "default",
      name: process.env.ATHLETE_NAME ?? "Atleta",
      token,
      pin: process.env.AUTHORIZE_PIN || null,
      memoryRepo,
      garminSessionKey: LEGACY_SESSION_KEY,
      garminEnvLogin: true,
      githubToken: null,
      claudeProjectUrl: process.env.CLAUDE_PROJECT_URL || null,
    },
  ];
}

let cache: { raw: string | undefined; athletes: Athlete[] } | null = null;

export function listAthletes(): Athlete[] {
  const raw = process.env.ATHLETES;
  if (!cache || cache.raw !== raw) {
    cache = { raw, athletes: raw ? parseAthletes(raw) : legacyAthlete() };
  }
  return cache.athletes;
}

export function getAthlete(id: string): Athlete | undefined {
  return listAthletes().find((a) => a.id === id);
}

/** Comparación en tiempo constante (hash previo para igualar longitudes). */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function findBy(value: string, pick: (a: Athlete) => string | null): Athlete | undefined {
  let found: Athlete | undefined;
  // Recorre todos para no filtrar por tiempo qué posición coincide.
  for (const athlete of listAthletes()) {
    const candidate = pick(athlete);
    if (candidate !== null && safeEqual(value, candidate) && !found) found = athlete;
  }
  return found;
}

export function athleteByToken(token: string): Athlete | undefined {
  return findBy(token, (a) => a.token);
}

export function athleteByPin(pin: string): Athlete | undefined {
  return findBy(pin, (a) => a.pin);
}
