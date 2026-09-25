const GITHUB_API = "https://api.github.com";

function headers() {
  return {
    Authorization: `token ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github.v3+json",
    "Content-Type": "application/json",
    "User-Agent": "mcp-coach/1.0",
  };
}

function repoUrl(path: string) {
  return `${GITHUB_API}/repos/${process.env.MEMORY_REPO}/contents/${path}`;
}

async function readFile(path: string): Promise<{ content: string; sha: string }> {
  const res = await fetch(repoUrl(path), { headers: headers() });
  if (!res.ok) {
    if (res.status === 404) throw new Error(`FILE_NOT_FOUND:${path}`);
    throw new Error(`GitHub read error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  // GitHub returns content as base64 with newlines — strip them before decoding
  const content = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf-8");
  return { content, sha: data.sha };
}

async function writeFile(
  path: string,
  content: string,
  sha: string | null,
  message: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
  };
  if (sha) body.sha = sha;

  const res = await fetch(repoUrl(path), {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`GitHub write error ${res.status}: ${await res.text()}`);
  }
}

function isoWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

function weekLabel(year: number, week: number) {
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function formatPace(seconds: number | null): string {
  if (seconds === null) return "—";
  const mins = Math.floor(seconds / 60);
  return `${mins}:${String(Math.round(seconds % 60)).padStart(2, "0")}/km`;
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.round(seconds % 60);
  return hours > 0
    ? `${hours}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${mins}:${String(secs).padStart(2, "0")}`;
}

export interface GarminActivityRecord {
  id: number;
  name: string;
  type: string;
  date: string;
  durationSecs: number;
  distanceMeters: number;
  avgHeartRate: number | null;
  avgPaceMinPerKm: number | null;
}

export async function getTrainingContext(): Promise<string> {
  const [zonas, objetivos, metodologia, planGlobal, planActual] = await Promise.all([
    readFile("config/zonas.md"),
    readFile("config/objetivos.md"),
    readFile("config/metodologia.md").catch(() => ({ content: "_Sin contrato de datos_" })),
    readFile("plan/plan-global.md").catch(() => ({ content: "_Sin plan global_" })),
    readFile("plan/semana-actual.md"),
  ]);

  return [
    `# ZONAS DE ENTRENAMIENTO\n\n${zonas.content}`,
    `# OBJETIVOS\n\n${objetivos.content}`,
    `# METODOLOGÍA Y CONTRATO DE DATOS\n\n${metodologia.content}`,
    `# PLAN GLOBAL (9 semanas)\n\n${planGlobal.content}`,
    `# PLAN SEMANA ACTUAL\n\n${planActual.content}`,
  ].join("\n\n---\n\n");
}

export async function updateWeeklyPlan(newContent: string): Promise<string> {
  const { year, week } = isoWeek(new Date());
  const label = weekLabel(year, week);
  const logPath = `log/${label}.md`;

  // Read current plan (may not exist yet)
  let currentPlan: { content: string; sha: string } | null = null;
  try {
    currentPlan = await readFile("plan/semana-actual.md");
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("FILE_NOT_FOUND"))) throw e;
  }

  // Archive current plan to weekly log before overwriting
  if (currentPlan?.content.trim()) {
    let logSha: string | null = null;
    let logExisting = "";
    try {
      const log = await readFile(logPath);
      logSha = log.sha;
      logExisting = log.content;
    } catch (e) {
      if (!(e instanceof Error && e.message.startsWith("FILE_NOT_FOUND"))) throw e;
    }

    const archiveHeader = `## Plan archivado (${new Date().toISOString().split("T")[0]})`;
    const archiveContent = logExisting
      ? `${logExisting}\n\n---\n\n${archiveHeader}\n\n${currentPlan.content}`
      : `# Log semana ${label}\n\n${archiveHeader}\n\n${currentPlan.content}`;

    await writeFile(logPath, archiveContent, logSha, `archive: plan ${label}`);
  }

  // Write new plan
  await writeFile(
    "plan/semana-actual.md",
    newContent,
    currentPlan?.sha ?? null,
    `plan: semana ${label}`,
  );

  return `✓ Plan actualizado para ${label}. Plan anterior archivado en ${logPath}.`;
}

