# Guía completa de conexión a las APIs de bcv-api

Documento de referencia para conectar **cualquier software** (facturador, web, app móvil, scripts) o **configurar integraciones con IA** a las APIs del BCV en producción.

---

## Contexto de producción (para IA / configuración automática)

Usa este bloque tal cual al pedirle a otra IA que configure tu facturador, ERP, script o cliente HTTP.

```yaml
# --- Entorno en producción (VPS dayzove.lat) ---
proyecto: bcv-api
version_api: "2.0.0"
descripcion: >
  API REST que expone la tasa oficial del dólar del BCV (Venezuela),
  historial de tasas y calendario de feriados. Respuestas JSON.

# Dominio público (HTTPS obligatorio en producción)
dominio_principal: dayzove.lat
dominio_alternativo: www.dayzove.lat   # redirige a HTTPS en dayzove.lat
protocolo: https
puerto_publico: 443                    # NO usar :3002 desde internet

# URLs base (copiar exactamente)
base_url_web: https://dayzove.lat
base_url_api_publica: https://dayzove.lat/bcv-api      # tasa del día, sin prefijo /bcv/
base_url_api_v1: https://dayzove.lat/bcv/v1            # historial, feriados, admin
base_url_health: https://dayzove.lat/bcv/health

# Autenticación
auth_tipo: api_key
auth_header: X-API-Key
auth_header_ejemplo: "X-API-Key: bcv_REEMPLAZAR_CON_TU_CLAVE"
auth_formato_key: "bcv_" + 32 caracteres aprox (base64url)

# Endpoints que NO requieren API Key
endpoints_publicos:
  - method: GET
    url: https://dayzove.lat/bcv-api
    uso: Tasa del dólar BCV (contrato legacy para facturación)
  - method: GET
    url: https://dayzove.lat/bcv/health
    uso: Liveness del servicio
  - method: GET
    url: https://dayzove.lat/bcv/health/ready
    uso: Estado real (DB + frescura de la tasa)

# Endpoints que SÍ requieren API Key (header X-API-Key)
endpoints_protegidos:
  - method: GET
    url: https://dayzove.lat/bcv/v1/rate
    scope: rates:read
  - method: GET
    url: https://dayzove.lat/bcv/v1/rates
    scope: rates:read
    query_ejemplo: "?from=2026-06-01&to=2026-06-09&limit=100"
  - method: GET
    url: https://dayzove.lat/bcv/v1/holidays
    scope: holidays:read
    query_ejemplo: "?year=2026"
  - method: POST
    url: https://dayzove.lat/bcv/v1/holidays
    scope: holidays:write
  - method: PUT
    url: https://dayzove.lat/bcv/v1/holidays
    scope: holidays:write
  - method: DELETE
    url: https://dayzove.lat/bcv/v1/holidays/{YYYY-MM-DD}
    scope: holidays:write
  - method: GET
    url: https://dayzove.lat/bcv/v1/admin/keys
    scope: admin

# Contrato mínimo facturación (NO cambiar nombres de campos)
contrato_facturacion:
  endpoint: GET https://dayzove.lat/bcv-api
  campos_respuesta:
    success: boolean
    bcv_dolar: number      # usar este para cálculos
    bcv_dolar_raw: string
    fecha_valor: string
    updated_at: string     # ISO 8601

# Errores JSON estándar
error_formato:
  success: false
  error: "mensaje"

# Notas para quien configura el cliente
notas:
  - "No llamar http://127.0.0.1:3002 desde fuera del servidor; solo dayzove.lat por HTTPS."
  - "El prefijo /bcv/ en nginx se elimina al reenviar; /bcv/v1/rate -> backend /v1/rate."
  - "/bcv-api está en la raíz del dominio, sin /bcv/ delante."
  - "Content-Type en POST/PUT: application/json."
  - "Fechas siempre YYYY-MM-DD."
  - "Rate limit aproximado: 120 req/min por IP o por API Key."
```

### URLs exactas listas para pegar

