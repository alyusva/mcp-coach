"""
POST /api/garmin/recent_activities
Internal endpoint (protected by X-Internal-Secret).
Returns the last N activities from Garmin Connect in a normalized format.
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _session import get_garmin_client, save_session  # noqa: E402


def mps_to_min_per_km(mps: float | None) -> float | None:
    """m/s → min/km (minutes as float). None if no data."""
    if not mps or mps <= 0:
        return None
    return round(1000 / mps / 60, 2)


def normalize(activity: dict) -> dict:
    avg_speed = activity.get("averageSpeed")  # m/s
    return {
        "id": activity.get("activityId"),
        "name": activity.get("activityName"),
        "type": (activity.get("activityType") or {}).get("typeKey"),
        "date": activity.get("startTimeLocal"),
        "durationSecs": activity.get("duration"),
        "distanceMeters": activity.get("distance"),
        "avgHeartRate": activity.get("averageHR"),
        "avgPaceMinPerKm": mps_to_min_per_km(avg_speed),
    }


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            secret = self.headers.get("X-Internal-Secret", "")
            if secret != os.environ.get("INTERNAL_API_SECRET", ""):
                self._json({"error": "Forbidden"}, 403)
                return

            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            limit = min(int(body.get("limit", 7)), 30)

            client = get_garmin_client()
            raw = client.get_activities(0, limit)
            save_session(client)  # persist any token refresh garth did automatically
            activities = [normalize(a) for a in (raw or [])]

            self._json(activities)

        except Exception as exc:
            self._json({"error": str(exc)}, 500)

    def _json(self, data, status: int = 200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass
