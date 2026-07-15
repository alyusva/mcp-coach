import { createMcpHandler } from "@vercel/mcp-adapter";
import { z } from "zod";
import {
  getTrainingContext,
  updateWeeklyPlan,
  appendTrainingLog,
} from "@/lib/github-memory";
import {
  createGarminWorkout,
  getGarminRecentActivities,
} from "@/lib/garmin-client";

// Bearer token auth middleware — wraps any Next.js route handler.
// Replace with withMcpAuth from @vercel/mcp-adapter if/when you want
// a more structured auth callback with typed auth info.
function requireBearer(handler: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    const auth = req.headers.get("Authorization") ?? "";
    const expected = `Bearer ${process.env.MCP_AUTH_TOKEN}`;
    if (!process.env.MCP_AUTH_TOKEN || auth !== expected) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return handler(req);
  };
}

const GarminStepSchema: z.ZodType<object> = z.lazy(() =>
  z.object({
    type: z.enum(["warmup", "interval", "recovery", "cooldown", "repeat"]),
    duration: z.string().optional().describe("Duración: '10m', '90s', '1h'"),
    distance: z.string().optional().describe("Distancia: '1km', '400m'"),
    target: z
      .object({
        type: z.enum(["pace", "heart_rate", "power", "open"]),
        value: z
          .string()
          .optional()
          .describe(
            "Valor o rango: '3:50-4:00 /km' | '140-150 bpm' | '350-380 W'",
          ),
      })
      .optional(),
    repeat: z
      .number()
      .optional()
      .describe("Solo para tipo 'repeat': número de repeticiones"),
    steps: z
      .array(z.object({}).passthrough())
      .optional()
      .describe("Solo para tipo 'repeat': pasos internos"),
  }),
);

const mcpHandler = createMcpHandler(
  (server) => {
    // ── Tool 1: Leer contexto completo de entrenamiento ─────────────────────
    server.tool(
      "get_training_context",
      "Lee las zonas de FC/ritmo/potencia, objetivos de temporada y el plan de la semana actual desde el repo de memoria.",
      {},
      async () => {
        const context = await getTrainingContext();
        return { content: [{ type: "text" as const, text: context }] };
      },
    );

    // ── Tool 2: Escribir plan semanal ────────────────────────────────────────
    server.tool(
      "update_weekly_plan",
      "Escribe el plan de entrenamiento semanal. Antes de sobreescribir, archiva el plan actual en el log histórico (log/YYYY-Www.md).",
      {
        content: z
          .string()
          .describe("Contenido markdown completo del plan semanal"),
      },
      async ({ content }) => {
        const result = await updateWeeklyPlan(content);
        return { content: [{ type: "text" as const, text: result }] };
      },
    );

    // ── Tool 3: Añadir entrada al log semanal ───────────────────────────────
    server.tool(
      "append_training_log",
      "Añade una entrada (con fecha automática) al log semanal actual. No sobrescribe — solo append.",
      {
        entry: z
          .string()
          .describe("Texto markdown de la entrada: sesión completada, RPE, notas"),
      },
      async ({ entry }) => {
        const result = await appendTrainingLog(entry);
        return { content: [{ type: "text" as const, text: result }] };
      },
    );

    // ── Tool 4: Crear y programar workout en Garmin ─────────────────────────
    server.tool(
      "create_garmin_workout",
      "Crea un entrenamiento estructurado en Garmin Connect y lo programa para la fecha indicada. Devuelve el workoutId y confirmación.",
      {
        name: z.string().describe("Nombre del workout en Garmin Connect"),
        sport: z.enum(["running"]).default("running"),
        scheduledDate: z
          .string()
          .describe("Fecha ISO YYYY-MM-DD para programar el workout"),
        steps: z.array(GarminStepSchema).describe(
          "Pasos del entrenamiento. Tipos: warmup, interval, recovery, cooldown, repeat. " +
            "Para repeat: incluye 'repeat' (nº reps) y 'steps' (array de pasos internos). " +
            "Targets: pace '3:50-4:00 /km', heart_rate '140-150 bpm', power '350-380 W', open.",
        ),
      },
      async (params) => {
        const result = await createGarminWorkout(params as Parameters<typeof createGarminWorkout>[0]);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
    );

    // ── Tool 5: Últimas actividades de Garmin ──────────────────────────────
    server.tool(
      "get_garmin_recent_activities",
      "Obtiene las últimas N actividades de Garmin Connect (fecha, tipo, distancia, FC media, ritmo medio) como contexto de entrenamiento reciente.",
      {
        limit: z
          .number()
          .int()
          .min(1)
          .max(30)
          .default(7)
          .describe("Número de actividades a recuperar (1-30, por defecto 7)"),
      },
      async ({ limit }) => {
        const activities = await getGarminRecentActivities(limit);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(activities, null, 2),
            },
          ],
        };
      },
    );
  },
  {},
  { basePath: "/" },
);

const authedHandler = requireBearer(mcpHandler as (req: Request) => Promise<Response>);

export const GET = authedHandler;
export const POST = authedHandler;
