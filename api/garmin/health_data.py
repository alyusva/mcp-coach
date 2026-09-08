"""
POST /api/garmin/health_data
Body: { "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD" }
Internal endpoint (protected by X-Internal-Secret).

Devuelve, para cada día del rango (inclusive): sueño, HRV nocturno,
body battery, FC en reposo, estrés medio y training readiness.

Campos a None cuando el dato no existe para ese día (sensor no disponible,
día sin sincronizar con el reloj, etc.) — no se descarta el día, se
devuelve igualmente con los campos que sí haya.
"""
import json
import os
import sys
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _session import get_garmin_client, save_session  # noqa: E402


def daterange(start: str, end: str) -> list[str]:
    d0 = datetime.strptime(start, "%Y-%m-%d").date()
    d1 = datetime.strptime(end, "%Y-%m-%d").date()
    days = []
    d = d0
    while d <= d1:
        days.append(d.isoformat())
        d += timedelta(days=1)
    return days


def safe(fn, *args):
    """Llama a un método de garminconnect; None si falla o no hay dato ese día."""
    try:
        return fn(*args)
    except Exception:
        return None


def normalize_sleep(raw: dict | None) -> dict | None:
    if not raw:
        return None
    dto = raw.get("dailySleepDTO") or {}
    if not dto.get("sleepTimeSeconds"):
        return None
    overall = (dto.get("sleepScores") or {}).get("overall") or {}
    return {
        "scoreValue": overall.get("value"),
        "scoreQualifier": overall.get("qualifierKey"),
        "totalSleepSeconds": dto.get("sleepTimeSeconds"),
        "deepSeconds": dto.get("deepSleepSeconds"),
        "lightSeconds": dto.get("lightSleepSeconds"),
        "remSeconds": dto.get("remSleepSeconds"),
        "awakeSeconds": dto.get("awakeSleepSeconds"),
    }


def normalize_hrv(raw: dict | None) -> dict | None:
    if not raw:
        return None
    summary = raw.get("hrvSummary") or {}
    if summary.get("lastNightAvg") is None:
        return None
    return {
        "lastNightAvg": summary.get("lastNightAvg"),
        "status": summary.get("status"),
    }


def normalize_stress(raw: dict | None) -> dict | None:
    if not raw:
        return None
    avg = raw.get("avgStressLevel")
    if avg is None or avg < 0:
        return None
    return {"avgLevel": avg, "maxLevel": raw.get("maxStressLevel")}


def normalize_readiness(raw) -> dict | None:
    if not raw:
        return None
    item = raw[0] if isinstance(raw, list) else raw
    if not item:
        return None
    return {"score": item.get("score"), "level": item.get("level")}


def normalize_rhr(raw: dict | None) -> int | None:
    if not raw:
        return None
    try:
        arr = raw["allMetrics"]["metricsMap"]["WELLNESS_RESTING_HEART_RATE"]
        return arr[0]["value"] if arr else None
    except (KeyError, IndexError, TypeError):
        return None


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            secret = self.headers.get("X-Internal-Secret", "")
            if secret != os.environ.get("INTERNAL_API_SECRET", ""):
                self._json({"error": "Forbidden"}, 403)
                return

            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            start_date = body.get("startDate")
            end_date = body.get("endDate")
            if not start_date or not end_date:
                self._json({"error": "startDate and endDate are required"}, 400)
                return

            client = get_garmin_client()

            # Body Battery se pide de una vez para todo el rango
            battery_raw = safe(client.get_body_battery, start_date, end_date)
            battery_by_date = {}
            for entry in (battery_raw or []):
                d = entry.get("date")
                if d:
                    battery_by_date[d] = entry

            days = []
            for day in daterange(start_date, end_date):
                battery_entry = battery_by_date.get(day)
                body_battery = None
                if battery_entry:
                    body_battery = {
                        "charged": battery_entry.get("charged"),
                        "drained": battery_entry.get("drained"),
                    }

                days.append({
                    "date": day,
                    "sleep": normalize_sleep(safe(client.get_sleep_data, day)),
                    "hrv": normalize_hrv(safe(client.get_hrv_data, day)),
                    "bodyBattery": body_battery,
                    "restingHeartRate": normalize_rhr(safe(client.get_rhr_day, day)),
                    "stress": normalize_stress(safe(client.get_stress_data, day)),
                    "trainingReadiness": normalize_readiness(safe(client.get_training_readiness, day)),
                })

            save_session(client)  # persist any token refresh garth did automatically
            self._json(days)

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
