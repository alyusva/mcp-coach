"""Garmin session management using garth + Upstash REST API.

Session strategy:
- Redis TTL: 30 days (Garmin refresh tokens last months)
- garth refreshes access tokens automatically on each API call
- We save the session back to Redis after every successful call
  so the refreshed access token gets persisted
- Full re-login is only needed if the refresh token is revoked
  (which requires deliberate action in Garmin account settings)
"""
import json
import os
import urllib.parse
import urllib.request

import garth
from garminconnect import Garmin

CACHE_KEY = "garmin:session"
SESSION_TTL = 60 * 60 * 24 * 30  # 30 days


def _upstash(command: list):
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


def _dump(client: Garmin) -> str:
    try:
        return client.garth.dumps()
    except AttributeError:
        return garth.client.dumps()


def _load(client: Garmin, data: str) -> None:
    try:
        client.garth.loads(data)
    except AttributeError:
        garth.loads(data)
        client.garth = garth.client  # type: ignore[attr-defined]


def save_session(client: Garmin) -> None:
    """Persist current session (call after every successful API use)."""
    _upstash(["SET", CACHE_KEY, _dump(client), "EX", SESSION_TTL])


def get_garmin_client() -> Garmin:
    client = Garmin(os.environ["GARMIN_EMAIL"], os.environ["GARMIN_PASSWORD"])

    cached = _upstash(["GET", CACHE_KEY])
    if cached:
        try:
            _load(client, cached)
            return client
        except Exception:
            pass

    # Fresh login — only if cache miss or tokens revoked
    client.login()
    save_session(client)
    return client
