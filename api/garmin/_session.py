"""Shared Garmin session management via Redis."""
import json
import os
import redis
from garminconnect import Garmin

CACHE_KEY = "garmin:session"
SESSION_TTL = 82800  # 23 hours (Garmin tokens last ~24h)


def get_redis() -> redis.Redis:
    url = os.environ.get("REDIS_URL", "")
    if not url:
        raise RuntimeError("REDIS_URL environment variable is not set")
    return redis.from_url(url, decode_responses=True)


def get_garmin_client() -> Garmin:
    r = get_redis()
    email = os.environ["GARMIN_EMAIL"]
    password = os.environ["GARMIN_PASSWORD"]

    client = Garmin(email, password)

    cached = r.get(CACHE_KEY)
    if cached:
        try:
            client.garth.loads(cached)
            # Quick validation — raises if session is expired
            client.get_full_name()
            return client
        except Exception:
            pass  # Fall through to re-authenticate

    client.login()
    r.setex(CACHE_KEY, SESSION_TTL, client.garth.dumps())
    return client
