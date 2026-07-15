import { createMcpHandler, withMcpAuth } from "@vercel/mcp-adapter";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
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

const mcpHandler = createMcpHandler(
  (server) => {
    server.tool(
      "get_training_context",
      "Lee las zonas de FC/ritmo/potencia, objetivos de temporada y el plan de la semana actual desde el repo de memoria.",
      {},
      async () => {
        const context = await getTrainingContext();
        return { content: [{ type: "text" as const, text: context }] };
      },
    );

    server.tool(
      "update_weekly_plan",
      "Escribe el plan de entrenamiento semanal. Antes de sobreescribir, archiva el plan actual en el log histórico.",
      { content: z.string().describe("Contenido markdown completo del plan semanal") },
      async ({ content }) => {
        const result = await updateWeeklyPlan(content);
        return { content: [{ type: "text" as const, text: result }] };
      },
    );

    server.tool(
      "append_training_log",
      "Añade una entrada (con fecha automática) al log semanal actual. No sobrescribe — solo append.",
      { entry: z.string().describe("Texto markdown: sesión completada, RPE, notas") },
      async ({ entry }) => {
        const result = await appendTrainingLog(entry);
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
      async (params) => {
        const result = await createGarminWorkout(
          params as Parameters<typeof createGarminWorkout>[0],
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      "get_garmin_recent_activities",
      "Obtiene las últimas N actividades de Garmin Connect (fecha, tipo, distancia, FC media, ritmo medio).",
      { limit: z.number().int().min(1).max(30).default(7) },
      async ({ limit }) => {
        const activities = await getGarminRecentActivities(limit);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(activities, null, 2) }],
        };
      },
    );
  },
  {},
  { basePath: "/" },
);

async function verifyToken(_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
  if (bearerToken && bearerToken === process.env.MCP_AUTH_TOKEN) {
    return { token: bearerToken, clientId: "claude", scopes: [] };
  }
  return undefined;
}

const authedHandler = withMcpAuth(
  mcpHandler as (req: Request) => Promise<Response>,
  verifyToken,
  { resourceUrl: "https://mcp-coach.vercel.app/mcp" },
);

export const GET = authedHandler;
export const POST = authedHandler;
