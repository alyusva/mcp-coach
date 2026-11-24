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
 * Limita intentos de PIN por IP: 5 cada 15 minutos.
 *
 * El intento se reserva con INCR (atómico) ANTES de comprobar el PIN, así que
 * peticiones simultáneas no pueden leer todas un contador bajo y colarse.
 * Si el PIN es correcto se devuelve el intento con releasePinAttempt.
 * Si Redis falla, se deniega (falla cerrado).
 */
const MAX_ATTEMPTS = 5;
const WINDOW_SECS = 15 * 60;

function attemptsKey(ip: string) {
  return `oauth:pin-attempts:${ip}`;
}

export async function reservePinAttempt(ip: string): Promise<boolean> {
  try {
    const count = Number(await redis(["INCR", attemptsKey(ip)]));
    if (count === 1) await redis(["EXPIRE", attemptsKey(ip), WINDOW_SECS]);
    return count <= MAX_ATTEMPTS;
  } catch {
    return false;
  }
}

export async function releasePinAttempt(ip: string): Promise<void> {
  try {
    await redis(["DECR", attemptsKey(ip)]);
  } catch {
    // Como mucho cuenta un intento de más hasta que caduque la ventana.
  }
}
