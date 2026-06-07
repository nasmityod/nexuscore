# Nexus Core · Panel de Administración de Licencias

Panel web profesional para gestionar **todas** las licencias de Nexus Core: crear,
ver clientes, equipos activos, tiempo restante, **pausar / reactivar / revocar** y
**sumar tiempo** — conectado en vivo con el servidor de licencias desplegado en Vercel.

Se despliega como su **propio proyecto en Vercel**, independiente del `license-server`.

---

## ¿Por qué este diseño? (seguridad)

A diferencia de un panel que mete la clave admin en el navegador, aquí el panel tiene su
propio **backend (BFF) serverless** que actúa de proxy:

```
Navegador ──cookie de sesión──▶  /api/* (este panel)  ──Bearer admin──▶  license-server (Vercel)
```

- Inicias sesión con una **contraseña de panel** → recibes una **cookie de sesión firmada**
  (HttpOnly, Secure, SameSite=Strict). El JS del navegador no puede leerla.
- La `NEXUS_ADMIN_API_KEY` del servidor de licencias vive **solo** en las variables de
  entorno del panel (lado servidor). **Nunca** llega al navegador.

---

## Estructura

```
administracion/
├── api/                              ░ BFF serverless (Vercel Functions) ░
│   ├── auth/
│   │   ├── login.js                  POST   /api/auth/login     (contraseña → cookie)
│   │   ├── logout.js                 POST   /api/auth/logout
│   │   └── session.js                GET    /api/auth/session
│   ├── health.js                     GET    /api/health         (ping al license-server)
│   ├── stats.js                      GET    /api/stats          (dashboard agregado)
│   └── licenses/
│       ├── index.js                  GET    /api/licenses
│       ├── create.js                 POST   /api/licenses/create
│       ├── trial.js                  POST   /api/licenses/trial
│       └── [key]/
│           ├── index.js              GET    /api/licenses/:key
│           ├── status.js             PUT    /api/licenses/:key/status     (pausar/reactivar/revocar)
│           ├── extend.js             PUT    /api/licenses/:key/extend      (sumar tiempo)
│           └── activations/[hwid].js DELETE /api/licenses/:key/activations/:hwid  (liberar equipo)
├── lib/                              respond · session (cookie HMAC) · upstream (proxy)
├── public/                          SPA (index.html + assets/css + assets/js)
├── vercel.json
├── package.json
├── .env.example
└── .gitignore
```

---

## Variables de entorno (Vercel → Settings → Environment Variables)

| Variable | Obligatoria | Descripción |
|---|---|---|
| `LICENSE_SERVER_URL` | Sí | URL del `license-server` en Vercel (sin barra final). Ej. `https://nexuscore-iota.vercel.app`. |
| `NEXUS_ADMIN_API_KEY` | Sí | La **misma** clave admin del `license-server`. Solo en el servidor del panel. |
| `ADMIN_PANEL_PASSWORD` | Sí | Contraseña para entrar al panel. |
| `PANEL_SESSION_SECRET` | Sí | Secreto HMAC para firmar la cookie de sesión (≥ 32 bytes hex). |
| `PANEL_SESSION_HOURS` | No | Duración de la sesión en horas (default 12, máx 168). |
| `PANEL_EXPIRING_SOON_DAYS` | No | Umbral "por vencer" del dashboard (default 30). |

Genera secretos:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # PANEL_SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"  # ADMIN_PANEL_PASSWORD
```

> `NEXUS_ADMIN_API_KEY` debe coincidir **exactamente** con la del `license-server`,
> o todas las llamadas devolverán 401.

---

## Desplegar

```bash
cd administracion
vercel            # primer deploy (Preview) — vincula el proyecto
vercel --prod     # producción
```

O conecta el repositorio en el Dashboard de Vercel y selecciona la carpeta
`administracion` como *Root Directory* del proyecto.

Después: abre la URL del panel → ingresa `ADMIN_PANEL_PASSWORD`.

### Probar en local

```bash
cd administracion
vercel dev        # requiere las variables en un archivo .env local (ver .env.example)
```

---

## Qué puedes hacer desde el panel

- **Panel:** KPIs (licencias, activas, suspendidas, vencidas/revocadas, clientes, equipos),
  "por vencer" y licencias recientes.
- **Licencias:** buscar/filtrar, crear (suscripción · permanente · prueba), ver detalle.
- **Detalle:** reactivar / **pausar** / revocar, **sumar tiempo**, liberar equipos, copiar la clave.
- **Clientes:** agrupados por correo/nombre con sus licencias.
- **Vencimientos:** ordenados por proximidad de vencimiento.
- **Servidor:** estado en vivo del `license-server` (versión, base de datos KV).