export async function appendTrainingLog(entry: string): Promise<string> {
  const { year, week } = isoWeek(new Date());
  const label = weekLabel(year, week);
  const logPath = `log/${label}.md`;
  const today = new Date().toISOString().split("T")[0];

  let sha: string | null = null;
  let existing = "";
  try {
    const log = await readFile(logPath);
    sha = log.sha;
    existing = log.content;
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("FILE_NOT_FOUND"))) throw e;
  }

  const newContent = existing
    ? `${existing}\n\n---\n\n## Entreno ${today}\n\n${entry}`
    : `# Log semana ${label}\n\n## Entreno ${today}\n\n${entry}`;

  await writeFile(logPath, newContent, sha, `log: entreno ${today}`);

  return `✓ Entrada añadida al log ${logPath}.`;
}

/** Persiste una actividad observada exactamente como la devuelve Garmin. */
export async function recordGarminActivity(activity: GarminActivityRecord): Promise<string> {
  const activityDate = new Date(`${activity.date.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(activityDate.getTime())) throw new Error("Fecha de actividad Garmin inválida");

  const { year, week } = isoWeek(activityDate);
  const label = weekLabel(year, week);
  const logPath = `log/${label}.md`;
  const marker = `<!-- garmin-activity:${activity.id} -->`;

  let sha: string | null = null;
  let existing = "";
  try {
    const log = await readFile(logPath);
    sha = log.sha;
    existing = log.content;
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("FILE_NOT_FOUND"))) throw e;
  }

  if (existing.includes(marker)) {
    return `✓ Actividad Garmin ${activity.id} ya estaba registrada en ${logPath}.`;
  }

  const distanceKm = (activity.distanceMeters / 1000).toFixed(2);
  const content = [
    marker,
    `## Actividad ${activity.date.slice(0, 10)} · Garmin ${activity.id}`,
    "",
    `- Nombre: ${activity.name}`,
    `- Tipo: ${activity.type}`,
    `- Distancia: ${distanceKm} km`,
    `- Duración: ${formatDuration(activity.durationSecs)}`,
    `- Ritmo medio: ${formatPace(activity.avgPaceMinPerKm)}`,
    `- FC media: ${activity.avgHeartRate === null ? "—" : `${activity.avgHeartRate} bpm`}`,
    "",
    "> Datos observados importados de Garmin. La interpretación se registra por separado y debe citar esta actividad.",
  ].join("\n");

  const newContent = existing
    ? `${existing}\n\n---\n\n${content}`
    : `# Log semana ${label}\n\n${content}`;

  await writeFile(logPath, newContent, sha, `log: Garmin actividad ${activity.id}`);
  return `✓ Actividad Garmin ${activity.id} registrada en ${logPath}.`;
}

/** Cambia el estado de programación sin archivar de nuevo toda la semana. */
export async function setWeeklyWorkoutsCreated(created: boolean): Promise<string> {
  const plan = await readFile("plan/semana-actual.md");
  const marker = `workouts_created: ${created}`;
  const content = /workouts_created:\s*(true|false)/.test(plan.content)
    ? plan.content.replace(/workouts_created:\s*(true|false)/, marker)
    : `${plan.content.trimEnd()}\n\n${marker}\n`;

  await writeFile("plan/semana-actual.md", content, plan.sha, `plan: workouts ${created ? "created" : "pending"}`);
  return `✓ Estado de workouts actualizado a ${created}.`;
}

/** Sobrescribe la tabla de salud semanal; el cron puede reintentarse sin duplicarla. */
export async function writeHealthLog(content: string): Promise<string> {
  const { year, week } = isoWeek(new Date());
  const label = weekLabel(year, week);
  const healthPath = `health/${label}.md`;
  let sha: string | null = null;
  try {
    sha = (await readFile(healthPath)).sha;
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("FILE_NOT_FOUND"))) throw e;
  }
  await writeFile(healthPath, content, sha, `health: semana ${label}`);
  return `✓ Datos de salud escritos en ${healthPath}.`;
}

export async function getHealthContext(weeks = 2): Promise<string> {
  const now = new Date();
  const labels = Array.from({ length: weeks }, (_, index) => {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - index * 7);
    const { year, week } = isoWeek(date);
    return weekLabel(year, week);
  });
  const files = await Promise.all(
    [...new Set(labels)].map((label) =>
      readFile(`health/${label}.md`).then((file) => file.content).catch(() => null),
    ),
  );
  const found = files.filter((content): content is string => content !== null);
  return found.length > 0 ? found.reverse().join("\n\n---\n\n") : "_Sin datos de salud registrados aún._";
}
