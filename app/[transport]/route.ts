import { createMcpHandler, withMcpAuth } from "@vercel/mcp-adapter";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { athleteByToken, getAthlete, type Athlete } from "@/lib/athletes";
import {
  getTrainingContext,
  updateWeeklyPlan,
  setGoal,
  setAvailability,
  saveGlobalPlan,
  appendTrainingLog,
  getHealthContext,
  recordGarminActivity,
  setWeeklyWorkoutsCreated,
} from "@/lib/github-memory";
import {
  createGarminWorkout,
  getGarminRecentActivities,
  getGarminScheduledWorkouts,
  deleteGarminWorkout,
  getGarminActivitySplits,
} from "@/lib/garmin-client";

const GarminStepSchema: z.ZodType<object> = z.lazy(() =>
  z.object({
    type: z.enum(["warmup", "interval", "recovery", "cooldown", "repeat"]),
    duration: z.string().optional(),
    distance: z.string().optional(),
    target: z
      .object({
        type: z.enum(["pace", "heart_rate", "power", "open"]),
        value: z.string().optional(),
      })
      .optional(),
    repeat: z.number().optional(),
    steps: z.array(z.object({}).passthrough()).optional(),
  }),
);

/**
 * El atleta de cada llamada sale del token verificado (authInfo), nunca de los
 * argumentos de la tool: así nadie puede pedir los datos de otra persona.
 */
function athleteOf(extra: { authInfo?: AuthInfo }): Athlete {
  const id = extra.authInfo?.extra?.athleteId;
  const athlete = typeof id === "string" ? getAthlete(id) : undefined;
  if (!athlete) throw new Error("Petición sin atleta autenticado");
  return athlete;
}

const COACH_INSTRUCTIONS = `Eres el entrenador de running (o caminata) de la persona conectada. Empieza siempre con get_training_context.

Flujo:
1. Si falta el objetivo o la disponibilidad, pregúntalos antes de planificar: qué quiere conseguir y para cuándo, punto de partida, qué días y a qué hora puede entrenar normalmente, cuánto tiempo y qué día prefiere para la sesión larga. Resume lo entendido, pide confirmación y guárdalo con set_goal y set_availability.
2. Con objetivo y disponibilidad, propón un plan por bloques hasta el objetivo. Enséñalo, pregunta si encaja y ajusta lo que pida. Guárdalo con save_global_plan solo cuando lo apruebe.
3. Concreta la semana siguiente con update_weekly_plan, solo en los días disponibles, y crea los workouts en Garmin cuando el atleta lo confirme.
4. Si cambia algo (otro objetivo, otros días, molestias), ajusta y vuelve a guardar lo que corresponda. Nunca sobrescribas objetivo, disponibilidad o plan sin su visto bueno.

Respeta config/coach.md, que manda sobre estas pautas. Habla claro y en español.`;

