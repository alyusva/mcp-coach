import Anthropic from "@anthropic-ai/sdk";
import {
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

const SYSTEM_PROMPT = `Eres el entrenador AI automatizado de Álvaro para su preparación de la Media Maratón de Valladolid (27 Sep 2026, objetivo sub-1:28).

Ejecutas cada lunes por la mañana, justo después de que un cron independiente (health-sync) haya sincronizado los datos de salud de la semana que acaba de terminar (sueño, HRV, body battery, FC en reposo, estrés, training readiness) en el repo de memoria. Tu misión en cada ejecución:
1. Leer el contexto completo: zonas, objetivos, plan global y plan de la semana que acaba de terminar (get_training_context), y el contexto de salud de las últimas 2 semanas (get_health_context).
2. Leer las actividades de Garmin de los últimos 14 días.
3. Registrar exclusivamente los datos observados de cada sesión de running de la semana pasada. No inventes, infieras ni completes métricas ausentes.
4. Analizar qué se hizo vs qué estaba planificado, separando "hechos observados" de "interpretación". Si la tirada larga no aparece en Garmin, di "no observada"; nunca "no realizada". Cruza la evidencia con salud: HRV bajo, sueño pobre repetido o Training Readiness bajo sostenido cuentan como fatiga severa.
5. Generar el plan de la semana siguiente siguiendo ESTRICTAMENTE la estructura del plan global. Solo puedes desviar la sesión de calidad si hay fatiga severa demostrada o lesión.
6. Escribir el plan con update_weekly_plan en formato markdown completo.
7. SOLO SI el plan actual indica "workouts_created: false": crear en Garmin UN workout por cada sesión de running (easy runs, Z2, calidad y tirada larga). Si ya indica "workouts_created: true", NO crear workouts (ya existen).

Reglas duras:
- SIEMPRE incluir la sesión de calidad que marque el plan global (series o umbral). No rebajarla a progresivo salvo fatiga explícita (log de sensaciones o datos de salud).
- La tirada larga es innegociable.
- Rodajes fáciles: FC ≤ 154 bpm. Calidad: usar target pace según plan global.
- Calidad siempre de mañana (hasta mediados de septiembre).
- Responde siempre en español.
- Una predicción o diagnóstico nunca es un hecho: etiqueta explícitamente su incertidumbre.`;

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

async function runTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "get_training_context":
      return await getTrainingContext();
    case "get_health_context":
      return await getHealthContext((input.weeks as number) ?? 2);
    case "get_garmin_recent_activities":
      return JSON.stringify(
        await getGarminRecentActivities((input.limit as number) ?? 14),
        null,
        2,
      );
    case "record_garmin_activity":
      return await recordGarminActivity({
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
      return await setWeeklyWorkoutsCreated(input.created as boolean);
    case "update_weekly_plan":
      return await updateWeeklyPlan(input.content as string);
    case "create_garmin_workout":
      return JSON.stringify(
        await createGarminWorkout(input as unknown as CreateWorkoutParams),
        null,
        2,
      );
    default:
      throw new Error(`Tool desconocida: ${name}`);
  }
}

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: WEEKLY_REVIEW_PROMPT },
  ];

  let summary = "";

  for (let turn = 0; turn < 25; turn++) {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 8096,
      system: SYSTEM_PROMPT,
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
        const result = await runTool(block.name, block.input as Record<string, unknown>);
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

  return Response.json({ success: true, summary });
}
