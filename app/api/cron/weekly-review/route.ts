import Anthropic from "@anthropic-ai/sdk";
import {
  getTrainingContext,
  updateWeeklyPlan,
  appendTrainingLog,
} from "@/lib/github-memory";
import {
  createGarminWorkout,
  getGarminRecentActivities,
  type CreateWorkoutParams,
} from "@/lib/garmin-client";

export const maxDuration = 300;

const anthropic = new Anthropic();

const SYSTEM_PROMPT = `Eres el entrenador AI automatizado de Álvaro para su preparación de la Media Maratón de Valladolid (27 Sep 2026, objetivo sub-1:28).

Ejecutas cada lunes por la mañana. Tu misión en cada ejecución:
1. Leer el contexto completo: zonas, objetivos, plan global y plan de la semana que acaba de terminar.
2. Leer las actividades de Garmin de los últimos 14 días.
3. Registrar en el log cada sesión de running de la semana pasada — UNA entrada por sesión, sin repetir sesiones ya registradas.
4. Analizar qué se hizo vs qué estaba planificado. Si la tirada larga se saltó, notarlo explícitamente.
5. Generar el plan de la semana siguiente siguiendo ESTRICTAMENTE la estructura del plan global. Solo puedes desviar la sesión de calidad si hay fatiga severa o lesión — nunca por precaución genérica.
6. Escribir el plan con update_weekly_plan en formato markdown completo.
7. SOLO SI el plan global del contexto indica "workouts_created: false" para la semana siguiente: crear en Garmin UN workout por cada sesión de running (easy runs, Z2, calidad y tirada larga). Si ya indica "workouts_created: true", NO crear workouts (ya existen).

Reglas duras:
- SIEMPRE incluir la sesión de calidad que marque el plan global (series o umbral). No rebajarla a progresivo salvo fatiga explícita en los datos de Garmin.
- La tirada larga es innegociable.
- Rodajes fáciles: FC ≤ 154 bpm. Calidad: usar target pace según plan global.
- Calidad siempre de mañana (hasta mediados de septiembre).
- Responde siempre en español.`;

const WEEKLY_REVIEW_PROMPT = `Es lunes. Ejecuta la revisión semanal completa:

1. Llama a get_training_context. Fíjate en el campo "workouts_created" del plan de la semana siguiente para saber si ya tienes que crear workouts en Garmin o no.
2. Llama a get_garmin_recent_activities con limit=14.
3. Para cada sesión de running de la semana pasada (lunes a domingo anterior), añade UNA entrada al log con append_training_log. No repitas sesiones.
4. Determina qué semana del plan global corresponde a la próxima semana. Sigue el plan global AL PIE DE LA LETRA para la sesión de calidad (series o umbral) y la tirada larga. Solo ajusta el volumen de los easy runs.
5. Escribe el plan completo con update_weekly_plan. Incluye al final del plan: "workouts_created: false".
6. Si workouts_created era false (o no existía): crea en Garmin un workout por CADA sesión de running de la semana, sin excepción. Tras crearlos todos, actualiza el plan con update_weekly_plan cambiando "workouts_created: false" por "workouts_created: true".

Cuando termines, responde con un resumen: sesiones registradas, plan escrito, workouts creados (o saltados por ya existir).`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_training_context",
    description:
      "Lee las zonas de FC/ritmo/potencia, objetivos de temporada, plan global (9 semanas) y el plan de la semana actual.",
    input_schema: { type: "object" as const, properties: {} },
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
    name: "append_training_log",
    description:
      "Añade una entrada al log semanal. Llamar una vez por sesión de running registrada.",
    input_schema: {
      type: "object" as const,
      properties: {
        entry: {
          type: "string",
          description: "Texto markdown: fecha, tipo de sesión, distancia, FC media, ritmo, valoración breve.",
        },
      },
      required: ["entry"],
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
    case "get_garmin_recent_activities":
      return JSON.stringify(
        await getGarminRecentActivities((input.limit as number) ?? 14),
        null,
        2,
      );
    case "append_training_log":
      return await appendTrainingLog(input.entry as string);
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
      model: "claude-opus-4-7",
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
