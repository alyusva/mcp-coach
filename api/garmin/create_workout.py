"""
POST /api/garmin/create_workout
Internal endpoint (protected by X-Internal-Secret).
Builds a structured running workout and schedules it in Garmin Connect.
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

# Allow importing _session from the same package
sys.path.insert(0, str(Path(__file__).parent))
from _session import get_garmin_client, save_session  # noqa: E402


# ─── Workout builder helpers ────────────────────────────────────────────────

SPORT_TYPE = {"sportTypeId": 1, "sportTypeKey": "running"}

STEP_TYPE_MAP = {
    "warmup":   {"stepTypeId": 1, "stepTypeKey": "warmup"},
    "cooldown": {"stepTypeId": 2, "stepTypeKey": "cooldown"},
    "interval": {"stepTypeId": 3, "stepTypeKey": "interval"},
    "recovery": {"stepTypeId": 4, "stepTypeKey": "recovery"},
    "rest":     {"stepTypeId": 5, "stepTypeKey": "rest"},
    "other":    {"stepTypeId": 7, "stepTypeKey": "other"},
}

NO_TARGET = {
    "targetType": {"workoutTargetTypeId": 1, "workoutTargetTypeKey": "no.target"},
    "targetValueOne": None,
    "targetValueTwo": None,
}


def parse_pace_to_mps(pace_str: str) -> float:
    """'3:58 /km' → speed in m/s. Garmin pace.zone expects m/s and displays as pace."""
    pace = pace_str.replace("/km", "").replace("/mile", "").strip()
    parts = pace.split(":")
    total_secs = int(parts[0]) * 60 + (int(parts[1]) if len(parts) > 1 else 0)
    if "/mile" in pace_str:
        return 1609.34 / total_secs
    return 1000.0 / total_secs


def parse_duration_secs(s: str) -> int:
    s = s.strip()
    if s.endswith("h"):
        return int(s[:-1]) * 3600
    if s.endswith("m"):
        return int(s[:-1]) * 60
    if s.endswith("s"):
        return int(s[:-1])
    return int(s)


def parse_distance_meters(s: str) -> int:
    s = s.strip()
    if s.endswith("km"):
        return int(float(s[:-2]) * 1000)
    if s.endswith("m"):
        return int(s[:-1])
    return int(s)


def build_target(target: dict | None) -> dict:
    if not target or target.get("type") == "open":
        return NO_TARGET.copy()

    t = target.get("type")
    raw = (target.get("value") or "").strip()

    if t == "heart_rate":
        raw = raw.lower().replace("bpm", "").strip()
        if "-" in raw:
            lo, hi = raw.split("-", 1)
        else:
            lo = hi = raw
        return {
            "targetType": {"workoutTargetTypeId": 4, "workoutTargetTypeKey": "heart.rate.zone"},
            "targetValueOne": float(lo.strip()),
            "targetValueTwo": float(hi.strip()),
        }

    if t == "power":
        raw = raw.upper().replace("W", "").strip()
        if "-" in raw:
            lo, hi = raw.split("-", 1)
        else:
            lo = hi = raw
        return {
            "targetType": {"workoutTargetTypeId": 6, "workoutTargetTypeKey": "power.zone"},
            "targetValueOne": float(lo.strip()),
            "targetValueTwo": float(hi.strip()),
        }

    if t == "pace":
        unit = "/km" if "/km" in raw else "/mile" if "/mile" in raw else "/km"
        if "-" in raw.replace("/km", "").replace("/mile", ""):
            clean = raw.replace(unit, "").strip()
            parts = clean.split("-", 1)
            # Faster pace = higher m/s (e.g. 3:59 = 4.184 m/s), slower = lower (4:16 = 3.906 m/s)
            mps_a = parse_pace_to_mps(parts[0].strip() + " " + unit)
            mps_b = parse_pace_to_mps(parts[1].strip() + " " + unit)
            lo_speed = min(mps_a, mps_b)
            hi_speed = max(mps_a, mps_b)
        else:
            mps = parse_pace_to_mps(raw)
            lo_speed = mps * 0.97
            hi_speed = mps * 1.03
        return {
            "targetType": {"workoutTargetTypeId": 6, "workoutTargetTypeKey": "pace.zone"},
            "targetValueOne": hi_speed,  # faster m/s → displayed as faster pace (e.g. 3:59)
            "targetValueTwo": lo_speed,  # slower m/s → displayed as slower pace (e.g. 4:16)
        }

    return NO_TARGET.copy()


def build_step(step: dict, order: int) -> dict:
    step_type_key = step.get("type", "other")

    if step_type_key == "repeat":
        inner = [build_step(s, i + 1) for i, s in enumerate(step.get("steps") or [])]
        return {
            "type": "RepeatGroupDTO",
            "stepOrder": order,
            "numberOfIterations": int(step.get("repeat", 1)),
            "workoutSteps": inner,
        }

    step_type = STEP_TYPE_MAP.get(step_type_key, STEP_TYPE_MAP["other"])

    if step.get("distance"):
        end_cond = {"conditionTypeId": 3, "conditionTypeKey": "distance"}
        end_val = parse_distance_meters(step["distance"])
    elif step.get("duration"):
        end_cond = {"conditionTypeId": 2, "conditionTypeKey": "time"}
        end_val = parse_duration_secs(step["duration"])
    else:
        end_cond = {"conditionTypeId": 1, "conditionTypeKey": "lap.button"}
        end_val = None

    result: dict = {
        "type": "ExecutableStepDTO",
        "stepOrder": order,
        "stepType": step_type,
        "endCondition": end_cond,
    }
    if end_val is not None:
        result["endConditionValue"] = end_val
    result.update(build_target(step.get("target")))
    return result


def build_workout(name: str, steps: list[dict]) -> dict:
    built_steps = [build_step(s, i + 1) for i, s in enumerate(steps)]
    return {
        "workoutName": name,
        "description": "",
        "sportType": SPORT_TYPE,
        "workoutSegments": [
            {
                "segmentOrder": 1,
                "sportType": SPORT_TYPE,
                "workoutSteps": built_steps,
            }
        ],
    }


# ─── Vercel serverless handler ───────────────────────────────────────────────

class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            secret = self.headers.get("X-Internal-Secret", "")
            if secret != os.environ.get("INTERNAL_API_SECRET", ""):
                self._json({"error": "Forbidden"}, 403)
                return

            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}

            name = body.get("name", "Entreno")
            scheduled_date = body.get("scheduledDate", "")
            steps = body.get("steps", [])

            if not scheduled_date:
                self._json({"error": "scheduledDate is required"}, 400)
                return

            client = get_garmin_client()
            workout_data = build_workout(name, steps)
            result = client.upload_workout(workout_data)
            workout_id = result.get("workoutId") or result.get("detailId")

            if not workout_id:
                self._json({"error": "upload_workout returned no workoutId", "raw": result}, 500)
                return

            client.schedule_workout(workout_id, scheduled_date)
            save_session(client)  # persist any token refresh garth did automatically

            self._json({
                "workoutId": workout_id,
                "scheduledDate": scheduled_date,
                "message": f"Workout '{name}' creado y programado para {scheduled_date}.",
            })

        except Exception as exc:
            self._json({"error": str(exc)}, 500)

    def _json(self, data: dict, status: int = 200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass  # Suppress access log noise in Vercel
