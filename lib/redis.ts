/** Cliente mínimo de la API REST de Upstash (mismo REDIS_URL que usa el backend Python). */
export async function redis(command: (string | number)[]): Promise<unknown> {
  const raw = process.env.REDIS_URL;
  if (!raw) throw new Error("Falta REDIS_URL");
  const parsed = new URL(raw);
  const res = await fetch(`https://${parsed.hostname}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${decodeURIComponent(parsed.password)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Redis ${res.status}`);
  return ((await res.json()) as { result?: unknown }).result;
}

/**
 * Limita intentos fallidos de PIN por IP. Devuelve true si aún se permite.
 * Si Redis falla, se deniega (falla cerrado).
 */
const MAX_FAILURES = 5;
const WINDOW_SECS = 15 * 60;

function failureKey(ip: string) {
  return `oauth:pin-fail:${ip}`;
}

export async function pinAttemptsAllowed(ip: string): Promise<boolean> {
  try {
    const count = Number((await redis(["GET", failureKey(ip)])) ?? 0);
    return count < MAX_FAILURES;
  } catch {
    return false;
  }
}

export async function recordPinFailure(ip: string): Promise<void> {
  try {
    const count = await redis(["INCR", failureKey(ip)]);
    if (Number(count) === 1) await redis(["EXPIRE", failureKey(ip), WINDOW_SECS]);
  } catch {
    // Si Redis no responde, pinAttemptsAllowed ya deniega.
  }
}
