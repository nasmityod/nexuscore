# Despliegue del servidor de licencias en Vercel

Servidor de licencias profesional de Nexus Core: API serverless (Node ≥ 20) + Redis KV,
firma Ed25519 de tokens offline, panel de administración web y scripts CLI.

---

## 1. Estructura del proyecto (para Vercel)

```
license-server/
├── api/
│   ├── health.js                         GET  /api/health
│   ├── license/                          (sistema legado de códigos de venta NC-…)
│   │   ├── activate.js
│   │   └── generate.js
│   ├── licenses/                         ░ sistema profesional (license-key NXCS) ░
│   │   ├── activate.js                   POST /api/licenses/activate
│   │   ├── verify.js                     POST /api/licenses/verify
│   │   └── deactivate.js                 POST /api/licenses/deactivate
│   └── admin/
│       ├── codes/…                       (legado)
│       └── licenses/
│           ├── index.js                  GET  /api/admin/licenses
│           ├── create.js                 POST /api/admin/licenses/create
│           ├── trial.js                  POST /api/admin/licenses/trial
│           └── [key]/
│               ├── index.js              GET  /api/admin/licenses/:key
│               ├── status.js             PUT  /api/admin/licenses/:key/status
│               ├── extend.js             PUT  /api/admin/licenses/:key/extend
│               └── activations/[hwid].js DELETE /api/admin/licenses/:key/activations/:hwid
├── lib/                                  crypto, kv, validate, ratelimit, logger, licenses
├── public/admin/index.html               Panel de administración web  →  /admin
├── scripts/                              CLI: create / trial / list / revoke / suspend / extend / export
├── vercel.json
└── package.json
```

> Las rutas dinámicas `[key]` y `[hwid]` usan el enrutado por sistema de archivos de Vercel.
> Los parámetros llegan en `req.query.key` / `req.query.hwid`. Las rutas estáticas
> (`create`, `trial`, `index`) tienen prioridad sobre `[key]`, por lo que no colisionan.

---

## 2. `vercel.json`

