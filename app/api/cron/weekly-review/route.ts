import Anthropic from "@anthropic-ai/sdk";
import { listAthletes, type Athlete } from "@/lib/athletes";
import {
  getCoachInstructions,
  getTrainingContext,
  updateWeeklyPlan,
  getHealthContext,
  recordGarminActivity,
  setWeeklyWorkoutsCreated,
} from "@/lib/github-memory";
import {
  createGarminWorkout,
  getGarminRecentActivities,
  type CreateWorkoutParams,
} from "@/lib/garmin-client";

export const maxDuration = 300;

const anthropic = new Anthropic();

/**
 * Prompt común a todos los atletas. Lo específico de cada persona (carrera
 * objetivo, reglas duras, tono, precauciones médicas) vive en config/coach.md
 * de su repo de memoria y se añade al final.
 */
function systemPrompt(athlete: Athlete, coachInstructions: string | null): string {
  return `Eres el entrenador AI automatizado de ${athlete.name}.

Ejecutas una vez por semana, justo después de que un cron independiente (health-sync) haya sincronizado los datos de salud de la semana que acaba de terminar (sueño, HRV, body battery, FC en reposo, estrés, training readiness) en su repo de memoria. Tu misión en cada ejecución:
1. Leer el contexto completo: instrucciones del coach, zonas, objetivos, plan global si existe y plan de la semana que acaba de terminar (get_training_context), y el contexto de salud de las últimas 2 semanas (get_health_context).
2. Leer las actividades de Garmin de los últimos 14 días.
3. Registrar exclusivamente los datos observados de cada sesión de la semana pasada. No inventes, infieras ni completes métricas ausentes.
4. Analizar qué se hizo vs qué estaba planificado, separando "hechos observados" de "interpretación". Si una sesión no aparece en Garmin, di "no observada"; nunca "no realizada". Cruza la evidencia con salud: HRV bajo, sueño pobre repetido o Training Readiness bajo sostenido cuentan como fatiga severa.
5. Generar el plan de la semana siguiente SOLO en los días de la disponibilidad del atleta (sección DISPONIBILIDAD), con la sesión larga en su día preferido. Si hay plan global, síguelo; si no, progresa de forma prudente según objetivos y metodología. Si no hay objetivo, no inventes uno: plan suave de mantenimiento y anótalo.
6. Escribir el plan con update_weekly_plan en formato markdown completo.
7. SOLO SI el plan actual indica "workouts_created: false": crear en Garmin UN workout por cada sesión programada. Si ya indica "workouts_created: true", NO crear workouts (ya existen).

Reglas generales:
- Responde siempre en español.
- Una predicción o diagnóstico nunca es un hecho: etiqueta explícitamente su incertidumbre.
- Las instrucciones específicas de este atleta mandan sobre estas reglas generales.

# Instrucciones específicas de ${athlete.name} (config/coach.md)

${coachInstructions?.trim() || "_No hay instrucciones específicas. Sé conservador: progresión suave, nada de intensidad alta sin una indicación expresa en objetivos o metodología._"}`;
}