const mcpHandler = createMcpHandler(
  (server) => {
    server.tool(
      "get_training_context",
      "Lee las zonas de FC/ritmo/potencia, objetivos de temporada y el plan de la semana actual desde el repo de memoria.",
      {},
      async (_args, extra) => {
        const context = await getTrainingContext(athleteOf(extra));
        return { content: [{ type: "text" as const, text: context }] };
      },
    );

    server.tool(
      "set_goal",
      "Guarda el objetivo del atleta (config/objetivos.md): qué quiere conseguir, para cuándo y su punto de partida. Sustituye el anterior (que queda archivado). Úsalo solo cuando el atleta haya confirmado el texto.",
      { content: z.string().describe("Markdown completo de objetivos") },
      async ({ content }, extra) => {
        const result = await setGoal(athleteOf(extra), content);
        return { content: [{ type: "text" as const, text: result }] };
      },
    );

    server.tool(
      "set_availability",
      "Guarda la disponibilidad habitual del atleta (config/disponibilidad.md): qué días puede entrenar, a qué hora, cuánto tiempo, día preferido para la sesión larga y días que nunca puede. Úsalo solo con la confirmación del atleta.",
      { content: z.string().describe("Markdown completo de disponibilidad") },
      async ({ content }, extra) => {
        const result = await setAvailability(athleteOf(extra), content);
        return { content: [{ type: "text" as const, text: result }] };
      },
    );

    server.tool(
      "save_global_plan",
      "Guarda el plan por bloques hasta el objetivo (plan/plan-global.md). Sustituye el anterior (que queda archivado). Enséñaselo antes al atleta y guárdalo solo cuando lo apruebe; vuelve a llamarlo con cada iteración aprobada.",
      { content: z.string().describe("Markdown completo del plan global") },
      async ({ content }, extra) => {
        const result = await saveGlobalPlan(athleteOf(extra), content);
        return { content: [{ type: "text" as const, text: result }] };
      },
    );

    server.tool(
      "update_weekly_plan",
      "Escribe el plan de entrenamiento semanal. Antes de sobreescribir, archiva el plan actual en el log histórico.",
      { content: z.string().describe("Contenido markdown completo del plan semanal") },
      async ({ content }, extra) => {
        const result = await updateWeeklyPlan(athleteOf(extra), content);
        return { content: [{ type: "text" as const, text: result }] };
      },
    );

    server.tool(
      "append_training_log",
      "Añade una nota interpretativa al log semanal actual. No usar para copiar métricas Garmin: usar record_garmin_activity.",
      { entry: z.string().describe("Texto markdown: sesión completada, RPE, notas") },
      async ({ entry }, extra) => {
        const result = await appendTrainingLog(athleteOf(extra), entry);
        return { content: [{ type: "text" as const, text: result }] };
      },
    );

    server.tool(
      "get_health_context",
      "Lee el histórico de salud (sueño, HRV nocturno, body battery, FC en reposo, estrés y training readiness) de las últimas N semanas, generado por el cron semanal de sincronización con Garmin Connect.",
      { weeks: z.number().int().min(1).max(8).default(2) },
      async ({ weeks }, extra) => {
        const context = await getHealthContext(athleteOf(extra), weeks);
        return { content: [{ type: "text" as const, text: context }] };
      },
    );

    server.tool(
      "record_garmin_activity",
      "Registra una actividad observada de Garmin de forma idempotente. Usa los campos exactamente como los devolvió get_garmin_recent_activities; impide duplicados mediante activityId.",
      {
        activityId: z.number().int(),
        name: z.string(),
        type: z.string(),
        date: z.string(),
        durationSecs: z.number().nonnegative(),
        distanceMeters: z.number().nonnegative(),
        avgHeartRate: z.number().nullable(),
        avgPaceMinPerKm: z.number().nullable(),
      },
      async ({ activityId, ...activity }, extra) => {
        const result = await recordGarminActivity(athleteOf(extra), { id: activityId, ...activity });
        return { content: [{ type: "text" as const, text: result }] };
      },
    );

    server.tool(
      "set_weekly_workouts_created",
      "Actualiza solo el estado de programación Garmin del plan actual, sin archivarlo de nuevo.",
      { created: z.boolean() },
      async ({ created }, extra) => {
        const result = await setWeeklyWorkoutsCreated(athleteOf(extra), created);
        return { content: [{ type: "text" as const, text: result }] };
      },
    );

    server.tool(
      "create_garmin_workout",
      "Crea un entrenamiento estructurado en Garmin Connect y lo programa para la fecha indicada.",
      {
        name: z.string(),
        sport: z.enum(["running"]).default("running"),
        scheduledDate: z.string().describe("Fecha ISO YYYY-MM-DD"),
        steps: z.array(GarminStepSchema).describe(
          "Pasos: warmup/interval/recovery/cooldown/repeat. " +
            "Targets: pace '3:50-4:00 /km', heart_rate '140-150 bpm', power '350-380 W'.",
        ),
      },
      async (params, extra) => {
        const result = await createGarminWorkout(
          athleteOf(extra),
          params as Parameters<typeof createGarminWorkout>[1],
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      "get_garmin_recent_activities",
      "Obtiene las últimas N actividades de Garmin Connect (fecha, tipo, distancia, FC media, ritmo medio).",
      { limit: z.number().int().min(1).max(30).default(7) },
      async ({ limit }, extra) => {
        const activities = await getGarminRecentActivities(athleteOf(extra), limit);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(activities, null, 2) }],
        };
      },
    );

    server.tool(
      "get_garmin_scheduled_workouts",
      "Lista los entrenamientos programados en Garmin Connect para un rango de fechas, con el detalle completo de cada bloque: tipo de paso, distancia/duración y objetivo de ritmo o FC.",
      {
        startDate: z.string().describe("Fecha inicio ISO YYYY-MM-DD"),
        endDate: z.string().describe("Fecha fin ISO YYYY-MM-DD"),
      },
      async ({ startDate, endDate }, extra) => {
        const workouts = await getGarminScheduledWorkouts(athleteOf(extra), startDate, endDate);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(workouts, null, 2) }],
        };
      },
    );

    server.tool(
      "delete_garmin_workout",
      "Elimina un entrenamiento de Garmin Connect por su ID, borrándolo también del calendario. Usar cuando haya duplicados o cuando haya que reemplazar un workout incorrecto.",
      {
        workoutId: z.number().int().describe("ID numérico del workout en Garmin Connect"),
      },
      async ({ workoutId }, extra) => {
        const result = await deleteGarminWorkout(athleteOf(extra), workoutId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    );

    server.tool(
      "get_garmin_activity_splits",
      "Obtiene el detalle por vuelta/serie de una actividad de Garmin Connect: tipo (calentamiento/activo/recuperación/enfriamiento), distancia, duración, ritmo, FC, potencia y cadencia de cada lap. Usar el activityId devuelto por get_garmin_recent_activities.",
      {
        activityId: z.number().int().describe("ID numérico de la actividad en Garmin Connect"),
      },
      async ({ activityId }, extra) => {
        const splits = await getGarminActivitySplits(athleteOf(extra), activityId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(splits, null, 2) }],
        };
      },
    );
  },
  { instructions: COACH_INSTRUCTIONS },
  { basePath: "/" },
);

async function verifyToken(_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;
  const athlete = athleteByToken(bearerToken);
  if (!athlete) return undefined;
  return { token: bearerToken, clientId: athlete.id, scopes: [], extra: { athleteId: athlete.id } };
}

const authedHandler = withMcpAuth(
  mcpHandler as (req: Request) => Promise<Response>,
  verifyToken,
  // required: sin esto, una petición sin token llega a las tools sin autenticar.
  { required: true, resourceUrl: "https://mcp-coach.vercel.app/mcp" },
);

export const GET = authedHandler;
export const POST = authedHandler;
