// Internal base URL: Vercel sets VERCEL_URL automatically (no protocol).
// For local dev, fall back to localhost.
function internalBase(): string {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

async function callGarminBackend<T>(endpoint: string, body: unknown): Promise<T> {
  const url = `${internalBase()}/api/garmin/${endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": process.env.INTERNAL_API_SECRET ?? "",
      // Bypass Vercel Deployment Protection for internal calls between serverless functions
      "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? "",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Garmin backend [${endpoint}] ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

export interface GarminStep {
  type: "warmup" | "interval" | "recovery" | "cooldown" | "repeat";
  duration?: string;
  distance?: string;
  target?: {
    type: "pace" | "heart_rate" | "power" | "open";
    value?: string;
  };
  repeat?: number;
  steps?: GarminStep[];
}

export interface CreateWorkoutParams {
  name: string;
  sport: "running";
  scheduledDate: string;
  steps: GarminStep[];
}

export interface CreateWorkoutResult {
  workoutId: number;
  scheduledDate: string;
  message: string;
}

export interface GarminActivity {
  id: number;
  name: string;
  type: string;
  date: string;
  durationSecs: number;
  distanceMeters: number;
  avgHeartRate: number | null;
  avgPaceMinPerKm: number | null;
}

export async function createGarminWorkout(params: CreateWorkoutParams): Promise<CreateWorkoutResult> {
  return callGarminBackend<CreateWorkoutResult>("create_workout", params);
}

export async function getGarminRecentActivities(limit: number): Promise<GarminActivity[]> {
  return callGarminBackend<GarminActivity[]>("recent_activities", { limit });
}