Ya incluido. Define `maxDuration: 10s` para todas las funciones y cabeceras de seguridad
(`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, HSTS). No requiere `rewrites`:
el enrutado por archivos cubre todos los endpoints, y `public/admin/` se sirve en `/admin`.

---

## 3. Variables de entorno (Vercel → Project → Settings → Environment Variables)

| Variable | Obligatoria | Descripción |
|---|---|---|
| `NEXUS_LICENSE_PRIVATE_KEY` | **Sí** | Clave PRIVADA Ed25519 (PEM con `\n` literales). Generar con `scripts/generarClaves.js` (raíz del repo). Su pareja pública va embebida en el cliente. |
| `NEXUS_ADMIN_API_KEY` | **Sí** | Bearer para los endpoints `/api/admin/*` y el panel web. ≥ 40 chars aleatorios: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `NEXUS_CODE_SECRET` | **Sí** | Secreto HMAC para integridad de documentos en KV (independiente de la clave Ed25519). |
| `NEXUS_GRACE_PERIOD_DAYS` | No | Período de gracia offline del cliente (días). Default 7, máx 90. |
| `NEXUS_TRIAL_HOURS` | No | (Legado, sistema de códigos) horas de prueba. Default 24. |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | **Una de las dos** | Redis REST (Upstash / Vercel KV). **Recomendada.** |
| `KV_REDIS_URL` / `REDIS_URL` | Alternativa | Redis TCP (`redis://…`). No mezclar con REST. |

Configura las variables para **Production** (y Preview si lo usas). Tras cambiarlas, **redeploy**.

---

## 4. Base de datos: Redis KV (recomendado)

**Por qué Redis y no Postgres:** las funciones serverless sufren *cold starts* y un pool de
conexiones TCP a Postgres se agota con concurrencia. Redis vía REST (Upstash) es *stateless*
por request, sin pool, e ideal para este patrón. El universo de licencias de un distribuidor es
pequeño (cientos), perfectamente manejable con `SCAN`.

### Opción A — Upstash (Marketplace de Vercel)
1. Vercel Dashboard → **Storage** → **Create Database** → **Upstash for Redis**.
2. Conéctala al proyecto: Vercel inyecta `KV_REST_API_URL` y `KV_REST_API_TOKEN` automáticamente.
3. Listo — `lib/kv.js` las detecta.

### Opción B — Redis Cloud / otro (TCP)
1. Crea una instancia y copia su `redis://default:PASSWORD@host:port`.
2. Define `KV_REDIS_URL` con ese valor en Vercel.

### Verificación
`GET https://TU-PROYECTO.vercel.app/api/health` debe responder `{ ok: true, kv: "up", ... }`.

---

## 5. Desplegar

```bash
cd license-server
npm install            # instala @vercel/kv y redis
vercel                 # primer deploy (Preview) — vincula el proyecto
vercel --prod          # despliegue a Producción
```

(o conecta el repositorio en el Dashboard de Vercel y cada push a `main` despliega).

### Primer uso (crear la primera licencia)
```bash
# Desde license-server/ con las env del admin a mano:
$env:NEXUS_ADMIN_API_KEY="…"
$env:NEXUS_LICENSE_ADMIN_URL="https://TU-PROYECTO.vercel.app"
node scripts/create-license.js --type subscription --name "Cliente Demo" --days 365 --max 1
```
O abre el panel: `https://TU-PROYECTO.vercel.app/admin` e ingresa el `NEXUS_ADMIN_API_KEY`.

---

## 6. Apuntar el cliente Nexus Core al servidor

La URL del servidor es **configurable por entorno en el build de Electron** (no hardcodeada):

- Variable: **`NEXUS_LICENSE_SERVER_URL`** (p. ej. `https://tu-proyecto.vercel.app`).
- La lee `electron/main.js` (canal IPC `license:get-server-url`) y `electron/licenseManager.js`
  (`serverUrl()`), con fallback al deploy por defecto si no está definida.
- Defínela en el `.env` del build (cargado por `electron/main.js` con dotenv) y en
  `.env.example` (documentada en la rule de variables de entorno).

> La **clave pública Ed25519** embebida en el cliente
> (`electron/licenseManager.js` → `PUBLIC_KEY_PEM_DEFAULT` y `backend/services/licenciaService.js`)
> DEBE ser la pareja exacta de `NEXUS_LICENSE_PRIVATE_KEY` del servidor. Si la rotas, actualiza
> `NEXUS_LICENSE_PUBLIC_KEY` en el cliente (override por env) o recompila.

---

## 7. Rollback

- **Vía Dashboard:** Vercel → Deployments → elige el último deploy estable → **Promote to Production**
  (rollback instantáneo, sin downtime).
- **Vía CLI:** `vercel rollback` o `vercel promote <deployment-url>`.
- Como los datos viven en Redis (no en el código), un rollback del código **no** pierde licencias.
  Evita borrar/recrear la base Redis salvo que quieras vaciar todas las licencias.
- Si un cambio rompió el esquema de documentos, las licencias antiguas siguen leyéndose porque
  `getLicense` normaliza estructura y valida HMAC; revierte el código y vuelve a desplegar.

---

## 8. Comprobación de extremo a extremo

1. `GET /api/health` → `ok:true`.
2. Crear licencia (panel o CLI) → obtén `NXCS-XXXX-XXXX-XXXX-XXXX`.
3. En el cliente: pantalla de activación → ingresa la key → activa (escribe el archivo cifrado).
4. Reinicia el cliente sin internet → debe arrancar (verificación offline + período de gracia).
5. En el panel: suspende la licencia → en la próxima verificación online el cliente se bloquea.
6. `node scripts/list-licenses.js` → confirma estado/activaciones.
