# REPORTE MAESTRO — Nexus Core: sistema actual + plan Modo Solo BCV

**Audiencia:** IA / desarrollador que implementará la funcionalidad sin contexto previo.  
**Proyecto:** Nexus Core ERP/POS — escritorio Windows (Electron + Express + PostgreSQL).  
**Mercado:** Bodegas, abastos y retail venezolano (1 tienda, 1 PC, multimoneda BCV + USD calle).  
**Fecha:** Junio 2026.  
**Estado del feature solicitado:** Planificado; esqueleto parcial en código (~15–20 %).

---

## Índice

1. [Resumen para la IA](#1-resumen-para-la-ia)
2. [Arquitectura del sistema](#2-arquitectura-del-sistema)
3. [Stack tecnológico](#3-stack-tecnológico)
4. [Nomenclatura monetaria (CRÍTICO)](#4-nomenclatura-monetaria-crítico)
5. [Tasas de cambio — cómo funcionan hoy](#5-tasas-de-cambio--cómo-funcionan-hoy)
6. [Motor de precios — cadena multimoneda](#6-motor-de-precios--cadena-multimoneda)
7. [Catálogo e inventario — costos y precios](#7-catálogo-e-inventario--costos-y-precios)
8. [POS — flujo de venta completo](#8-pos--flujo-de-venta-completo)
9. [Persistencia de ventas — columnas clave](#9-persistencia-de-ventas--columnas-clave)
10. [Pagos — métodos, monedas y validación servidor](#10-pagos--métodos-monedas-y-validación-servidor)
11. [Caja](#11-caja)
12. [Cashea](#12-cashea)
13. [Cartera y crédito](#13-cartera-y-crédito)
14. [Dashboard y reportes (regla BCV)](#14-dashboard-y-reportes-regla-bcv)
15. [Configuración y setup](#15-configuración-y-setup)
16. [Licencia, auth y permisos](#16-licencia-auth-y-permisos)
17. [Módulos adicionales](#17-módulos-adicionales)
18. [Estado actual de `modo_moneda_operacion`](#18-estado-actual-de-modo_moneda_operacion)
19. [Feature solicitado — definición y decisiones](#19-feature-solicitado--definición-y-decisiones)
20. [Plan de implementación](#20-plan-de-implementación)
21. [Índice de archivos por área](#21-índice-de-archivos-por-área)
22. [Criterios de aceptación y riesgos](#22-criterios-de-aceptación-y-riesgos)

---

## 1. Resumen para la IA

### Qué es Nexus Core

ERP/POS de **escritorio Windows** para un **único negocio físico** en Venezuela. No es SaaS multitenant. Cada instalación = una base PostgreSQL local + una licencia por HWID.

### Qué se quiere construir

Permitir que el cliente elija al **instalar** (y después, con reglas) entre:

| Modo | Clave BD | Descripción |
|------|----------|-------------|
| **Multimoneda** | `multimoneda` | Comportamiento actual: `tasa_bcv` (oficial) + `tasa_usd` (mercado/calle). |
| **Solo BCV** | `solo_bcv` | Una sola tasa operativa: `tasa_usd` forzada = `tasa_bcv`; UI y cálculos simplificados. |

### Lo más importante que debe entender la IA

1. **Todo el sistema gira en torno a una cadena de precios de 4 pasos** que usa **dos tasas** (`tasa_bcv` y `tasa_usd`). Está duplicada en backend y frontend (utilidad dual obligatoria).
2. Las ventas guardan **ambas tasas** (`tasa_bcv_aplicada`, `tasa_cambio_aplicada`) más totales en USD efectivo, ref. USD BCV y Bs BCV operativo.
3. El cobro en mostrador se valida contra **`total_bs_bcv_operativo`** (cadena BCV), no solo contra USD calle.
4. Ya existe `modo_moneda_operacion` en BD y un **atajo solo en el navbar** que iguala tasas en el frontend — **el backend de ventas NO lo usa**. Implementar a medias es peligroso.
5. **Nunca reconvertir ventas históricas** al cambiar de modo.

---

## 2. Arquitectura del sistema

```
┌─────────────────────────────────────────────────────────────────┐
│  ELECTRON (electron/main.js)                                    │
│  - Arranca ventana, splash, setup, activación                   │
│  - IPC: HWID, PDF, rutas, setup PostgreSQL                      │
│  - Carga dotenv, inicia backend Express embebido                │
└───────────────────────────┬─────────────────────────────────────┘
                            │ http://127.0.0.1:3000
┌───────────────────────────▼─────────────────────────────────────┐
│  BACKEND Express (backend/server.js)                            │
│  - API REST /api/*                                              │
│  - JWT auth, permisos por rol                                   │
│  - pg-promise → PostgreSQL local                                │
│  - Migraciones 001–038 (parches incrementales)                  │
│  - Jobs: BCV auto, backup scheduler                             │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│  FRONTEND SPA (frontend/)                                       │
│  - index.html + router.js (hash #/ruta)                         │
│  - Páginas en frontend/pages/*/*.html + *.js                    │
│  - Componentes: navbar, sidebar, toast, currencyDisplay         │
│  - preciosClient.js (espejo del backend)                        │
│  - localStorage: tasas, JWT                                     │
└─────────────────────────────────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│  PostgreSQL (instalación del sistema — NO embebido por defecto)   │
│  - Tabla configuracion (clave/valor)                            │
│  - Tablas operativas: productos, ventas, caja, clientes, etc.   │
└─────────────────────────────────────────────────────────────────┘
```

### Flujo de arranque

1. Usuario abre `Nexus Core.exe`.
2. Si no hay `config.env` en userData → `setup.html` (wizard).
3. Wizard paso 1: conectar PostgreSQL (host, puerto, BD, usuario, clave).
4. Wizard paso 2: activar licencia (HWID + código NC1).
5. Wizard paso 3: crear admin inicial.
6. Wizard paso 4: datos empresa + modo Cashea inicial.
7. `activation.html` si licencia inválida/expirada.
8. App principal: `index.html` → login → dashboard/POS/etc.

### Modelo de despliegue

- **Una tienda, una BD, un HWID.**
- Backend escucha en `127.0.0.1` (no expuesto a LAN por defecto).
- CORS permite `file://` (Electron) y `localhost`.
- Sin multi-sucursal, sin tenant_id, sin sync cloud.

---

## 3. Stack tecnológico

| Capa | Tecnología |
|------|------------|
| Desktop | Electron 36, Windows x64 (NSIS + portable) |
| Backend | Node 18+, Express 4, pg-promise, winston |
| Frontend | Vanilla JS, HTML parcial por página, CSS custom (sin React) |
| BD | PostgreSQL 12+ |
| Auth | JWT (bcrypt passwords) |
| Licencia | Ed25519 offline, servidor Vercel (`license-server/`) |
| Excel | exceljs |
| PDF | jspdf, plantillas en `resources/templates/` |
| Impresora | node-thermal-printer (TCP 9100) |
| Gráficos | chart.js (dashboard) |

---

## 4. Nomenclatura monetaria (CRÍTICO)

En Venezuela el sistema maneja **tres referencias** que la IA no debe confundir:

| Término en código/UI | Significado | Ejemplo |
|---------------------|-------------|---------|
| **USD efectivo** / `precio_usd_efectivo` / `total_usd` | Dólares físicos de mercado (tasa calle) | Producto a $2.50 USD |
| **USD BCV** / `precio_usd_bcv` / `total_ref_usd_bcv` | Referencia en dólares cadena BCV (fiscal/oficial) | Producto a $2.20 ref. BCV |
| **Bs BCV** / `precio_bs` / `total_bs_bcv_operativo` | Bolívares a cobrar en mostrador (tasa BCV) | Bs. 196.80 |

### Las dos tasas (siempre en Bs por 1 USD)

| Clave configuracion | Nombre UI | Origen |
|--------------------|-----------|--------|
| `tasa_bcv` | Tasa BCV / USD BCV | Manual o automática (dolarapi + feriados VE) |
| `tasa_usd` | Tasa USD | **Siempre manual** («Guardar tasas»). Antes se llamaba `tasa_paralela` (migración 035). |

**Regla:** `tasa_usd` ≥ `tasa_bcv` en la práctica (si USD < BCV al guardar BCV auto, se sube USD al nivel BCV).

### Monedas en pagos (POS)

| `pago.moneda` | Uso |
|---------------|-----|
| `USD` | Dólares físicos en caja |
| `BS` | Bolívares (cadena BCV en validación) |
| `USD_BCV` | Crédito expresado en referencia $ BCV |

---

## 5. Tasas de cambio — cómo funcionan hoy

### Almacenamiento

- Tabla `configuracion`: claves `tasa_bcv`, `tasa_usd` (texto, 4 decimales).
- Tabla `historial_tasas`: snapshot diario al actualizar cualquiera de las dos (trigger en migración 035).
- Feriados VE: clave `tasa_bcv_feriados_ve` (JSON fechas).

### Lectura operativa — `PreciosService.obtenerTasasActuales(db)`

Archivo: `backend/services/preciosService.js`

1. Lee `tasa_usd` de `configuracion`.
2. Lee `tasa_bcv` **legal vigente** vía `leerTasaBcvVigenteLegal()`:
   - Calcula día hábil de referencia en zona `America/Caracas`.
   - En fines de semana/feriados usa tasa del **último día hábil** (`historial_tasas` o fallback `configuracion.tasa_bcv`).
3. Devuelve `{ tasa_bcv, tasa_usd, dia_habil_referencia, congelada_por_no_habil }`.

### API pública de tasas

`GET /api/configuracion/tasas-actuales` → incluye `modo_moneda_operacion` (lectura de `modoMonedaService`).

### Guardado manual

`POST /api/configuracion/tasas` con `{ tasa_bcv, tasa_usd }` — requiere admin autenticado. Auditoría en historial.

### BCV automático

Archivo: `backend/services/bcvTasaAutoService.js`

- Única salida HTTP del backend además de licencia: `https://ve.dolarapi.com/v1/dolares/oficial`.
- Consulta diaria ~17:30 Caracas; aplica a medianoche.
- Claves config: `tasa_bcv_auto_activo`, pendientes, última consulta, errores.
- Al actualizar BCV: si `tasa_usd` < nueva BCV, sube USD también (`actualizarTasaBcvAutomatica` en preciosService).
- **No toca `modo_moneda_operacion` hoy.**

### Propagación al frontend

1. `navbar.js` → `hydrateTasasFromApi()` llama `/api/configuracion/tasas-actuales`.
2. Guarda en `localStorage`: `nexus_tasa_bcv`, `nexus_tasa_usd`.
3. Dispara evento global `nexus:tasas` con `{ tasa_bcv, tasa_usd }`.
4. POS, inventario y otros módulos escuchan o leen `NexusComponents.loadTasasLocal()`.

---

## 6. Motor de precios — cadena multimoneda

### Archivos espejo (OBLIGATORIO mantener sincronizados)

| Backend | Frontend |
|---------|----------|
| `backend/services/preciosService.js` | `frontend/services/preciosClient.js` |

Comentarios `NEXUS-DUAL: contraparte en [ruta]` marcan funciones pareadas.

### Cadena de 4 pasos (`calcularPrecios` / `aplicarCadenaPorPrecioEfectivo`)

Dado: `costo_usd`, `ganancia_pct`, `tasa_bcv`, `tasa_usd`

```
Paso 1 — precio_usd_efectivo = round(costo × (1 + ganancia%), 2)

Paso 2 — monto_bs_base = precio_usd_efectivo × tasa_usd  (float, sin redondeo)

Paso 3 — bs_usd_equiv = round(monto_bs_base, 2)
         → precio_usd_bcv (2 dec) vía aritmética entera con tasa_bcv ×10000

Paso 4 — precio_bs (2 dec) = precio_usd_bcv × tasa_bcv (coherente con ticket)
```

### Funciones clave

| Función | Propósito |
|---------|-----------|
| `calcularPrecios(costo, ganancia%, bcv, usd)` | Cadena completa desde costo + margen |
| `aplicarCadenaPorPrecioEfectivo(pe, bcv, usd)` | Pasos 2–4 desde precio USD efectivo ya fijado |
| `precioManualUsdDesdeBcvObjetivo(objetivo_bcv, bcv, usd)` | Inverso: fijar precio en $ BCV → calcular `precio_manual_usd` (4 dec) |
| `totalBolivaresDesdeRefUsdBcv(usdBcvTotal, tasa_bcv)` | Total Bs del ticket desde ref. cabecera USD BCV |
| `precioBolivaresRefBcvDesdeBsUsd(bsUsdEquiv, tasa_bcv)` | Conversión Bs@USD → ref BCV + Bs BCV sin error IEEE |

### Prioridad de precio en catálogo

`precioVentaUnitarioCatalogo()` (backend):

1. Si `precio_manual_usd` > 0 → usa manual (4 dec) + cadena.
2. Si no → `calcularPrecios(costo_usd, margen_ganancia_pct, bcv, usd)`.

El **servidor recalcula precios en ventas** — ignora precios enviados por el cliente POS (anti-manipulación).

### Efecto de Solo BCV en esta cadena

Cuando `tasa_usd === tasa_bcv`:

- Paso 2 y 3 colapsan (mismo factor).
- `precio_usd_efectivo` y `precio_usd_bcv` pueden coincidir o acercarse según redondeos.
- La API **no cambia**; solo cambian los inputs (forzar tasas iguales en backend).

---

## 7. Catálogo e inventario — costos y precios

### Tabla `productos` — campos monetarios

| Campo | Tipo | Notas |
|-------|------|-------|
| `costo_usd` | DECIMAL(12,4) | Siempre almacenado como USD físico interno |
| `costo_promedio_ponderado_usd` | DECIMAL(12,4) | CPP para margen en ventas |
| `margen_ganancia_pct` | DECIMAL(5,2) | Default ~30 % |
| `precio_manual_usd` | DECIMAL(12,4) | Override de margen; 4 decimales |
| `moneda_costo` | VARCHAR(20) | `'usd_fisico'` \| `'bcv'` (migración 028) |

### `moneda_costo` — semántica

- **`usd_fisico`:** el usuario ingresa costo en dólares físicos.
- **`bcv`:** el usuario ingresa costo en referencia $ BCV; el frontend convierte a `costo_usd` antes de guardar usando la cadena inversa.

### UI inventario (`frontend/pages/inventario/`)

Estado local:

- `modoMonedaCosto`: `'usd_fisico'` | `'bcv'`
- `modoPrecios`: `'margen'` | `'bcv'` | `'usd'`
  - **margen:** % ganancia sobre costo
  - **bcv:** fijar precio objetivo en $ BCV → calcula `precio_manual_usd`
  - **usd:** fijar precio en USD físico directo

Botones en HTML: tabs USD físico / $BCV para costo; paneles dinámicos para modo precio.

### Movimientos de inventario

`ajustes_inventario.moneda_costo` — trazabilidad del movimiento (migración 028).

### Import Excel

`importProductosService.js` — columna `moneda_costo` / `usd_fisico/bcv`.

---

## 8. POS — flujo de venta completo

Archivo principal: `frontend/pages/pos/pos.js` (~3800+ líneas).

### Resumen del flujo

1. Cajero abre sesión de caja (requerida para vender).
2. POS carga tasas (`nexus:tasas` / localStorage).
3. Busca producto (código, nombre); agrega al carrito.
4. Por línea: calcula precios vía `PreciosServiceClient` (misma cadena que servidor).
5. Totales carrito:
   - `totalUsd` — suma en USD efectivo (con descuentos/IVA)
   - `totalBsBcv` — desde ref. USD BCV cabecera × tasa BCV
6. Cobro: uno o más pagos (efectivo USD, Bs, mixto, crédito, Cashea).
7. POST `/api/ventas` con `idempotency_key` (anti doble cobro).
8. Servidor valida todo y persiste.
9. Ticket PDF / impresión térmica.

### Métodos de pago definidos en POS

```javascript
// frontend/pages/pos/pos.js (conceptual)
efectivo_bs:   { moneda: 'BS' }
efectivo_usd:  { moneda: 'USD' }
credito:       { moneda: 'USD_BCV' }  // cartera
cashea:        { metodo: 'cashea', cashea_desglose: {...} }
```

### Funciones de conversión en POS (espejo del backend)

| Función POS | Equivalente backend |
|-------------|---------------------|
| `paidUsdEquiv(payments, tasaUsd)` | `sumaPagosEquivUsdCalle()` |
| `paidBsBcv(payments, totalesCarrito)` | `sumaPagosEquivBsBcvOperativo()` |
| `bsBcvEquivalenteCasheaUsdEfectivo()` | lógica proporcional Cashea |

### Reglas de cobro importantes

- **Validación principal del ticket:** `total_bs_bcv_operativo` (Bs cadena BCV).
- **Validación secundaria:** equivalente USD calle para cuadre (`total_usd`).
- Pago **solo Bs:** suma Bs debe igualar `total_bs_bcv_operativo`.
- Pago **mixto USD + Bs:** `sumUsd × tasa_usd + sumBs ≈ total_bs_bcv_operativo`.
- **Crédito USD_BCV / Cashea:** validación en cadena Bs BCV con tolerancia ~1 Bs.

### PDF en Electron

`nexusCore.openPdfBuffer(arrayBuffer)` — IPC abre PDF en visor del sistema.

---

## 9. Persistencia de ventas — columnas clave

Tabla `ventas` (campos monetarios relevantes):

| Columna | Significado |
|---------|-------------|
| `subtotal_usd` | Suma líneas USD efectivo antes desc. cabecera |
| `total_usd` | Total final USD efectivo (con desc. e IVA) |
| `total_bs` | Igual a `total_bs_bcv_operativo` en ventas nuevas |
| `total_bs_bcv_operativo` | **Bs a cobrar** — ref USD BCV × tasa BCV (migración 037) |
| `total_bs_cliente` | Lo declaró el POS (validación anti-manipulación) |
| `total_ref_usd_bcv` | Total cabecera en referencia $ BCV (migración 029) |
| `tasa_bcv_aplicada` | BCV al momento de venta (migración 030) |
| `tasa_cambio_aplicada` | USD calle al momento de venta (antes “paralela”) |
| `pagos` | JSONB array de objetos pago |
| `idempotency_key` | UUID anti duplicado (migración 021) |

**Importante para Solo BCV:** al unificar tasas, `tasa_cambio_aplicada` y `tasa_bcv_aplicada` serán iguales en ventas nuevas, pero **el histórico conserva valores distintos**.

---

## 10. Pagos — métodos, monedas y validación servidor

Archivo: `backend/controllers/ventas.controller.js` (función crear venta, ~línea 400+).

### Secuencia de validación en servidor

1. Sesión de caja abierta.
2. `obtenerTasasActuales()` → `tasa_bcv`, `tasa_usd_calle`.
3. Recalcula cada línea con `precioUnitarioUsdServidor()` / `precioUsdBcvPorUnidad()`.
4. Calcula `total_usd`, `total_bs_bcv_operativo`, `total_ref_usd_bcv`.
5. Compara con totales declarados por POS (tolerancias `EPS_USD_PRECIOS`, `EPS_BS_TOTAL`).
6. `sumaPagosEquivUsdCalle()` — cuadre USD.
7. Si no cuadra USD: ramas `soloBS`, `mixtoUsdBs`, o cadena BCV (`sumaPagosEquivBsBcvOperativo`).
8. INSERT venta + detalle + movimiento inventario + pagos caja + crédito/Cashea si aplica.

### `PreciosService.sumaPagosEquivUsdCalle` — reglas

| moneda | Conversión a USD efectivo |
|--------|---------------------------|
| `USD` | 1:1 |
| `USD_BCV` | `monto × tasa_bcv / tasa_usd` |
| `BS` | `monto / tasa_usd` |
| `cashea` | `montoInicial + montoPrestado` (USD efectivo del desglose) |

### `PreciosService.sumaPagosEquivBsBcvOperativo`

Convierte cada pago a Bs cadena BCV; Cashea usa proporción sobre totales del carrito.

---

## 11. Caja

Archivos: `backend/controllers/caja.controller.js`, `frontend/pages/caja/caja.js`.

### Conceptos

- **Sesión de caja** (`sesiones_caja`): apertura → operaciones → cierre/arqueo.
- Apertura con saldos iniciales por método (USD, Bs, Cashea, etc.).
- Cada venta se ata a `sesion_caja_id`.
- Cierre: conteo físico multimoneda vs. sistema (migración 008 — caja multimoneda).

### Relación con tasas

- Al abrir/cerrar se registran tasas vigentes (`tasa_bcv`, `tasa_usd`).
- Arqueo desglosa por método de pago incluyendo Cashea.

### Regla para cambio de modo

**No permitir cambiar `modo_moneda_operacion` con sesión de caja abierta.**

---

## 12. Cashea

Archivos: `backend/services/casheaService.js`, `frontend/pages/cashea/`, migraciones 012, 027, 033, 038.

### Qué es en Nexus

**Control financiero interno** de ventas Cashea — liquidaciones, comisiones oficiales, niveles (Semilla → Araguaney), horario Express. **No hay API oficial de Cashea.**

### En el POS

- Método `cashea` con `cashea_desglose`: `montoInicial`, `montoPrestado`, `inicialBsBcv`, etc.
- Comisión según tablas de tarifas en BD.
- Tramo financiado no entra como efectivo en caja inicial; cuota inicial sí.

### En ventas

- Se detecta pago `metodo === 'cashea'` para crear registro en módulo Cashea.
- Validación de pagos usa proporción USD BCV del carrito, no simple × tasa_usd.

### Regla de proyecto (BCV.mdc)

Dashboard y todo lo Cashea se muestra en **USD BCV**, no USD calle.

### Solo BCV

Cashea **no se elimina**; las tasas unificadas simplifican conversiones pero el flujo de desglose permanece.

---

## 13. Cartera y crédito

Archivos: `backend/controllers/cartera.controller.js`, `frontend/pages/cartera/`, `creditoAbonoService.js`.

- Venta a crédito: pago con `moneda: 'USD_BCV'`.
- Crea cuenta por cobrar; abonos posteriores.
- Límites de crédito por cliente.
- Anulación/devolución revierte crédito (migración 022).

---

## 14. Dashboard y reportes (regla BCV)

### Dashboard (`dashboardService.js`, `frontend/pages/dashboard/`)

KPIs en **USD BCV** (ventas hoy, 7d, mes, margen, alertas stock). Regla de workspace: mostrar datos en cadena BCV.

### Reportes (`reportesService.js`, `frontend/pages/reportes/`)

15+ reportes: ventas, top productos, rentabilidad, deudas, cierres, tasas, reposición, liquidaciones Cashea, libros IVA (XLSX).

Columnas de tasas en historial muestran `tasa_bcv` y `tasa_usd`.

---

## 15. Configuración y setup

### Configuración (`frontend/pages/configuracion/`)

Tabs: Tasas, Empresa, Impresora, Usuarios, Respaldo, Licencia.

**Tasas hoy:**

- Display + input BCV y USD por separado.
- Panel BCV automático (toggle, consultar ahora, feriados).
- Nota: «La tasa USD siempre se actualiza manualmente».
- **No hay UI para `modo_moneda_operacion`.**

### Setup wizard (`frontend/setup.html`)

| Paso | Contenido |
|------|-----------|
| 1 | PostgreSQL — host, puerto, BD, usuario, clave |
| 2 | Licencia — HWID + código NC1 |
| 3 | Admin inicial — nombre, usuario, contraseña |
| 4 | Empresa + Cashea inicial — nombre negocio, flags Cashea |

API setup sin JWT: `backend/routes/setup.routes.js`, `setupAdminService.js`.

**No hay paso de modo moneda hoy.**

### Respaldo

`backupScheduler.js` — `pg_dump` periódico, al cerrar caja, al salir. Requiere PostgreSQL del sistema en PATH o `NEXUS_PG_BIN_DIR`.

---

## 16. Licencia, auth y permisos

### Licencia

- Formato token `NC1.*`, firmado Ed25519.
- Vinculada a HWID (`electron/main.js` → IPC).
- Servidor: `license-server/` en Vercel.
- Ediciones en token: `basico`, `profesional`, `enterprise` — **sin feature gating en app aún**.

### Auth

- `POST /api/auth/login` → JWT.
- `frontend/services/authClient.js` — almacena token, `NexusAuth.can(permiso)`.

### Permisos relevantes

| Permiso | Uso |
|---------|-----|
| `config_write` | Cambiar tasas, empresa, modo moneda (futuro) |
| `pos_sales` | POS y Cashea |
| `caja_operar` | Caja |
| `inventario_ver` / escritura | Inventario |
| `reportes_all` | Reportes |

Matriz en `backend/constants/rolePermissions.js` + overrides por usuario (migración 025).

---

## 17. Módulos adicionales

| Módulo | Rutas / archivos | Función |
|--------|------------------|---------|
| Clientes | `clientes.controller.js`, `pages/clientes/` | CRUD, historial, deuda |
| Proveedores | `proveedores.controller.js` | CRUD proveedores |
| Compras | `compras.routes.js` | Órdenes de compra, recepción |
| Ventas (historial) | `ventas.controller.js`, `pages/ventas/` | Listado, detalle, devoluciones |
| Usuarios | `usuarios.routes.js` | CRUD, permisos |
| PDF | `pdf.routes.js`, `pdfService.js` | Tickets, comprobantes |
| Impresión | `impresionService.js` | Térmica TCP — ticket dice «Documento no fiscal» |

---

## 18. Estado actual de `modo_moneda_operacion`

### Infraestructura existente

```sql
-- database/migrations/037_total_bs_bcv_y_modo_moneda.sql
INSERT INTO configuracion (clave, valor, ...)
VALUES ('modo_moneda_operacion', 'multimoneda', ...);
```

```javascript
// backend/services/modoMonedaService.js
MODOS_VALIDOS = ['multimoneda', 'solo_bcv']
leerModo(db) // default 'multimoneda'
esSoloBcv(modo)
```

### Dónde se usa HOY (lista exhaustiva)

| Archivo | Uso |
|---------|-----|
| `modoMonedaService.js` | Definición |
| `configuracion.controller.js` | GET tasas-actuales + PATCH configuracion |
| `navbar.js` | Si `solo_bcv`, `usdOperativo = bcv` antes de `nexus:tasas` |
| `migrations.js` / `server.js` | Log parche 037 |

### Dónde NO se usa (debe implementarse)

- `preciosService.obtenerTasasActuales` — sigue leyendo `tasa_usd` real
- `ventas.controller.js` — usa `tasas.tasa_usd` sin consultar modo
- `bcvTasaAutoService` — no sincroniza USD cuando solo BCV
- `pos.js`, `inventario.js`, `caja.js`, `configuracion.js`, `setup.html`
- `reportesService`, `dashboardService`, `pdfService`, `excelService`

### Comportamiento actual del navbar (parcial)

```javascript
// frontend/components/navbar.js
const modo = d.modo_moneda_operacion || 'multimoneda';
const usdOperativo = modo === 'solo_bcv' ? bcv : usd;
saveRates(bcv, usdOperativo, true);
window.dispatchEvent(new CustomEvent('nexus:tasas', {
  detail: { tasa_bcv: bcv, tasa_usd: usdOperativo }
}));
```

**Efecto:** módulos que solo escuchan `nexus:tasas` ven tasas unificadas. El backend y `saveTasas` manual **no**.

---

## 19. Feature solicitado — definición y decisiones

### Objetivo de producto

Que el dueño de una bodega elija si su negocio opera:

1. **Multimoneda** — el comportamiento actual completo.
2. **Solo BCV** — interfaz y reglas simplificadas; una tasa; mercado ampliado (bodegueros que no manejan “dólar calle”).

### Decisiones de negocio acordadas

| Tema | Decisión |
|------|----------|
| ¿Dónde elegir primero? | Wizard de instalación + Configuración → Tasas |
| ¿Irreversible? | **No** |
| ¿Cambiar después? | **Sí**, solo admin, caja cerrada, modal, auditoría |
| ¿Reconvertir histórico? | **Nunca** |
| ¿Valor por defecto? | `multimoneda` (compatibilidad instalaciones existentes) |

### Comportamiento técnico objetivo — Solo BCV

1. `modo_moneda_operacion = 'solo_bcv'` en `configuracion`.
2. En **cualquier** escritura de tasas: `tasa_usd := tasa_bcv`.
3. `obtenerTasasActuales()` devuelve ambas iguales (fuente de verdad backend).
4. UI oculta/simplifica elementos listados en sección 20.
5. Ventas nuevas: `tasa_cambio_aplicada === tasa_bcv_aplicada`.
6. Cambio de modo no altera filas existentes en `ventas`.

### Comportamiento al cambiar de modo

| Dirección | Acción |
|-----------|--------|
| multimoneda → solo_bcv | Forzar USD=BCV; simplificar UI |
| solo_bcv → multimoneda | Pedir tasa USD nueva; histórico intacto |

---

## 20. Plan de implementación

### Fase 1 — Backend (3–5 días)

- [ ] `obtenerTasasActuales`: si `esSoloBcv`, devolver `tasa_usd = tasa_bcv`.
- [ ] `saveTasas` / `actualizarTasaBcvAutomatica`: forzar USD=BCV en solo BCV.
- [ ] Helper central: `resolverTasasOperativas(db)` usado por ventas, caja, reportes.
- [ ] `ventas.controller`: usar tasas operativas.
- [ ] Auditoría al PATCH `modo_moneda_operacion`.
- [ ] Validación caja cerrada antes de cambiar modo.
- [ ] `POST /api/setup/modo-moneda-inicial` en wizard.

### Fase 2 — Instalación y Configuración (2–3 días)

- [ ] Paso wizard con copy (sección 8.1 abajo).
- [ ] Selector en Config → Tasas + modal confirmación.
- [ ] Refrescar `nexus:tasas` tras cambio.

### Fase 3 — Frontend operativo (5–7 días)

- [ ] POS: ocultar cobro USD calle donde aplique; revisar mixtos.
- [ ] Inventario: default `moneda_costo = bcv`; ocultar USD físico opcional.
- [ ] Navbar: en solo BCV, ocultar segunda tasa o mostrar una sola línea.
- [ ] Caja, ventas, reportes: etiquetas coherentes.
- [ ] Config: ocultar input tasa USD.

### Fase 4 — Calidad (2–3 días)

- [ ] Tests: venta contado Bs, mixto, crédito, Cashea, devolución, cambio modo.
- [ ] Verificar migración 037 ya aplicada en BD existentes.

### Copy wizard

> **¿Cómo maneja tu negocio los precios y el cobro?**
>
> - **Multimoneda (BCV + USD)** — Tasa BCV oficial y tasa USD de mercado. Para quien cobra dólares físicos o usa dos tasas.
> - **Solo BCV** — Todo en referencia BCV y bolívares a tasa oficial. Más simple.

### UI — matriz de visibilidad

| Componente | multimoneda | solo_bcv |
|------------|-------------|----------|
| Input tasa USD (config) | Visible | Oculto |
| Navbar tasa USD | Visible | Oculto o = BCV |
| POS cobro USD físico | Sí | No |
| Inventario costo USD físico | Sí | Ocultar / default BCV |
| Inventario modo precio `usd` | Sí | Ocultar |
| Reporte columnas tasa USD | Sí | Opcional / oculto |

---

## 21. Índice de archivos por área

### Tasas y modo moneda

| Archivo | Rol |
|---------|-----|
| `backend/services/modoMonedaService.js` | Lectura/validación modo |
| `backend/services/preciosService.js` | Tasas, cadena precios, guardado |
| `backend/services/bcvTasaAutoService.js` | BCV automático |
| `backend/utils/bcvVigenciaVe.js` | Día hábil Caracas |
| `backend/utils/feriadosBcvVe.js` | Feriados Sudeban |
| `backend/controllers/configuracion.controller.js` | API tasas + PATCH modo |
| `database/migrations/007_historial_tasas.sql` | Historial diario |
| `database/migrations/035_nomenclatura_tasa_usd_sin_paralela.sql` | Rename paralela→usd |
| `database/migrations/037_total_bs_bcv_y_modo_moneda.sql` | Modo + total_bs_bcv_operativo |
| `frontend/components/navbar.js` | Display tasas + evento |
| `frontend/pages/configuracion/*` | UI tasas |
| `frontend/setup.html` | Wizard |

### Motor de precios (dual)

| Archivo | Rol |
|---------|-----|
| `backend/services/preciosService.js` | Motor servidor |
| `frontend/services/preciosClient.js` | Espejo navegador |

### Ventas y POS

| Archivo | Rol |
|---------|-----|
| `backend/controllers/ventas.controller.js` | Crear venta, validación |
| `frontend/pages/pos/pos.js` | UI caja registradora |
| `backend/utils/ventaTotalesBcv.js` | Totales BCV ticket |
| `database/migrations/029_ventas_total_ref_usd_bcv.sql` | Columna ref BCV |
| `database/migrations/030_ventas_tasa_bcv_aplicada.sql` | Tasa BCV por venta |

### Inventario

| Archivo | Rol |
|---------|-----|
| `frontend/pages/inventario/inventario.js` | UI precios/costos |
| `frontend/pages/inventario/inventario.html` | Formulario producto |
| `backend/controllers/productos.controller.js` | CRUD producto |
| `backend/controllers/inventario.controller.js` | Movimientos stock |
| `database/migrations/028_moneda_costo_producto.sql` | moneda_costo |

### Caja / Cashea / Cartera

| Archivo | Rol |
|---------|-----|
| `backend/controllers/caja.controller.js` | Sesiones, arqueo |
| `frontend/pages/caja/caja.js` | UI caja |
| `backend/services/casheaService.js` | Lógica Cashea |
| `frontend/pages/cashea/cashea.js` | UI Cashea |
| `backend/controllers/cartera.controller.js` | Cuentas por cobrar |
| `database/migrations/008_caja_schema_upgrade.sql` | Caja multimoneda |

### Infraestructura

| Archivo | Rol |
|---------|-----|
| `electron/main.js` | Proceso principal Electron |
| `electron/setupConfig.js` | Config PG userData |
| `backend/server.js` | Express, migraciones, CORS |
| `backend/config/migrations.js` | Runner parches 001–038 |
| `frontend/router.js` | SPA hash router |
| `frontend/services/authClient.js` | JWT cliente |

---

## 22. Criterios de aceptación y riesgos

### Definición de terminado

1. Modo elegible en instalación → persiste en `modo_moneda_operacion`.
2. Solo BCV: `tasa_usd === tasa_bcv` siempre en BD tras cualquier update.
3. Venta en solo BCV: totales POS = totales servidor sin depender solo del navbar.
4. Cambio de modo: admin + caja cerrada + auditoría + histórico intacto.
5. Multimoneda sin regresión.
6. Tests manuales/automáticos de flujos críticos pasan.

### Riesgos

| Riesgo | Severidad | Mitigación |
|--------|-----------|------------|
| Descuadre caja | Alta | Backend fuente de verdad; no publicar sin Fase 1 |
| Productos `moneda_costo=usd_fisico` al cambiar a solo BCV | Media | Aviso en modal; no reconvertir |
| Cambio con caja abierta | Alta | Bloquear en API |
| Divergencia preciosClient vs preciosService | Alta | Protocolo NEXUS-DUAL |
| Usuario confunde Cashea con API oficial | Baja | Copy comercial |

### Estimación

| Alcance | Tiempo |
|---------|--------|
| UI sola (NO recomendado) | 2–4 días |
| Operativo vendible | **2–3 semanas** |
| Pulido completo + reportes | 4–6 semanas |

---

## Apéndice A — Diagrama cadena de precios (multimoneda actual)

```
                    ┌─────────────────┐
                    │  costo_usd      │
                    │  (+ margen %)   │
                    └────────┬────────┘
                             │ × (1 + ganancia%)
                             ▼
                    ┌─────────────────┐
                    │ precio_usd      │  ← USD efectivo (tasa calle)
                    │ _efectivo       │
                    └────────┬────────┘
                             │ × tasa_usd
                             ▼
                    ┌─────────────────┐
                    │ bs_usd_equiv    │  ← Bs a tasa calle (redondeo 2 dec)
                    └────────┬────────┘
                             │ ÷ tasa_bcv (aritmética entera)
                             ▼
                    ┌─────────────────┐
                    │ precio_usd_bcv  │  ← Ref. $ BCV (ticket fiscal)
                    └────────┬────────┘
                             │ × tasa_bcv
                             ▼
                    ┌─────────────────┐
                    │ precio_bs       │  ← Bs a cobrar en mostrador
                    └─────────────────┘
```

**En solo BCV:** `tasa_usd = tasa_bcv` → los pasos intermedios se simplifican numéricamente.

---

## Apéndice B — Diagrama flujo venta POS → servidor

```
POS                          Backend (ventas.controller)
───                          ───────────────────────────
Carrito + tasas locales  →   obtenerTasasActuales()
Calcular totalUsd        →   Recalcula líneas (ignora precios cliente)
Calcular totalBsBcv      →   total_bs_bcv_operativo
Pagos[]                  →   sumaPagosEquivUsdCalle()
                             sumaPagosEquivBsBcvOperativo()
POST /api/ventas         →   INSERT ventas + detalle
                             Stock FOR UPDATE
                             Movimiento caja
                             Crédito / Cashea si aplica
```

---

## Apéndice C — Claves `configuracion` monetarias

| Clave | Categoría | Descripción |
|-------|-----------|-------------|
| `tasa_bcv` | moneda | Tasa BCV Bs/USD |
| `tasa_usd` | moneda | Tasa USD calle Bs/USD |
| `modo_moneda_operacion` | moneda | `multimoneda` \| `solo_bcv` |
| `tasa_bcv_auto_activo` | moneda | Toggle BCV auto |
| `tasa_bcv_feriados_ve` | moneda | JSON feriados |
| `impuesto_iva` | impuestos | % IVA ventas |
| `moneda_principal` | moneda | Legacy; reemplazado por modo_moneda |

---

*Fin del reporte maestro. Actualizar este documento cuando se complete cada fase de implementación.*
