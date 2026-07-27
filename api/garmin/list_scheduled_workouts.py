"""
POST /api/garmin/list_scheduled_workouts
Body: { "startDate": "2026-08-03", "endDate": "2026-08-09" }
Returns workouts scheduled in that range with full step details.
"""
import json, sys
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _session import get_garmin_client, save_session  # noqa: E402


def mps_to_pace(mps: float) -> str:
    if not mps or mps <= 0:
        return "—"
    secs_per_km = 1000.0 / mps
    m, s = divmod(int(secs_per_km), 60)
    return f"{m}:{s:02d}/km"


def parse_target(step: dict) -> str:
    target_key = (step.get("targetType") or {}).get("workoutTargetTypeKey", "no.target")
    v1 = step.get("targetValueOne")
    v2 = step.get("targetValueTwo")

    if target_key == "no.target" or target_key is None:
        return "open"
    if target_key == "pace.zone":
        # v1 = faster m/s, v2 = slower m/s
        faster = mps_to_pace(v1) if v1 else "—"
        slower = mps_to_pace(v2) if v2 else "—"
        return f"ritmo {faster}–{slower}"
    if target_key == "heart.rate.zone":
        lo = int(v2) if v2 else "—"
        hi = int(v1) if v1 else "—"
        return f"FC {lo}–{hi} bpm"
    if target_key == "power.zone":
        return f"potencia {int(v2 or 0)}–{int(v1 or 0)} W"
    return target_key


def parse_end_condition(step: dict) -> str:
    cond_key = (step.get("endCondition") or {}).get("conditionTypeKey", "lap.button")
    val = step.get("endConditionValue")
    if cond_key == "distance" and val:
        km = val / 1000.0
        return f"{km:.1f}km" if km != int(km) else f"{int(km)}km"
    if cond_key == "time" and val:
        mins, secs = divmod(int(val), 60)
        return f"{mins}min" if secs == 0 else f"{mins}min {secs}s"
    return "lap button"


def parse_step(step: dict) -> dict:
    if step.get("type") == "RepeatGroupDTO":
        return {
            "type": "repeat",
            "repeat": step.get("numberOfIterations", 1),
            "steps": [parse_step(s) for s in step.get("workoutSteps", [])],
        }
    return {
        "type": (step.get("stepType") or {}).get("stepTypeKey", "other"),
        "duration_or_distance": parse_end_condition(step),
        "target": parse_target(step),
    }


def get_calendar_workouts(client, start: date, end: date) -> list[dict]:
    """Fetch calendar items for all months covering start→end, filter by date range."""
    months_needed = set()
    d = start
    while d <= end:
        months_needed.add((d.year, d.month))
        d = (d.replace(day=28) + timedelta(days=4)).replace(day=1)

    items_by_id: dict[int, dict] = {}
    for year, month in months_needed:
        resp = client.connectapi(f"/calendar-service/year/{year}/month/{month}")
        for item in (resp or {}).get("calendarItems", []):
            if item.get("itemType") != "workout":
                continue
            item_date = item.get("date", "")[:10]
            if not (str(start) <= item_date <= str(end)):
                continue
            wid = item.get("workoutId")
            if wid and wid not in items_by_id:
                items_by_id[wid] = {"scheduledDate": item_date, "title": item.get("title", "")}

    results = []
    for wid, meta in items_by_id.items():
        detail = client.connectapi(f"/workout-service/workout/{wid}") or {}
        segments = detail.get("workoutSegments", [])
        raw_steps = segments[0].get("workoutSteps", []) if segments else []
        results.append({
            "workoutId": wid,
            "name": detail.get("workoutName", meta["title"]),
            "sport": (detail.get("sportType") or {}).get("sportTypeKey", "running"),
            "scheduledDate": meta["scheduledDate"],
            "steps": [parse_step(s) for s in raw_steps],
        })

    results.sort(key=lambda x: x["scheduledDate"])
    return results


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            import os
            secret = self.headers.get("X-Internal-Secret", "")
            if secret != os.environ.get("INTERNAL_API_SECRET", ""):
                self._json({"error": "Forbidden"}, 403)
                return

            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}

            start_date = date.fromisoformat(body.get("startDate", str(date.today())))
            end_date = date.fromisoformat(body.get("endDate", str(date.today() + timedelta(days=7))))

            client = get_garmin_client()
            workouts = get_calendar_workouts(client, start_date, end_date)
            save_session(client)

            self._json({"workouts": workouts, "count": len(workouts)})

        except Exception as exc:
            self._json({"error": str(exc)}, 500)

    def _json(self, data: dict, status: int = 200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass
