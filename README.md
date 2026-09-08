# mcp-coach

Servidor MCP personal que actúa como entrenador AI de running. Se conecta a Claude vía un conector MCP personalizado y persiste la memoria en un repo de memoria propio (ver más abajo). El autor original usa [mcp-coach-memory](https://github.com/alyusva/mcp-coach-memory) como ejemplo — ese repo es privado y contiene datos personales, pero puedes usarlo como **plantilla** para crear el tuyo.

## Arquitectura

```
Claude (conversación)
    └── Custom MCP connector (URL de producción + Bearer token)
            └── mcp-coach (Next.js en Vercel)
                    ├── 5 MCP tools (TypeScript, App Router)
                    ├── GitHub API → tu-repo-de-memoria (markdown commits)
                    └── /api/garmin/* (Python serverless)
                            └── Garmin Connect API
                                    └── Token de sesión en Upstash Redis
```

## Tools disponibles

| Tool | Descripción |
|------|-------------|
| `get_training_context` | Lee zonas, objetivos y plan semanal actual |
| `update_weekly_plan` | Escribe nuevo plan; archiva el anterior en `log/` |
| `append_training_log` | Añade entrada al log semanal (no sobrescribe) |
| `create_garmin_workout` | Crea y programa un workout estructurado en Garmin Connect |
| `get_garmin_recent_activities` | Últimas N actividades de Garmin (distancia, FC, ritmo) |

## Setup

### 1. Clonar e instalar

```bash
git clone https://github.com/alyusva/mcp-coach
cd mcp-coach
npm install
```

### 2. Crea tu propio repo de memoria

`mcp-coach` no trae memoria incluida: necesita un repo de GitHub aparte donde leer y escribir tu histórico de entrenamiento. Crea un repo **nuevo y privado** (p. ej. `tu-usuario/mi-coach-memory`) con esta estructura:

```
config/
  zonas.md          # Zonas de FC, ritmo y potencia
  objetivos.md      # Carrera objetivo, fase de periodización, notas de lesiones
plan/
  semana-actual.md  # Plan de la semana en curso (se sobrescribe cada semana)
log/
  .gitkeep          # Histórico semanal (se genera solo, YYYY-Www.md)
```

Puedes copiar el `README.md` de [mcp-coach-memory](https://github.com/alyusva/mcp-coach-memory) para ver el formato exacto de cada archivo, pero **no forkees ni copies su contenido** — son datos personales de otra persona. Rellena `zonas.md` y `objetivos.md` con tus propios datos.

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
| `MCP_AUTH_TOKEN` | Token secreto del servidor MCP |
| `INTERNAL_API_SECRET` | Secreto entre Node y Python (genera uno con `openssl rand -hex 32`) |
| `GARMIN_EMAIL` | Email de Garmin Connect |
| `GARMIN_PASSWORD` | Contraseña de Garmin Connect |
| `GITHUB_TOKEN` | Fine-grained PAT de GitHub (ver abajo) |
| `MEMORY_REPO` | `tu-usuario/mi-coach-memory` — **el repo que creaste en el paso 2**, no `alyusva/mcp-coach-memory` |
| `REDIS_URL` | URL de Upstash Redis |

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

Con esto, Claude tendrá acceso a las 5 tools en cualquier conversación donde estén habilitadas.

## Notas sobre el paquete MCP

Se usa `@vercel/mcp-adapter` (el adaptador oficial de Vercel para MCP).
El transport es Streamable HTTP. La ruta dinámica `app/[transport]/route.ts`
maneja tanto `/mcp` como `/sse` automáticamente.