| Uso | URL completa |
|-----|----------------|
| **Tasa del día (facturador)** | `https://dayzove.lat/bcv-api` |
| Tasa enriquecida | `https://dayzove.lat/bcv/v1/rate` |
| Historial de tasas | `https://dayzove.lat/bcv/v1/rates` |
| Feriados Venezuela | `https://dayzove.lat/bcv/v1/holidays?year=2026` |
| Health | `https://dayzove.lat/bcv/health` |
| Web calculadora (NO es la API) | `https://dayzove.lat/` |

### Prompt sugerido para otra IA

Copia y pega esto (sustituye `TU_API_KEY` si necesitas historial o feriados):

```text
Configura mi software para conectarse a esta API en producción:

- Dominio: https://dayzove.lat
- Tasa BCV (público, sin auth): GET https://dayzove.lat/bcv-api
  Respuesta: { success, bcv_dolar, bcv_dolar_raw, fecha_valor, updated_at }
  Usar bcv_dolar (float) para conversiones.

- Historial (requiere auth): GET https://dayzove.lat/bcv/v1/rates?limit=100
  Header: X-API-Key: TU_API_KEY
  Scope necesario: rates:read

- Feriados (requiere auth): GET https://dayzove.lat/bcv/v1/holidays?year=2026
  Header: X-API-Key: TU_API_KEY
  Scope necesario: holidays:read

- Solo HTTPS. No usar puerto 3002.
- Errores: { success: false, error: "..." }
```

### Ejemplo mínimo de integración (referencia)

```javascript
// Tasa del día — sin API Key
const BASE = 'https://dayzove.lat';
const res = await fetch(`${BASE}/bcv-api`);
const { bcv_dolar, fecha_valor, updated_at } = await res.json();

// Historial — con API Key
const hist = await fetch(`${BASE}/bcv/v1/rates?limit=30`, {
  headers: { 'X-API-Key': process.env.BCV_API_KEY },
});
const { rates } = await hist.json();
```

---

## 1. URLs base (importante leer esto primero)

Tu API está publicada en el mismo dominio que la web, pero con rutas distintas:

| Tipo | URL base | ¿Para qué? |
|------|----------|------------|
| **Tasa del día (contrato clásico)** | `https://dayzove.lat/bcv-api` | Facturación, calculadoras, uso simple |
| **Resto de la API** | `https://dayzove.lat/bcv/` | Historial, feriados, admin, health |

nginx reenvía internamente al microservicio en `127.0.0.1:3002`. **No necesitas abrir el puerto 3002** desde fuera del servidor.

### Cómo se traducen las rutas

El prefijo `/bcv/` se quita al reenviar:

| Lo que tú llamas (público) | Lo que ejecuta el servidor |
|----------------------------|----------------------------|
| `https://dayzove.lat/bcv-api` | `/bcv-api` |
| `https://dayzove.lat/bcv/v1/rate` | `/v1/rate` |
| `https://dayzove.lat/bcv/v1/rates` | `/v1/rates` |
| `https://dayzove.lat/bcv/v1/holidays` | `/v1/holidays` |
| `https://dayzove.lat/bcv/health` | `/health` |

> **Excepción:** `/bcv-api` va en la **raíz** del dominio (sin `/bcv/`), para no romper software antiguo.

---

## 2. Cómo funciona por dentro (en 30 segundos)

