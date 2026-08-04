"""
POST /api/garmin/activity_splits
Body: { "activityId": 23844659789 }
Returns per-lap detail (warmup/interval/recovery/cooldown) for one activity:
distance, duration, pace, FC, potencia y cadencia de cada vuelta/serie.
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _session import get_garmin_client, save_session  # noqa: E402

INTENSITY_MAP = {
    "WARMUP": "warmup",
    "ACTIVE": "active",
    "INTERVAL": "active",
    "RECOVERY": "recovery",
    "REST": "rest",
    "COOLDOWN": "cooldown",
}


def mps_to_min_per_km(mps: float | None) -> float | None:
    """m/s → min/km (minutes as float). None if no data."""
    if not mps or mps <= 0:
        return None
    return round(1000 / mps / 60, 2)


def normalize(lap: dict) -> dict:
    return {
        "lapIndex": lap.get("lapIndex"),
        "type": INTENSITY_MAP.get(lap.get("intensityType"), "other"),
        "distanceMeters": round(lap["distance"]) if lap.get("distance") is not None else None,
        "durationSecs": round(lap["duration"], 1) if lap.get("duration") is not None else None,
        "avgPaceMinPerKm": mps_to_min_per_km(lap.get("averageSpeed")),
        "avgHeartRate": lap.get("averageHR"),
        "maxHeartRate": lap.get("maxHR"),
        "avgPowerW": lap.get("averagePower"),
        "avgCadence": lap.get("averageRunCadence"),
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

            activity_id = body.get("activityId")
            if not activity_id:
                self._json({"error": "activityId is required"}, 400)
                return

            client = get_garmin_client()
            raw = client.get_activity_splits(activity_id)
            save_session(client)

            laps = [normalize(lap) for lap in (raw or {}).get("lapDTOs", [])]
            self._json({"activityId": activity_id, "laps": laps, "count": len(laps)})

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
