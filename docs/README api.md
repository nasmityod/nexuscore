# bcv-api

Microservicio que obtiene la **tasa oficial del dólar del BCV** ([bcv.org.ve](https://www.bcv.org.ve/)) y la expone como API REST en JSON, con **historial persistente**, **API Keys**, **calendario de feriados** editable, **logging estructurado**, **health checks** y **endurecimiento de seguridad**.

> Diseñado para un VPS de 1 GB de RAM: un único proceso Node.js + SQLite embebido (sin demonios de base de datos), detrás de nginx.

> **Guía para conectarte a las APIs (facturador, historial, feriados, ejemplos en curl/JS/PHP):** [GUIA-CONEXION-API.md](./GUIA-CONEXION-API.md)

---

## Tabla de contenidos

- [Arquitectura y decisiones](#arquitectura-y-decisiones)
- [Requisitos previos](#requisitos-previos)
- [Instalación rápida](#instalación-rápida)
- [Configuración (.env)](#configuración-env)
- [Endpoints](#endpoints)
- [Autenticación y scopes](#autenticación-y-scopes)
- [Gestión de API Keys (rotación)](#gestión-de-api-keys-rotación)
- [Gestión del calendario de feriados](#gestión-del-calendario-de-feriados)
- [CLI bcv-admin](#cli-bcv-admin)
- [Operación: PM2, nginx, backups](#operación-pm2-nginx-backups)
- [Observabilidad](#observabilidad)
- [Tests](#tests)
- [Estructura del proyecto](#estructura-del-proyecto)

---

## Arquitectura y decisiones

| Componente | Elección | Por qué |
|---|---|---|
| Runtime | **Node.js 20 LTS** | Continuidad con el código y la operación existentes; carga trivial. |
| Framework | **Fastify 4** | Ligero, rápido, validación JSON Schema y Pino integrados. |
| Base de datos | **SQLite (better-sqlite3, WAL)** | Cero proceso extra (clave en 1 GB), 1 archivo, rapidísimo para este patrón. |
| Scheduler | **node-cron** | In-process, sin servicios externos. |
| Seguridad | **helmet, rate-limit, cors, API Keys** | Headers, límites de abuso, control de acceso. |

**Principio central:** el _scraping_ se **desacopla del request**. Un job programado obtiene la tasa y la guarda; los endpoints sirven **siempre desde SQLite** (respuesta instantánea y resiliente a caídas del BCV). Patrón _stale-while-revalidate_: si la tasa parece de un día previo, se refresca en segundo plano sin bloquear ni romper la respuesta al facturador.

```
Facturador ── HTTPS ──> nginx ──> Fastify (127.0.0.1:3002) ──> SQLite
                                       ▲
                                   node-cron ── scraping ──> bcv.org.ve
```

---

## Requisitos previos

- **Node.js >= 20** y **npm**
- **PM2** (`npm install -g pm2`)
- **nginx** (reverse proxy / TLS)
- Build tools solo si `better-sqlite3` no encuentra binario precompilado (el instalador los añade automáticamente: `build-essential`, `python3`).

---

## Instalación rápida

```bash
cd /var/www/bcv-api
bash deploy/install.sh
```

El instalador es idempotente y realiza: verificación de Node, dependencias (`npm ci --omit=dev`), creación de `.env`, migraciones, seed de feriados 2026, creación de una **API Key admin inicial** (se imprime una sola vez), primer scraping y arranque con PM2.

> Guarda la API Key admin que imprime el instalador. No se puede recuperar después.

Verificación:

```bash
curl http://127.0.0.1:3002/health
curl http://127.0.0.1:3002/bcv-api
```

---

## Configuración (.env)

Copia `.env.example` a `.env`. Variables principales:

| Variable | Default | Descripción |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `3002` | Bind del servidor (solo localhost; nginx expone). |
| `LOG_LEVEL` | `info` | Nivel de Pino. |
| `DB_FILE` | `data/bcv.sqlite` | Ruta del archivo SQLite. |
| `BCV_TLS_STRICT` | `0` | `1` para verificar el certificado del BCV (puede fallar según el host). |
| `BCV_MAX_RETRIES` | `3` | Reintentos por scraping. |
| `SCHEDULER_ENABLED` | `1` | Activa los jobs de actualización. |
| `REFRESH_CRON` | `5 14-18 * * 1-5` | Refresco en franja de publicación (L-V, tarde, hora Caracas). |
| `SAFETY_CRON` | `0 9 * * *` | Red de seguridad diaria. |
| `STALE_AFTER_HOURS` | `24` | Umbral de "stale" para health. |
| `REQUIRE_KEY_FOR_RATE` | `0` | `1` exige API Key en `GET /bcv-api`. |
| `CORS_ORIGIN` | `*` | Orígenes permitidos. |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW` | `120` / `1 minute` | Rate limiting. |
| `TRUST_PROXY` | `1` | Confía en `X-Forwarded-For` (detrás de nginx). |

---

## Endpoints

### `GET /bcv-api` — contrato legado (compatibilidad garantizada)

Público por defecto (configurable con `REQUIRE_KEY_FOR_RATE=1`).

```bash
curl http://127.0.0.1:3002/bcv-api
```

```json
{
  "success": true,
  "bcv_dolar": 567.6828,
  "bcv_dolar_raw": "567,68280000",
  "fecha_valor": "Martes, 09 Junio 2026",
  "updated_at": "2026-06-09T12:34:56.789Z"
}
```

### `GET /v1/rate` — tasa actual enriquecida — _scope `rates:read`_

```bash
curl -H "X-API-Key: bcv_xxx" http://127.0.0.1:3002/v1/rate
```

```json
{
  "success": true,
  "data": {
    "rate": 567.6828,
    "rate_raw": "567,68280000",
    "fecha_valor": "Martes, 09 Junio 2026",
    "effective_date": "2026-06-09",
    "fetched_at": "2026-06-09T12:34:56.789Z",
    "stale": false,
    "age_hours": 2.5
  }
}
```

### `GET /v1/rates` — historial — _scope `rates:read`_

Query: `from`, `to` (`YYYY-MM-DD`, por `effective_date`), `limit` (1–1000).

```bash
curl -H "X-API-Key: bcv_xxx" "http://127.0.0.1:3002/v1/rates?from=2026-06-01&limit=50"
```

```json
{
  "success": true,
  "count": 2,
  "rates": [
    { "rate": 567.6828, "rate_raw": "567,68280000", "fecha_valor": "Martes, 09 Junio 2026", "effective_date": "2026-06-09", "fetched_at": "2026-06-09T12:34:56.789Z" }
  ]
}
```

### `GET /v1/holidays` — calendario — _scope `holidays:read`_

Query: `year` (opcional), `detailed=true` (objetos en vez de strings).

```bash
curl -H "X-API-Key: bcv_xxx" "http://127.0.0.1:3002/v1/holidays?year=2026"
```

```json
{
  "success": true,
  "year": 2026,
  "count": 21,
  "updated_at": "2026-06-06T20:00:00.000Z",
  "holidays": ["2026-01-01", "2026-01-12", "2026-01-19", "..."]
}
```

### `POST /v1/holidays` — agregar — _scope `holidays:write`_

```bash
curl -X POST -H "X-API-Key: bcv_xxx" -H "Content-Type: application/json" \
  -d '{"date":"2026-06-08","name":"Batalla de Carabobo"}' \
  http://127.0.0.1:3002/v1/holidays
```

```json
{ "success": true, "created": true, "date": "2026-06-08" }
```

### `PUT /v1/holidays` — reemplazo masivo — _scope `holidays:write`_

```bash
curl -X PUT -H "X-API-Key: bcv_xxx" -H "Content-Type: application/json" \
  -d '{"holidays":["2027-01-01","2027-05-01"]}' \
  http://127.0.0.1:3002/v1/holidays
```

### `DELETE /v1/holidays/:date` — eliminar — _scope `holidays:write`_

```bash
curl -X DELETE -H "X-API-Key: bcv_xxx" http://127.0.0.1:3002/v1/holidays/2026-06-08
```

### Endpoints admin — _scope `admin`_

- `GET /v1/admin/keys` — lista keys (sin secretos).
- `POST /v1/admin/keys` — crea key; devuelve el texto plano una vez.
- `DELETE /v1/admin/keys/:prefix` — revoca key.
- `POST /v1/admin/refresh` — fuerza un scraping inmediato.

```bash
curl -X POST -H "X-API-Key: bcv_admin" -H "Content-Type: application/json" \
  -d '{"name":"facturador","scopes":["rates:read","holidays:read"]}' \
  http://127.0.0.1:3002/v1/admin/keys
```

### Health

- `GET /health` — liveness (sin auth, sin rate limit).
- `GET /health/ready` — readiness real (DB + frescura de la tasa); `503` si está degradado.

---

## Autenticación y scopes

Las API Keys se envían en el header **`X-API-Key`**. Scopes disponibles:

| Scope | Permite |
|---|---|
| `rates:read` | `GET /v1/rate`, `GET /v1/rates` |
| `holidays:read` | `GET /v1/holidays` |
| `holidays:write` | `POST/PUT/DELETE` de feriados |
| `admin` | Todo, incluido `/v1/admin/*` |

En la base de datos **solo se guarda el hash SHA-256** de cada key; el texto plano se muestra una única vez al crearla.

---

## Gestión de API Keys (rotación)

Vía CLI (recomendada; las keys no viajan por la red):

```bash
# Crear una key para el facturador
node bin/bcv-admin.js keys:create --name "facturador" --scopes rates:read,holidays:read

# Listar
node bin/bcv-admin.js keys:list

# Revocar por prefix (aparece en keys:list)
node bin/bcv-admin.js keys:revoke bcv_AbCdEfGh
```

**Rotación recomendada:** crea la nueva key, actualiza el cliente, verifica tráfico con `keys:list` (columna `last_used`), y luego revoca la anterior. Hacer público `GET /bcv-api` o exigir key se controla con `REQUIRE_KEY_FOR_RATE` en `.env` (reinicia con `pm2 reload bcv-api`).

---

## Gestión del calendario de feriados

El facturador consume `GET /v1/holidays` y se actualiza solo. Para editar el calendario **sin tocar el cliente**:

```bash
# Ver
node bin/bcv-admin.js holidays:list --year 2026

# Agregar / eliminar
node bin/bcv-admin.js holidays:add 2026-06-08 --name "Batalla de Carabobo"
node bin/bcv-admin.js holidays:remove 2026-06-08

# Importar desde JSON (merge por defecto; --replace reemplaza todo)
echo '["2027-01-01","2027-05-01"]' > feriados-2027.json
node bin/bcv-admin.js holidays:import feriados-2027.json
node bin/bcv-admin.js holidays:import feriados-2027.json --replace
```

También disponible vía endpoints `POST/PUT/DELETE` con scope `holidays:write`.

---

## CLI bcv-admin

```text
DB:        db:migrate | db:seed | db:setup
Keys:      keys:create --name "X" [--scopes a,b] | keys:list | keys:revoke <prefix>
Feriados:  holidays:list [--year] | holidays:add <fecha> | holidays:remove <fecha> | holidays:import <file> [--replace]
Tasa:      rate:refresh | rate:latest
```

`npm run setup` equivale a `db:setup` (migraciones + seed + admin key inicial).

---

## Operación: PM2, nginx, backups

**PM2** (config en `ecosystem.config.cjs`, `max_memory_restart: 200M`):

```bash
pm2 start ecosystem.config.cjs   # o: pm2 startOrReload ecosystem.config.cjs
pm2 save
pm2 startup        # arrancar PM2 al boot del servidor (una vez)
pm2 logs bcv-api
```

**nginx**: ver `deploy/nginx.conf.example` (reverse proxy a `127.0.0.1:3002`, `X-Forwarded-For`, rate limit opcional). Configura TLS con certbot/Let's Encrypt.

**Integración en producción (dayzove.lat):** la API convive con la web (app en `:3001`) en el mismo dominio. En `/etc/nginx/sites-available/default`, dentro del `server { listen 443 }`:

```nginx
# Endpoint legado (contrato del facturador), en la raíz.
location = /bcv-api {
    proxy_pass http://127.0.0.1:3002;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
# Resto de la API bajo /bcv/ (la barra final elimina el prefijo).
# Evita colisiones con rutas de la web (p.ej. /health la usa la app en :3001).
location /bcv/ {
    proxy_pass http://127.0.0.1:3002/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

URLs públicas resultantes:

| Recurso | URL pública |
|---|---|
| Tasa (contrato, sin key) | `https://dayzove.lat/bcv-api` |
| Tasa enriquecida | `https://dayzove.lat/bcv/v1/rate` |
| Historial | `https://dayzove.lat/bcv/v1/rates` |
| Feriados | `https://dayzove.lat/bcv/v1/holidays` |
| Health / Ready | `https://dayzove.lat/bcv/health` · `/bcv/health/ready` |
| Admin | `https://dayzove.lat/bcv/v1/admin/...` |

Aplica con `nginx -t && systemctl reload nginx`.

**Backups** (respaldo en caliente de SQLite, con rotación):

```bash
bash deploy/backup.sh
# Cron diario:
# 30 3 * * * /usr/bin/bash /var/www/bcv-api/deploy/backup.sh >> /var/www/bcv-api/logs/backup.log 2>&1
```

---

## Observabilidad

- **Logging estructurado** con Pino (JSON en producción; `pino-pretty` en desarrollo). Se **redactan** `X-API-Key`, `authorization` y `cookie`.
- **Health**: `/health` (liveness) y `/health/ready` (DB + antigüedad de la tasa, `last_success_at`, `last_error`).
- Logs de PM2 en `logs/bcv-api.out.log` y `logs/bcv-api.error.log`.

---

## Tests

```bash
npm test
```

Tests deterministas (sin red) con `node:test`: parsing del scraper, utilidades de fecha, servicios (rates/holidays/keys sobre SQLite temporal) y rutas vía `app.inject` (incluido el contrato exacto de `/bcv-api` y el control de scopes).

---

## Estructura del proyecto

```
bcv-api/
├── bin/bcv-admin.js          # CLI de administración
├── deploy/
│   ├── install.sh            # despliegue Ubuntu (idempotente)
│   ├── backup.sh             # respaldo SQLite en caliente
│   └── nginx.conf.example    # reverse proxy
├── src/
│   ├── app.js                # factory Fastify (plugins, rutas, errores)
│   ├── server.js             # boot + graceful shutdown
│   ├── config/               # carga/validación de entorno
│   ├── db/                   # conexión, migraciones, seed
│   ├── plugins/              # security, rateLimit, auth
│   ├── routes/               # rate, holidays, health, admin
│   ├── services/             # bcvScraper, rate, holiday, apiKey, settings
│   ├── scheduler/            # jobs node-cron
│   └── utils/                # errors, hash, dates
├── test/                     # node:test
├── ecosystem.config.cjs      # PM2
└── .env.example
```
