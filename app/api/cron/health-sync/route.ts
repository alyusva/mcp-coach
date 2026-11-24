import { getGarminHealthData, type DailyHealth } from "@/lib/garmin-client";
import { writeHealthLog } from "@/lib/github-memory";
import { listAthletes, type Athlete } from "@/lib/athletes";

// Un atleta por vuelta en paralelo: el tiempo total es el del más lento.
export const maxDuration = 300;

function isoWeekBounds(date: Date): { monday: string; sunday: string; label: string } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7; // domingo=0 -> 7
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - day + 1);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);

  const yearStart = new Date(Date.UTC(monday.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((monday.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);

  return {
    monday: monday.toISOString().split("T")[0],
    sunday: sunday.toISOString().split("T")[0],
    label: `${monday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`,
  };
}

function fmtDuration(seconds: number | null): string {
  if (!seconds) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h${String(m).padStart(2, "0")}m`;
}

function fmtDay(day: DailyHealth): string {
  const dow = new Date(`${day.date}T00:00:00Z`).toLocaleDateString("es-ES", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    timeZone: "UTC",
  });

  const sleep = day.sleep
    ? `${fmtDuration(day.sleep.totalSleepSeconds)}${day.sleep.scoreValue !== null ? ` (${day.sleep.scoreValue})` : ""}`
    : "—";
  const fases = day.sleep
    ? `${fmtDuration(day.sleep.deepSeconds)}/${fmtDuration(day.sleep.lightSeconds)}/${fmtDuration(day.sleep.remSeconds)}`
    : "—";
  const hrv = day.hrv ? `${day.hrv.lastNightAvg ?? "—"}ms (${day.hrv.status ?? "—"})` : "—";
  const battery = day.bodyBattery
    ? `+${day.bodyBattery.charged ?? "—"}/-${day.bodyBattery.drained ?? "—"}`
    : "—";
  const rhr = day.restingHeartRate ?? "—";
  const stress = day.stress ? `${day.stress.avgLevel ?? "—"}` : "—";
  const readiness = day.trainingReadiness
    ? `${day.trainingReadiness.score ?? "—"} (${day.trainingReadiness.level ?? "—"})`
    : "—";

  return `| ${dow} | ${sleep} | ${fases} | ${hrv} | ${battery} | ${rhr} | ${stress} | ${readiness} |`;
}

async function syncAthlete(athlete: Athlete, monday: string, sunday: string, label: string) {
  const days = await getGarminHealthData(athlete, monday, sunday);

  const content = `# Salud semana ${label}

| Día | Sueño (score) | Fases P/L/R | HRV | Body Battery (+/-) | FC reposo | Estrés | Training Readiness |
|---|---|---|---|---|---|---|---|
${days.map(fmtDay).join("\n")}
`;

  const result = await writeHealthLog(athlete, content);
  return { daysProcessed: days.length, result };
}

/** Sincroniza la salud de todos los atletas, o solo de ?athlete=<id>. */
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const only = new URL(req.url).searchParams.get("athlete");
  const athletes = listAthletes().filter((a) => !only || a.id === only);
  if (athletes.length === 0) return Response.json({ error: "Atleta no encontrado" }, { status: 404 });

  const { monday, sunday, label } = isoWeekBounds(new Date());
  const settled = await Promise.allSettled(
    athletes.map((athlete) => syncAthlete(athlete, monday, sunday, label)),
  );
  const results = Object.fromEntries(
    settled.map((r, i) => [
      athletes[i].id,
      r.status === "fulfilled" ? { ok: true, ...r.value } : { ok: false, error: String(r.reason) },
    ]),
  );
  const success = settled.every((r) => r.status === "fulfilled");

  return Response.json({ success, label, results }, { status: success ? 200 : 207 });
}