const WEEKLY_REVIEW_PROMPT = `Es lunes. Ejecuta la revisión semanal completa:

1. Llama a get_training_context. Fíjate en el campo "workouts_created" del plan de la semana siguiente para saber si ya tienes que crear workouts en Garmin o no.
2. Llama a get_health_context con weeks=2 para ver la tendencia de sueño, HRV, body battery, FC reposo, estrés y training readiness de la semana que acaba de terminar y la anterior.
3. Llama a get_garmin_recent_activities con limit=14.
4. Para cada sesión de running de la semana pasada, llama a record_garmin_activity una vez, copiando exactamente sus campos. No escribas interpretación dentro de ese registro.
5. Determina qué semana del plan global corresponde a la próxima semana. Sigue su sesión de calidad y tirada larga. Si el contexto de salud muestra fatiga acumulada, refléjalo y cita la evidencia.
6. Escribe el plan completo con update_weekly_plan. Incluye al final: "workouts_created: false".
7. Si workouts_created era false (o no existía), crea los workouts y llama a set_weekly_workouts_created con created: true. No llames de nuevo a update_weekly_plan.

Cuando termines, responde con un resumen: sesiones registradas, tendencia de salud observada, plan escrito, workouts creados (o saltados por ya existir).`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_training_context",
    description:
      "Lee las zonas de FC/ritmo/potencia, objetivos de temporada, plan global (9 semanas) y el plan de la semana actual.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_health_context",
    description:
      "Lee el histórico de salud (sueño, HRV, body battery, FC reposo, estrés, training readiness) de las últimas N semanas.",
    input_schema: {
      type: "object" as const,
      properties: {
        weeks: { type: "integer", minimum: 1, maximum: 8, default: 2 },
      },
    },
  },
  {
    name: "get_garmin_recent_activities",
    description:
      "Obtiene las últimas N actividades de Garmin Connect (fecha, tipo, distancia, FC media, ritmo medio).",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 30, default: 14 },
      },
    },
  },
  {
    name: "record_garmin_activity",
    description:
      "Registra una actividad observada de Garmin una sola vez. Copiar métricas sin modificarlas.",
    input_schema: {
      type: "object" as const,
      properties: {
        activityId: { type: "integer" },
        name: { type: "string" },
        type: { type: "string" },
        date: { type: "string" },
        durationSecs: { type: "number" },
        distanceMeters: { type: "number" },
        avgHeartRate: { type: ["number", "null"] },
        avgPaceMinPerKm: { type: ["number", "null"] },
      },
      required: ["activityId", "name", "type", "date", "durationSecs", "distanceMeters", "avgHeartRate", "avgPaceMinPerKm"],
    },
  },
  {
    name: "set_weekly_workouts_created",
    description: "Actualiza únicamente el estado de creación de workouts sin archivar el plan.",
    input_schema: {
      type: "object" as const,
      properties: { created: { type: "boolean" } },
      required: ["created"],
    },
  },
  {
    name: "update_weekly_plan",
    description:
      "Escribe el plan de entrenamiento de la próxima semana. Archiva el plan anterior automáticamente.",
    input_schema: {
      type: "object" as const,
      properties: {
        content: {
          type: "string",
          description: "Contenido markdown completo del plan semanal.",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "create_garmin_workout",
    description:
      "Crea un entrenamiento estructurado en Garmin Connect y lo programa para la fecha indicada.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        sport: { type: "string", enum: ["running"], default: "running" },
        scheduledDate: { type: "string", description: "Fecha ISO YYYY-MM-DD" },
        steps: {
          type: "array",
          description:
            "Pasos: warmup/interval/recovery/cooldown/repeat. Targets: pace '3:50-4:00 /km', heart_rate '140-154 bpm'.",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["warmup", "interval", "recovery", "cooldown", "repeat"] },
              duration: { type: "string", description: "e.g. '10m', '90s'" },
              distance: { type: "string", description: "e.g. '1000m', '2km'" },
              target: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["pace", "heart_rate", "power", "open"] },
                  value: { type: "string" },
                },
                required: ["type"],
              },
              repeat: { type: "number" },
              steps: { type: "array", items: { type: "object" } },
            },
            required: ["type"],
          },
        },
      },
      required: ["name", "scheduledDate", "steps"],
    },
  },
];

async function runTool(
  athlete: Athlete,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "get_training_context":
      return await getTrainingContext(athlete);
    case "get_health_context":
      return await getHealthContext(athlete, (input.weeks as number) ?? 2);
    case "get_garmin_recent_activities":
      return JSON.stringify(
        await getGarminRecentActivities(athlete, (input.limit as number) ?? 14),
        null,
        2,
      );
    case "record_garmin_activity":
      return await recordGarminActivity(athlete, {
        id: input.activityId as number,
        name: input.name as string,
        type: input.type as string,
        date: input.date as string,
        durationSecs: input.durationSecs as number,
        distanceMeters: input.distanceMeters as number,
        avgHeartRate: input.avgHeartRate as number | null,
        avgPaceMinPerKm: input.avgPaceMinPerKm as number | null,
      });
    case "set_weekly_workouts_created":
      return await setWeeklyWorkoutsCreated(athlete, input.created as boolean);
    case "update_weekly_plan":
      return await updateWeeklyPlan(athlete, input.content as string);
    case "create_garmin_workout":
      return JSON.stringify(
        await createGarminWorkout(athlete, input as unknown as CreateWorkoutParams),
        null,
        2,
      );
    default:
      throw new Error(`Tool desconocida: ${name}`);
  }
}

async function reviewAthlete(athlete: Athlete): Promise<string> {
  const system = systemPrompt(athlete, await getCoachInstructions(athlete));
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: WEEKLY_REVIEW_PROMPT },
  ];

  let summary = "";

  for (let turn = 0; turn < 25; turn++) {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 8096,
      system,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const lastText = response.content.find((b) => b.type === "text");
      if (lastText && lastText.type === "text") summary = lastText.text;
      break;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      try {
        const result = await runTool(athlete, block.name, block.input as Record<string, unknown>);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      } catch (e) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Error ejecutando ${block.name}: ${e}`,
          is_error: true,
        });
      }
    }

    if (toolResults.length > 0) {
      messages.push({ role: "user", content: toolResults });
    }
  }

  return summary;
}

/** Revisión semanal de todos los atletas, o solo de ?athlete=<id>. */
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const only = new URL(req.url).searchParams.get("athlete");
  const athletes = listAthletes().filter((a) => !only || a.id === only);
  if (athletes.length === 0) return Response.json({ error: "Atleta no encontrado" }, { status: 404 });

  // En paralelo: el trabajo es casi todo espera de red, y así el tiempo total
  // es el del atleta más lento en vez de la suma.
  const settled = await Promise.allSettled(athletes.map(reviewAthlete));
  const results = Object.fromEntries(
    settled.map((r, i) => [
      athletes[i].id,
      r.status === "fulfilled" ? { ok: true, summary: r.value } : { ok: false, error: String(r.reason) },
    ]),
  );
  const success = settled.every((r) => r.status === "fulfilled");

  return Response.json({ success, results }, { status: success ? 200 : 207 });
}
