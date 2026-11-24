"""
POST /api/garmin/reschedule_workout
Internal endpoint (protected by X-Internal-Secret).
Body: { "workoutId": 123, "fromDate": "2026-12-01", "toDate": "2026-12-03", "athlete": {...} }
Moves a scheduled workout to another day: schedules it on toDate and removes
the calendar entry on fromDate. The workout template itself is kept.
"""
import json
import os
import sys
from datetime import date
from http.server import BaseHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _session import get_garmin_client, save_session  # noqa: E402


def find_schedule_id(client, workout_id: int, on: date) -> int | None:
    # Garmin's calendar-service uses 0-indexed months (January=0)
    resp = client.connectapi(f"/calendar-service/year/{on.year}/month/{on.month - 1}")
    for item in (resp or {}).get("calendarItems", []):
        if (
            item.get("itemType") == "workout"
            and item.get("workoutId") == workout_id
            and item.get("date", "")[:10] == str(on)
        ):
            return item.get("id")
    return None


def unschedule(client, schedule_id: int) -> None:
    if hasattr(client, "unschedule_workout"):  # garminconnect >= 0.3
        client.unschedule_workout(schedule_id)
        return
    client.garth.request(  # garminconnect 0.2.x (garth)
        "DELETE", "connectapi", f"/workout-service/schedule/{schedule_id}", api=True
    )


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            secret = self.headers.get("X-Internal-Secret", "")
            if secret != os.environ.get("INTERNAL_API_SECRET", ""):
                self._json({"error": "Forbidden"}, 403)
                return

            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}

            workout_id = int(body.get("workoutId") or 0)
            from_date = date.fromisoformat(body.get("fromDate", ""))
            to_date = date.fromisoformat(body.get("toDate", ""))
            if workout_id <= 0:
                self._json({"error": "workoutId is required"}, 400)
                return

            client = get_garmin_client(body)
            schedule_id = find_schedule_id(client, workout_id, from_date)
            if schedule_id is None:
                save_session(client)
                self._json(
                    {"error": f"El workout {workout_id} no está programado el {from_date}"}, 404
                )
                return

            # Schedule first: if this fails the original entry is still there.
            client.schedule_workout(workout_id, str(to_date))
            unschedule(client, schedule_id)
            save_session(client)

            self._json({
                "workoutId": workout_id,
                "fromDate": str(from_date),
                "toDate": str(to_date),
                "message": f"Workout {workout_id} movido del {from_date} al {to_date}.",
            })

        except Exception as exc:
            self._json({"error": str(exc)}, 500)

    def _json(self, data: dict, status: int = 200):
        payload = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_):
        pass
