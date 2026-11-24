"""Guarda en Redis la sesión de Garmin de un atleta, sin guardar su contraseña.

Se ejecuta UNA vez por persona en tu ordenador (no en Vercel), con la persona
delante para que escriba su email, contraseña y, si lo pide, el código de
verificación de Garmin. Solo se guarda el token de sesión, cifrado con
GARMIN_SESSION_KEY y ligado a la clave de Redis de ese atleta.

Uso:
    pip install -r requirements.txt
    export REDIS_URL='rediss://default:...@....upstash.io:6379'
    export GARMIN_SESSION_KEY='...'   # el mismo valor que en Vercel
    python scripts/garmin_login.py --athlete mama

Si en ATHLETES le has puesto otra garminSessionKey, pásala con --session-key.
Para cortar el acceso más adelante: cerrar sesión en la cuenta de Garmin o
borrar la clave en Upstash.
"""
import argparse
import getpass
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api" / "garmin"))
from _session import _dump, store_session  # noqa: E402
from garminconnect import Garmin  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--athlete", required=True, help="id del atleta en ATHLETES (p. ej. mama)")
    parser.add_argument("--session-key", help="clave de Redis (por defecto garmin:session:<id>)")
    args = parser.parse_args()

    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,31}", args.athlete):
        sys.exit("id de atleta no válido")
    redis_key = args.session_key or f"garmin:session:{args.athlete}"
    for var in ("REDIS_URL", "GARMIN_SESSION_KEY"):
        if not os.environ.get(var):
            sys.exit(f"Falta la variable de entorno {var}")

    email = input("Email de Garmin Connect: ").strip()
    password = getpass.getpass("Contraseña (no se guarda): ")
    client = Garmin(email, password, prompt_mfa=lambda: input("Código de verificación de Garmin: ").strip())
    client.login()
    del password

    store_session(redis_key, _dump(client))
    name = client.get_full_name() if hasattr(client, "get_full_name") else email
    print(f"✓ Sesión de Garmin de {name} guardada (cifrada) en {redis_key}")


if __name__ == "__main__":
    main()
