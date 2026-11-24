# mcp-coach

Servidor MCP que actúa como entrenador AI de running, para una persona o para varias (cada una con su token, su memoria y su Garmin). Se conecta a Claude vía un conector MCP personalizado y persiste la memoria en un repo de memoria propio (ver más abajo). El autor original usa [mcp-coach-memory](https://github.com/alyusva/mcp-coach-memory) como ejemplo — ese repo es privado y contiene datos personales, pero puedes usarlo como **plantilla** para crear el tuyo.

## Arquitectura

```
Claude (conversación)
    └── Custom MCP connector (URL de producción + Bearer token)
            └── mcp-coach (Next.js en Vercel)
                    ├── 6 MCP tools (TypeScript, App Router)
                    ├── GitHub API → tu-repo-de-memoria (markdown commits)
                    ├── /api/garmin/* (Python serverless)
                    │       └── Garmin Connect API
                    │               └── Token de sesión en Upstash Redis
                    └── Crons (Vercel)
                            ├── health-sync (domingos, 1h antes de weekly-review)
                            │       sincroniza sueño/HRV/body battery/estrés/training readiness
                            └── weekly-review (domingos)
                                    revisa la semana, escribe el plan siguiente y crea workouts
```

## Tools disponibles

| Tool | Descripción |
|------|-------------|
| `get_training_context` | Lee zonas, objetivos y plan semanal actual |
| `update_weekly_plan` | Escribe nuevo plan; archiva el anterior en `log/` |
| `append_training_log` | Añade entrada al log semanal (no sobrescribe) |
| `get_health_context` | Lee el histórico de salud (sueño, HRV, body battery, FC reposo, estrés, training readiness) de las últimas N semanas |
| `create_garmin_workout` | Crea y programa un workout estructurado en Garmin Connect |
| `get_garmin_recent_activities` | Últimas N actividades de Garmin (distancia, FC, ritmo) |

Los datos de salud no se recogen bajo demanda: los sincroniza automáticamente el cron `health-sync` cada domingo (ver abajo). `get_health_context` solo lee lo que ese cron ya haya escrito en `health/YYYY-Www.md`.

## Setup

### 1. Clonar e instalar

```bash
git clone https://github.com/alyusva/mcp-coach
cd mcp-coach
npm install
```

### 2. Crea tu propio repo de memoria

`mcp-coach` no trae memoria incluida: necesita un repo de GitHub aparte donde leer y escribir tu histórico de entrenamiento y salud. Crea un repo **nuevo y privado** (p. ej. `tu-usuario/mi-coach-memory`) con esta estructura:

```
config/
  zonas.md          # Zonas de FC, ritmo y potencia
  objetivos.md      # Carrera objetivo, fase de periodización, notas de lesiones
plan/
  semana-actual.md  # Plan de la semana en curso (se sobrescribe cada semana)
log/
  .gitkeep          # Histórico semanal de entrenos (se genera solo, YYYY-Www.md)
health/
  .gitkeep          # Histórico semanal de salud (se genera solo, YYYY-Www.md)
```

Puedes copiar el `README.md` de [mcp-coach-memory](https://github.com/alyusva/mcp-coach-memory) para ver el formato exacto de cada archivo, pero **no forkees ni copies su contenido** — son datos personales de otra persona. Rellena `zonas.md` y `objetivos.md` con tus propios datos. También tienes una plantilla lista en `templates/memory/`.

### 3. Variables de entorno locales

```bash
cp .env.example .env.local
# edita .env.local con tus valores reales
```

### 4. Desarrollo local

```bash
npm run dev
# servidor en http://localhost:3000
```

Para probar el endpoint MCP:
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer <MCP_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### 5. Deploy en Vercel

Importa el repo desde el dashboard de Vercel (Import Project → selecciona `mcp-coach`).

**Variables de entorno que debes añadir en el dashboard:**

| Variable | Descripción |
|----------|-------------|
| `ATHLETES` | Lista JSON de atletas (ver "Varios atletas"). Si no está, se usa el modo de un solo atleta con las variables de abajo |
| `MCP_AUTH_TOKEN` | Token secreto del servidor MCP (modo un solo atleta) |
| `AUTHORIZE_PIN` | PIN que pide `/authorize` al conectar Claude (modo un solo atleta) |
| `OAUTH_SIGNING_SECRET` | Firma de los códigos OAuth (si falta se usa `INTERNAL_API_SECRET`) |
| `GARMIN_SESSION_KEY` | Clave AES-256 en base64 para cifrar las sesiones de Garmin en Redis |
| `INTERNAL_API_SECRET` | Secreto entre Node y Python (genera uno con `openssl rand -hex 32`) |
| `GARMIN_EMAIL` | Email de Garmin Connect |
| `GARMIN_PASSWORD` | Contraseña de Garmin Connect |
| `GITHUB_TOKEN` | Fine-grained PAT de GitHub (ver abajo) |
| `MEMORY_REPO` | `tu-usuario/mi-coach-memory` — **el repo que creaste en el paso 2**, no `alyusva/mcp-coach-memory` |
| `REDIS_URL` | URL de Upstash Redis |

Los crons (`health-sync` y `weekly-review`) usan las mismas variables — no hay configuración adicional.

### 6. GitHub Token (Fine-grained PAT)

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. **Repository access**: solo tu repo de memoria (el del paso 2)
3. **Permissions → Contents**: Read and write
4. Copia el token y ponlo en `GITHUB_TOKEN`

### 7. Upstash Redis

1. Crea una base de datos gratuita en [upstash.com](https://upstash.com)
2. Copia la **REST URL** o la **Redis URL** (`rediss://default:...`)
3. Ponla en `REDIS_URL`

### 8. Conector MCP en Claude

Una vez desplegado en Vercel:

1. Claude → Settings → Integrations → Add custom MCP server
2. **Name**: `mcp-coach`
3. **URL**: `https://<tu-proyecto>.vercel.app/mcp`
   (o la URL de producción de tu proyecto)
4. **Headers**: `Authorization: Bearer <tu-MCP_AUTH_TOKEN>`

Con esto, Claude tendrá acceso a las tools en cualquier conversación donde estén habilitadas.

## Varios atletas

Un mismo despliegue puede servir a varias personas. El atleta de cada llamada lo
decide **el token del conector**, nunca un parámetro de las tools, así que el
Claude de una persona no puede leer ni tocar los datos de otra.

### 1. Repo de memoria por persona

Crea un repo **privado** por atleta y copia dentro `templates/memory/`. Rellena
`config/coach.md` (tono, reglas y precauciones de salud), `config/objetivos.md`
y, si se conocen, `config/zonas.md`. Añade el repo al fine-grained PAT de
`GITHUB_TOKEN` (Contents: read and write).

### 2. Variable `ATHLETES`

```json
[
  {"id": "alvaro", "name": "Álvaro", "token": "<openssl rand -hex 32>", "pin": "<pin largo>",
   "memoryRepo": "usuario/mcp-coach-memory", "garminSessionKey": "garmin:session", "garminEnvLogin": true},
  {"id": "mama", "name": "Mamá", "token": "<otro token>", "pin": "<otro pin>",
   "memoryRepo": "usuario/coach-memory-mama"}
]
```

- `garminSessionKey: "garmin:session"` y `garminEnvLogin: true` mantienen la sesión
  y el login automático del despliegue de un solo atleta. Solo un atleta puede
  tener `garminEnvLogin`.
- Los demás usan `garmin:session:<id>` y nunca guardan contraseña.
- Tokens y PINs no pueden repetirse. Usa PINs largos: hay un límite de 5 intentos
  fallidos por IP cada 15 minutos, pero un PIN de 6 cifras sigue siendo adivinable.

### 3. Sesión de Garmin de cada persona

En tu ordenador, con la persona delante:

```bash
pip install -r requirements.txt
export REDIS_URL='...' GARMIN_SESSION_KEY='...'   # los mismos que en Vercel
python scripts/garmin_login.py --athlete mama
```

Pide email, contraseña y el código de verificación si Garmin lo envía. Solo se
guarda la sesión, cifrada y ligada a su clave de Redis. Se renueva sola con el uso
(los crons la usan cada semana). Si caduca o se revoca, se repite el comando. Para
cortar el acceso: cerrar sesión en Garmin o borrar la clave en Upstash.

### 4. Conector en el Claude de cada persona

Cada persona, en su cuenta de Claude: Ajustes → Conectores → Añadir conector
personalizado, con la URL `https://<tu-proyecto>.vercel.app/mcp`. Al conectar se
abre la página de autorizar, escribe su PIN y queda enlazada a su memoria y su
Garmin. Recomendable crear un proyecto de Claude con instrucciones breves ("eres mi
entrenador, usa el conector mcp-coach para ver mis datos y mi plan").

### 5. Crons

`health-sync` y `weekly-review` recorren todos los atletas en paralelo. Para
relanzar uno solo: `curl -H "Authorization: Bearer $CRON_SECRET" "https://<host>/api/cron/weekly-review?athlete=mama"`.
El prompt de la revisión semanal es común y se completa con `config/coach.md` de
cada persona.

## Notas sobre el paquete MCP

Se usa `@vercel/mcp-adapter` (el adaptador oficial de Vercel para MCP).
El transport es Streamable HTTP. La ruta dinámica `app/[transport]/route.ts`
maneja tanto `/mcp` como `/sse` automáticamente.

## Notas sobre `health_data.py`

Los nombres de campo de la API no oficial de Garmin (`sleepScores`, `hrvSummary`, `WELLNESS_RESTING_HEART_RATE`, etc.) pueden variar entre versiones de `garminconnect` o entre modelos de reloj. Antes de confiar en el cron `health-sync` en producción, ejecútalo una vez manualmente (`curl` al endpoint con el `CRON_SECRET`) y revisa que `health/YYYY-Www.md` se rellena con datos reales, no solo con `—`.
