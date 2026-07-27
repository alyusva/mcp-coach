"""
POST /api/garmin/delete_workout
Body: { "workoutId": 1645124286 }
Deletes the workout and unschedules it from the calendar.
"""
import json, os, sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _session import get_garmin_client, save_session  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            secret = self.headers.get("X-Internal-Secret", "")
            if secret != os.environ.get("INTERNAL_API_SECRET", ""):
                self._json({"error": "Forbidden"}, 403)
                return

            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}

            workout_id = body.get("workoutId")
            if not workout_id:
                self._json({"error": "workoutId is required"}, 400)
                return

            client = get_garmin_client()
            client.delete_workout(workout_id)
            save_session(client)

            self._json({"deleted": True, "workoutId": workout_id,
                        "message": f"Workout {workout_id} eliminado del calendario."})

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
        pass
