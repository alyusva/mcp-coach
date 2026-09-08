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

export interface WorkoutStep {
  type: string;
  duration_or_distance?: string;
  target?: string;
  repeat?: number;
  steps?: WorkoutStep[];
}

export interface ScheduledWorkout {
  workoutId: number;
  name: string;
  sport: string;
  scheduledDate: string;
  steps: WorkoutStep[];
}

export interface DeleteWorkoutResult {
  deleted: boolean;
  workoutId: number;
  message: string;
}

export interface ActivityLap {
  lapIndex: number;
  type: "warmup" | "active" | "recovery" | "rest" | "cooldown" | "other";
  distanceMeters: number | null;
  durationSecs: number | null;
  avgPaceMinPerKm: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  avgPowerW: number | null;
  avgCadence: number | null;
}

export interface ActivitySplits {
  activityId: number;
  laps: ActivityLap[];
  count: number;
}

export interface DailySleep {
  scoreValue: number | null;
  scoreQualifier: string | null;
  totalSleepSeconds: number | null;
  deepSeconds: number | null;
  lightSeconds: number | null;
  remSeconds: number | null;
  awakeSeconds: number | null;
}

export interface DailyHrv {
  lastNightAvg: number | null;
  status: string | null;
}

export interface DailyBodyBattery {
  charged: number | null;
  drained: number | null;
}

export interface DailyStress {
  avgLevel: number | null;
  maxLevel: number | null;
}

export interface DailyTrainingReadiness {
  score: number | null;
  level: string | null;
}

export interface DailyHealth {
  date: string;
  sleep: DailySleep | null;
  hrv: DailyHrv | null;
  bodyBattery: DailyBodyBattery | null;
  restingHeartRate: number | null;
  stress: DailyStress | null;
  trainingReadiness: DailyTrainingReadiness | null;
}

export async function createGarminWorkout(params: CreateWorkoutParams): Promise<CreateWorkoutResult> {
  return callGarminBackend<CreateWorkoutResult>("create_workout", params);
}

export async function getGarminRecentActivities(limit: number): Promise<GarminActivity[]> {
  return callGarminBackend<GarminActivity[]>("recent_activities", { limit });
}

export async function getGarminScheduledWorkouts(startDate: string, endDate: string): Promise<ScheduledWorkout[]> {
  const result = await callGarminBackend<{ workouts: ScheduledWorkout[]; count: number }>(
    "list_scheduled_workouts",
    { startDate, endDate },
  );
  return result.workouts;
}

export async function deleteGarminWorkout(workoutId: number): Promise<DeleteWorkoutResult> {
  return callGarminBackend<DeleteWorkoutResult>("delete_workout", { workoutId });
}

export async function getGarminActivitySplits(activityId: number): Promise<ActivitySplits> {
  return callGarminBackend<ActivitySplits>("activity_splits", { activityId });
}

export async function getGarminHealthData(startDate: string, endDate: string): Promise<DailyHealth[]> {
  return callGarminBackend<DailyHealth[]>("health_data", { startDate, endDate });
}
