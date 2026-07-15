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

export async function getTrainingContext(): Promise<string> {
  const [zonas, objetivos, plan] = await Promise.all([
    readFile("config/zonas.md"),
    readFile("config/objetivos.md"),
    readFile("plan/semana-actual.md"),
  ]);

  return [
    `# ZONAS DE ENTRENAMIENTO\n\n${zonas.content}`,
    `# OBJETIVOS\n\n${objetivos.content}`,
    `# PLAN SEMANA ACTUAL\n\n${plan.content}`,
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