1. Un proceso interno (scheduler) visita [bcv.org.ve](https://www.bcv.org.ve/) varias veces al día y **guarda la tasa** en una base de datos SQLite.
2. Cuando tú llamas la API, **no esperas al BCV**: recibes la última tasa guardada al instante.
3. Si la tasa parece de un día anterior, el servidor intenta actualizar **en segundo plano** sin bloquearte ni devolver error.

Por eso `/bcv-api` responde rápido y es estable.

---

## 3. Autenticación (API Keys)

### ¿Cuándo necesitas clave?

| Endpoint | ¿Necesita API Key? |
|----------|-------------------|
| `GET /bcv-api` | **No** (público por defecto) |
| `GET /bcv/health` | **No** |
| `GET /bcv/health/ready` | **No** |
| Todo lo demás (`/bcv/v1/...`) | **Sí** |

### Cómo enviar la clave

Siempre en el **header HTTP**:

```http
X-API-Key: bcv_tu_clave_completa_aqui
```

Ejemplo con curl:

```bash
curl -H "X-API-Key: bcv_xxxxxxxx" "https://dayzove.lat/bcv/v1/rate"
```

### Scopes (permisos)

Cada clave tiene permisos. Solo puedes usar endpoints para los que tengas scope:

| Scope | Permite |
|-------|---------|
| `rates:read` | Tasa enriquecida + historial |
| `holidays:read` | Consultar feriados |
| `holidays:write` | Crear, editar o borrar feriados |
| `admin` | Todo lo anterior + gestión de keys y refresh manual |

Una clave con scope `admin` puede entrar a **cualquier** endpoint.

### Crear tu primera clave (en el servidor por SSH)

```bash
cd /var/www/bcv-api

# Para facturador (tasa + feriados, solo lectura)
node bin/bcv-admin.js keys:create \
  --name "mi-facturador" \
  --scopes rates:read,holidays:read

# Para administración total
node bin/bcv-admin.js keys:create \
  --name "admin" \
  --scopes admin
```

La clave completa (`bcv_...`) se muestra **una sola vez**. Guárdala en un lugar seguro.

Listar claves (sin mostrar el secreto):

```bash
node bin/bcv-admin.js keys:list
```

Revocar una clave:

```bash
node bin/bcv-admin.js keys:revoke bcv_AbCdEfGh
```

(`bcv_AbCdEfGh` es el **prefix** que ves en `keys:list`.)

---

## 4. Formato general de respuestas

### Éxito

Casi siempre incluye `"success": true`.

### Error

```json
{
  "success": false,
  "error": "Descripción del problema"
}
```

### Códigos HTTP habituales

| Código | Significado |
|--------|-------------|
| `200` | OK |
| `201` | Creado (POST exitoso) |
| `400` | Datos inválidos (fecha mal escrita, JSON incorrecto) |
| `401` | Falta API Key o es inválida/revocada |
| `403` | Key válida pero sin permiso (scope) |
| `404` | Recurso no encontrado |
| `429` | Demasiadas peticiones (rate limit) |
| `503` | Servicio degradado (ej. aún no hay tasa en la base de datos) |

---

## 5. Endpoints — referencia completa

---

### 5.1 Tasa del día (contrato para facturación)

**El más usado.** Compatible con software que ya consumía la API antigua.

```
GET https://dayzove.lat/bcv-api
```

| | |
|---|---|
| **Autenticación** | Ninguna (público) |
| **Método** | `GET` |
| **Body** | No aplica |

**Respuesta exitosa (200):**

```json
{
  "success": true,
  "bcv_dolar": 567.6828,
  "bcv_dolar_raw": "567,68280000",
  "fecha_valor": "Martes, 09 Junio 2026",
  "updated_at": "2026-06-07T04:08:23.694Z"
}
```

| Campo | Tipo | Uso |
|-------|------|-----|
| `success` | boolean | Siempre `true` si OK |
| `bcv_dolar` | number | **Tasa en número** — úsala para cálculos |
| `bcv_dolar_raw` | string | Texto original del BCV (`567,68280000`) |
| `fecha_valor` | string | Fecha legible del BCV |
| `updated_at` | string | ISO 8601 — cuándo se obtuvo/guardó |

**curl:**

```bash
curl -s "https://dayzove.lat/bcv-api"
```

**JavaScript (navegador o Node):**

```javascript
const res = await fetch('https://dayzove.lat/bcv-api');
const data = await res.json();
const tasa = data.bcv_dolar;
```

**PHP:**

```php
$json = file_get_contents('https://dayzove.lat/bcv-api');
$data = json_decode($json, true);
$tasa = $data['bcv_dolar'];
```

**Python:**

```python
import requests
r = requests.get('https://dayzove.lat/bcv-api')
tasa = r.json()['bcv_dolar']
```

**C# (.NET):**

```csharp
using var client = new HttpClient();
var json = await client.GetStringAsync("https://dayzove.lat/bcv-api");
var doc = System.Text.Json.JsonDocument.Parse(json);
var tasa = doc.RootElement.GetProperty("bcv_dolar").GetDouble();
```

---

### 5.2 Tasa actual (versión enriquecida)

Igual que la anterior pero con más metadatos (fecha normalizada, si está “vieja”, etc.).

```
GET https://dayzove.lat/bcv/v1/rate
```

| | |
|---|---|
| **Autenticación** | Header `X-API-Key` con scope `rates:read` |
| **Método** | `GET` |

**Respuesta (200):**

```json
{
  "success": true,
  "data": {
    "rate": 567.6828,
    "rate_raw": "567,68280000",
    "fecha_valor": "Martes, 09 Junio 2026",
    "effective_date": "2026-06-09",
    "fetched_at": "2026-06-07T04:08:23.694Z",
    "stale": false,
    "age_hours": 2.5
  }
}
```

| Campo extra | Significado |
|-------------|-------------|
| `effective_date` | Fecha `YYYY-MM-DD` a la que aplica la tasa |
| `fetched_at` | Cuándo se guardó en el servidor |
| `stale` | `true` si la tasa tiene más de ~24 h sin actualizar |
| `age_hours` | Horas desde el último fetch |

**curl:**

```bash
curl -s -H "X-API-Key: bcv_TU_CLAVE" \
  "https://dayzove.lat/bcv/v1/rate"
```

---

### 5.3 Historial de tasas

Lista de tasas guardadas (de más reciente a más antigua). **Una fila por cada cambio** de tasa o fecha efectiva.

```
GET https://dayzove.lat/bcv/v1/rates
```

| | |
|---|---|
| **Autenticación** | `X-API-Key` + scope `rates:read` |
| **Método** | `GET` |

**Parámetros de consulta (query string):**

| Parámetro | Tipo | Obligatorio | Descripción |
|-----------|------|-------------|-------------|
| `from` | `YYYY-MM-DD` | No | Desde esta fecha (`effective_date >= from`) |
| `to` | `YYYY-MM-DD` | No | Hasta esta fecha (`effective_date <= to`) |
| `limit` | número 1–1000 | No | Cantidad máxima (default interno: 100) |

**Ejemplos de URL:**

```
https://dayzove.lat/bcv/v1/rates?limit=10
https://dayzove.lat/bcv/v1/rates?from=2026-06-01&to=2026-06-09
https://dayzove.lat/bcv/v1/rates?from=2026-01-01&limit=500
```

**Respuesta (200):**

```json
{
  "success": true,
  "count": 2,
  "rates": [
    {
      "rate": 567.6828,
      "rate_raw": "567,68280000",
      "fecha_valor": "Martes, 09 Junio 2026",
      "effective_date": "2026-06-09",
      "fetched_at": "2026-06-07T04:08:23.694Z"
    },
    {
      "rate": 565.5,
      "rate_raw": "565,50",
      "fecha_valor": "Lunes, 08 Junio 2026",
      "effective_date": "2026-06-08",
      "fetched_at": "2026-06-06T15:00:00.000Z"
    }
  ]
}
```

**curl:**

```bash
curl -s -H "X-API-Key: bcv_TU_CLAVE" \
  "https://dayzove.lat/bcv/v1/rates?from=2026-06-01&to=2026-06-09&limit=50"
```

**JavaScript:**

```javascript
const url = 'https://dayzove.lat/bcv/v1/rates?from=2026-06-01&limit=100';
const res = await fetch(url, {
  headers: { 'X-API-Key': 'bcv_TU_CLAVE' }
});
const { rates } = await res.json();
rates.forEach(r => console.log(r.effective_date, r.rate));
```

**PHP:**

```php
$ch = curl_init('https://dayzove.lat/bcv/v1/rates?limit=30');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['X-API-Key: bcv_TU_CLAVE'],
]);
$data = json_decode(curl_exec($ch), true);
foreach ($data['rates'] as $r) {
  echo $r['effective_date'] . ' -> ' . $r['rate'] . "\n";
}
```

---

### 5.4 Feriados — consultar

```
GET https://dayzove.lat/bcv/v1/holidays
```

| | |
|---|---|
| **Autenticación** | `X-API-Key` + scope `holidays:read` |
| **Método** | `GET` |

**Parámetros:**

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `year` | número (2000–2100) | Filtrar por año, ej. `2026` |
| `detailed` | `true` / `false` | Si `true`, devuelve objetos con nombre y tipo |

**Ejemplos:**

```
https://dayzove.lat/bcv/v1/holidays
https://dayzove.lat/bcv/v1/holidays?year=2026
https://dayzove.lat/bcv/v1/holidays?year=2026&detailed=true
```

**Respuesta simple (200):**

```json
{
  "success": true,
  "year": 2026,
  "count": 21,
  "updated_at": "2026-06-07T04:08:16.106Z",
  "holidays": [
    "2026-01-01",
    "2026-01-12",
    "2026-01-19"
  ]
}
```

**Respuesta detallada (`detailed=true`):**

```json
{
  "success": true,
  "year": 2026,
  "count": 21,
  "updated_at": "2026-06-07T04:08:16.106Z",
  "holidays": [
    { "date": "2026-01-01", "name": null, "type": "nacional" },
    { "date": "2026-06-24", "name": "Batalla de Carabobo", "type": "nacional" }
  ]
}
```

**curl:**

```bash
curl -s -H "X-API-Key: bcv_TU_CLAVE" \
  "https://dayzove.lat/bcv/v1/holidays?year=2026"
```

**JavaScript — comprobar si hoy es feriado:**

```javascript
const hoy = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const res = await fetch('https://dayzove.lat/bcv/v1/holidays?year=2026', {
  headers: { 'X-API-Key': 'bcv_TU_CLAVE' }
});
const { holidays } = await res.json();
const esFeriado = holidays.includes(hoy);
```

---

### 5.5 Feriados — agregar uno

```
POST https://dayzove.lat/bcv/v1/holidays
```

| | |
|---|---|
| **Autenticación** | `X-API-Key` + scope `holidays:write` |
| **Método** | `POST` |
| **Content-Type** | `application/json` |

**Body:**

```json
{
  "date": "2026-07-05",
  "name": "Día de la Independencia (ejemplo)",
  "type": "nacional"
}
```

| Campo | Obligatorio | Formato |
|-------|-------------|---------|
| `date` | Sí | `YYYY-MM-DD` |
| `name` | No | Texto libre o `null` |
| `type` | No | Default: `"nacional"` |

**Respuesta (201 si nuevo, 200 si ya existía y se actualizó):**

```json
{
  "success": true,
  "created": true,
  "date": "2026-07-05"
}
```

**curl:**

```bash
curl -s -X POST \
  -H "X-API-Key: bcv_TU_CLAVE" \
  -H "Content-Type: application/json" \
  -d '{"date":"2026-07-05","name":"Mi feriado"}' \
  "https://dayzove.lat/bcv/v1/holidays"
```

---

### 5.6 Feriados — reemplazar calendario completo

Borra **todos** los feriados actuales y carga la lista nueva.

```
PUT https://dayzove.lat/bcv/v1/holidays
```

| | |
|---|---|
| **Autenticación** | `X-API-Key` + scope `holidays:write` |
| **Método** | `PUT` |
| **Content-Type** | `application/json` |

**Body — opción A (solo fechas):**

```json
{
  "holidays": [
    "2027-01-01",
    "2027-05-01",
    "2027-12-25"
  ]
}
```

**Body — opción B (con detalle):**

```json
{
  "holidays": [
    "2027-01-01",
    { "date": "2027-05-01", "name": "Día del Trabajador", "type": "nacional" }
  ]
}
```

**Respuesta (200):**

```json
{
  "success": true,
  "count": 3
}
```

**curl:**

```bash
curl -s -X PUT \
  -H "X-API-Key: bcv_TU_CLAVE" \
  -H "Content-Type: application/json" \
  -d '{"holidays":["2027-01-01","2027-05-01"]}' \
  "https://dayzove.lat/bcv/v1/holidays"
```

---

### 5.7 Feriados — eliminar uno

```
DELETE https://dayzove.lat/bcv/v1/holidays/{fecha}
```

| | |
|---|---|
| **Autenticación** | `X-API-Key` + scope `holidays:write` |
| **Método** | `DELETE` |
| **Fecha en URL** | `YYYY-MM-DD` |

**Ejemplo:**

```
DELETE https://dayzove.lat/bcv/v1/holidays/2026-07-05
```

**Respuesta (200):**

```json
{
  "success": true,
  "removed": true,
  "date": "2026-07-05"
}
```

**curl:**

```bash
curl -s -X DELETE \
  -H "X-API-Key: bcv_TU_CLAVE" \
  "https://dayzove.lat/bcv/v1/holidays/2026-07-05"
```

---

### 5.8 Health — comprobar que el servicio vive

```
GET https://dayzove.lat/bcv/health
```

| | |
|---|---|
| **Autenticación** | Ninguna |
| **Método** | `GET` |

**Respuesta (200):**

```json
{
  "status": "ok",
  "service": "bcv-api",
  "version": "2.0.0",
  "uptime_seconds": 3600
}
```

---

### 5.9 Health — estado real (base de datos + tasa)

```
GET https://dayzove.lat/bcv/health/ready
```

| | |
|---|---|
| **Autenticación** | Ninguna |
| **Método** | `GET` |

**Respuesta OK (200):**

```json
{
  "status": "ok",
  "checks": {
    "database": "ok",
    "rate": {
      "status": "fresh",
      "effective_date": "2026-06-09",
      "fetched_at": "2026-06-07T04:08:23.694Z",
      "age_hours": 1.2
    },
    "last_success_at": "2026-06-07T04:09:29.889Z",
    "last_error": null
  }
}
```

**Respuesta degradada (503):** falta tasa o la base de datos falla (`"status": "degraded"`).

---

### 5.10 Admin — listar API Keys

```
GET https://dayzove.lat/bcv/v1/admin/keys
```

| | |
|---|---|
| **Autenticación** | `X-API-Key` + scope `admin` |

**Respuesta (200):**

```json
{
  "success": true,
  "keys": [
    {
      "prefix": "bcv_AbCdEfGh",
      "name": "mi-facturador",
      "scopes": ["rates:read", "holidays:read"],
      "active": true,
      "created_at": "2026-06-07T04:08:16.106Z",
      "last_used_at": "2026-06-07T12:00:00.000Z",
      "revoked_at": null
    }
  ]
}
```

> Nunca se devuelve la clave completa, solo el `prefix`.

---

### 5.11 Admin — crear API Key

```
POST https://dayzove.lat/bcv/v1/admin/keys
```

**Body:**

```json
{
  "name": "cliente-nuevo",
  "scopes": ["rates:read", "holidays:read"]
}
```

Scopes válidos: `rates:read`, `holidays:read`, `holidays:write`, `admin`.

**Respuesta (201):**

```json
{
  "success": true,
  "message": "Guarda esta key ahora; no se volvera a mostrar.",
  "api_key": "bcv_nuevaClaveCompleta...",
  "prefix": "bcv_nuevaClav",
  "name": "cliente-nuevo",
  "scopes": ["rates:read", "holidays:read"]
}
```

---

### 5.12 Admin — revocar API Key

```
DELETE https://dayzove.lat/bcv/v1/admin/keys/{prefix}
```

Ejemplo: `DELETE https://dayzove.lat/bcv/v1/admin/keys/bcv_AbCdEfGh`

---

### 5.13 Admin — forzar actualización de tasa desde el BCV

```
POST https://dayzove.lat/bcv/v1/admin/refresh
```

| | |
|---|---|
| **Autenticación** | `X-API-Key` + scope `admin` |
| **Body** | Vacío |

**Respuesta (200):**

```json
{
  "success": true,
  "inserted": true,
  "rate": 567.6828,
  "effective_date": "2026-06-09",
  "fetched_at": "2026-06-07T15:00:00.000Z"
}
```

`inserted: false` significa que la tasa no cambió respecto a la última guardada.

---

## 6. Tabla resumen rápida

| Qué necesitas | Método | URL pública | API Key |
|---------------|--------|-------------|---------|
| Tasa de hoy (facturador) | GET | `https://dayzove.lat/bcv-api` | No |
| Tasa con detalles | GET | `https://dayzove.lat/bcv/v1/rate` | Sí (`rates:read`) |
| Historial | GET | `https://dayzove.lat/bcv/v1/rates?...` | Sí (`rates:read`) |
| Listar feriados | GET | `https://dayzove.lat/bcv/v1/holidays?...` | Sí (`holidays:read`) |
| Agregar feriado | POST | `https://dayzove.lat/bcv/v1/holidays` | Sí (`holidays:write`) |
| Reemplazar feriados | PUT | `https://dayzove.lat/bcv/v1/holidays` | Sí (`holidays:write`) |
| Borrar feriado | DELETE | `https://dayzove.lat/bcv/v1/holidays/YYYY-MM-DD` | Sí (`holidays:write`) |
| ¿Servicio vivo? | GET | `https://dayzove.lat/bcv/health` | No |
| ¿Todo OK? | GET | `https://dayzove.lat/bcv/health/ready` | No |
| Gestionar keys | GET/POST/DELETE | `https://dayzove.lat/bcv/v1/admin/...` | Sí (`admin`) |

---

## 7. Casos de uso típicos

### Caso A — Solo facturar con la tasa del día

1. `GET https://dayzove.lat/bcv-api`
2. Usar `bcv_dolar` en tus cálculos.
3. Fin.

### Caso B — Facturar + saber si es feriado

1. Crear key: `rates:read,holidays:read`
2. Tasa: `GET /bcv-api` (pública) **o** `GET /bcv/v1/rate` (con key)
3. Feriados: `GET /bcv/v1/holidays?year=2026` con header `X-API-Key`
4. Comparar la fecha de hoy con el array `holidays`

### Caso C — Reportes con historial de tasas

1. Key con `rates:read`
2. `GET /bcv/v1/rates?from=2026-01-01&to=2026-12-31&limit=1000`
3. Recorrer el array `rates` (orden: más reciente primero)

### Caso D — Actualizar feriados desde tu sistema (sin tocar el servidor a mano)

1. Key con `holidays:write`
2. `PUT /bcv/v1/holidays` con el JSON completo del año nuevo

---

## 8. Errores frecuentes y solución

| Problema | Causa probable | Solución |
|----------|----------------|----------|
| `401 API Key requerida` | Falta header | Añade `X-API-Key: bcv_...` |
| `401 API Key invalida` | Clave mal copiada o revocada | Crea otra con `keys:create` |
| `403 Permiso insuficiente` | Scope incorrecto | Crea key con el scope que falta |
| `400 Error de validacion` | Fecha no es `YYYY-MM-DD` | Usa `2026-06-09`, no `09/06/2026` |
| `404` en `/v1/rate` sin `/bcv/` | URL incorrecta | Usa `https://dayzove.lat/bcv/v1/rate` |
| `429 Demasiadas solicitudes` | Rate limit | Espera un minuto o usa API Key (cuenta aparte) |
| `503 No hay tasa disponible` | Primera instalación, BCV caído | Espera o ejecuta `node bin/bcv-admin.js rate:refresh` en el servidor |

---

## 9. Límites y buenas prácticas

- **Rate limit:** ~120 peticiones por minuto por IP (o por API Key si la envías).
- **No expongas la API Key en código frontend** (JavaScript en el navegador). Úsala solo en servidor o en apps de escritorio.
- **`/bcv-api` es pública:** cualquiera puede leer la tasa. Si quieres exigir clave también ahí, en el servidor cambia en `.env`: `REQUIRE_KEY_FOR_RATE=1` y reinicia con `pm2 reload bcv-api`.
- **HTTPS:** usa siempre `https://dayzove.lat`, nunca `http://` en producción.
- **Historial:** crece solo; cada cambio de tasa del BCV añade una fila. Al inicio puede haber pocas entradas.

---

## 10. Probar desde tu PC (sin programar)

Abre en el navegador:

```
https://dayzove.lat/bcv-api
```

Deberías ver JSON con la tasa.

Para endpoints con key, usa **Postman**, **Insomnia** o curl:

1. Método: GET  
2. URL: `https://dayzove.lat/bcv/v1/rates?limit=5`  
3. Header: `X-API-Key` = tu clave  

---

## 11. Contacto técnico en el servidor

Rutas del proyecto:

```
/var/www/bcv-api/          ← código de la API
/var/www/bcv-api/data/     ← base SQLite (historial, keys, feriados)
```

Comandos útiles:

```bash
pm2 list                              # ¿está encendida?
pm2 logs bcv-api                      # ver logs
curl http://127.0.0.1:3002/bcv-api    # probar en el servidor
node bin/bcv-admin.js rate:latest     # última tasa guardada
```

---

*Documento generado para bcv-api v2.0 — dayzove.lat*
