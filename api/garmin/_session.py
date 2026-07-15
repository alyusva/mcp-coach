"""Garmin session management using garth directly + Upstash REST API."""
import json
import os
import urllib.parse
import urllib.request

import garth
from garminconnect import Garmin

CACHE_KEY = "garmin:session"
SESSION_TTL = 82800  # 23 hours


def _upstash(command: list):
    """Upstash Redis via REST API — works in any serverless environment."""
    parsed = urllib.parse.urlparse(os.environ["REDIS_URL"])
    url = f"https://{parsed.hostname}"
    token = parsed.password or ""
    req = urllib.request.Request(
        url,
        data=json.dumps(command).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=8) as resp:
        return json.loads(resp.read()).get("result")


def _dump_session(client: Garmin) -> str:
    """Serialize session — handles both old and new garminconnect versions."""
    try:
        return client.garth.dumps()
    except AttributeError:
        return garth.client.dumps()


def _load_session(client: Garmin, data: str) -> None:
    """Restore session into client."""
    try:
        client.garth.loads(data)
    except AttributeError:
        garth.loads(data)
        client.garth = garth.client  # type: ignore[attr-defined]


def get_garmin_client() -> Garmin:
    client = Garmin(os.environ["GARMIN_EMAIL"], os.environ["GARMIN_PASSWORD"])

    cached = _upstash(["GET", CACHE_KEY])
    if cached:
        try:
            _load_session(client, cached)
            return client
        except Exception:
            pass

    # Fresh login (only on cache miss)
    client.login()
    _upstash(["SET", CACHE_KEY, _dump_session(client), "EX", SESSION_TTL])
    return client
