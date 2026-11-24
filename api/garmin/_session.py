"""Garmin session management per athlete, using garth + Upstash REST API.

Session strategy:
- Each athlete has their own Redis key (e.g. ``garmin:session:mama``) chosen by
  the Node side from the athlete's MCP token, and sent here in ``body["athlete"]``.
  This endpoint trusts that identity only because the call carries
  INTERNAL_API_SECRET.
- Sessions are encrypted at rest with AES-GCM when GARMIN_SESSION_KEY is set;
  the Redis key name is bound as associated data, so a session copied to
  another athlete's key does not decrypt.
- Redis TTL: 30 days, refreshed on every successful call (garth refreshes the
  access token automatically and we save it back).
- Passwords are never stored. Only the athlete flagged ``envLogin`` may fall
  back to logging in with GARMIN_EMAIL/GARMIN_PASSWORD; everyone else gets
  their session from ``scripts/garmin_login.py``.
"""
import base64
import json
import os
import re
import urllib.parse
import urllib.request

try:
    import garth  # garminconnect < 0.3
except ImportError:  # pragma: no cover
    garth = None  # type: ignore[assignment]
from garminconnect import Garmin

LEGACY_KEY = "garmin:session"
SESSION_TTL = 60 * 60 * 24 * 30  # 30 days
_KEY_RE = re.compile(r"^garmin:session(:[a-z0-9-]+)?$")
_ENC_PREFIX = "enc:v1:"


class GarminSessionMissing(RuntimeError):
    pass


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


def _aes_key() -> bytes | None:
    raw = os.environ.get("GARMIN_SESSION_KEY")
    if not raw:
        return None
    key = base64.b64decode(raw)
    if len(key) != 32:
        raise RuntimeError("GARMIN_SESSION_KEY debe ser 32 bytes en base64")
    return key


def encrypt_session(data: str, redis_key: str) -> str:
    key = _aes_key()
    if key is None:
        return data
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    nonce = os.urandom(12)
    ct = AESGCM(key).encrypt(nonce, data.encode(), redis_key.encode())
    return _ENC_PREFIX + base64.b64encode(nonce + ct).decode()


def decrypt_session(stored: str, redis_key: str) -> str:
    if not stored.startswith(_ENC_PREFIX):
        return stored  # legacy plaintext; it gets re-encrypted on next save
    key = _aes_key()
    if key is None:
        raise RuntimeError("Sesión cifrada pero falta GARMIN_SESSION_KEY")
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    blob = base64.b64decode(stored[len(_ENC_PREFIX):])
    return AESGCM(key).decrypt(blob[:12], blob[12:], redis_key.encode()).decode()


def _is_v03(client: Garmin) -> bool:
    """garminconnect >= 0.3 no longer uses garth: tokens live in client.client."""
    inner = getattr(client, "client", None)
    return inner is not None and hasattr(inner, "dumps") and hasattr(inner, "loads")


def _dump(client: Garmin) -> str:
    if _is_v03(client):
        return client.client.dumps()  # type: ignore[attr-defined]
    try:
        return client.garth.dumps()
    except AttributeError:
        return garth.client.dumps()


def _load(client: Garmin, data: str) -> None:
    if _is_v03(client):
        # A JSON string as tokenstore loads the tokens and verifies the session.
        client.login(data)
        return
    try:
        client.garth.loads(data)
    except AttributeError:
        garth.loads(data)
        client.garth = garth.client  # type: ignore[attr-defined]


def _athlete(body: dict | None) -> tuple[str, str, bool]:
    athlete = (body or {}).get("athlete")
    if not isinstance(athlete, dict):
        raise RuntimeError("Falta el atleta en la petición interna")
    athlete_id = str(athlete.get("id", ""))
    redis_key = str(athlete.get("sessionKey", ""))
    if not _KEY_RE.match(redis_key):
        raise RuntimeError("Clave de sesión Garmin no válida")
    return athlete_id, redis_key, athlete.get("envLogin") is True


def store_session(redis_key: str, data: str) -> None:
    _upstash(["SET", redis_key, encrypt_session(data, redis_key), "EX", SESSION_TTL])


def save_session(client: Garmin) -> None:
    """Persist current session (call after every successful API use)."""
    store_session(client._coach_session_key, _dump(client))  # type: ignore[attr-defined]


def get_garmin_client(body: dict | None) -> Garmin:
    athlete_id, redis_key, env_login = _athlete(body)

    if env_login:
        client = Garmin(os.environ.get("GARMIN_EMAIL"), os.environ.get("GARMIN_PASSWORD"))
    else:
        client = Garmin()
    client._coach_session_key = redis_key  # type: ignore[attr-defined]

    cached = _upstash(["GET", redis_key])
    if cached:
        try:
            _load(client, decrypt_session(cached, redis_key))
            return client
        except Exception:
            pass

    if not env_login:
        raise GarminSessionMissing(
            f"No hay sesión de Garmin válida para '{athlete_id}'. "
            f"Ejecuta: python scripts/garmin_login.py --athlete {athlete_id}"
        )

    # Fresh login — only for the env-credential athlete, on cache miss or revoked tokens
    client.login()
    save_session(client)
    return client
