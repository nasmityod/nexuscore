# Análisis completo — Nexus Core: arquitectura, módulos y modos de moneda

**Proyecto:** Nexus Core ERP/POS — escritorio Windows (Electron + Express + PostgreSQL)  
**Mercado:** Retail venezolano (bodegas, abastos, tiendas físicas)  
**Fecha del análisis:** 6 de junio de 2026  
**Alcance:** Arquitectura total del sistema, funcionamiento de **multimoneda** vs **solo BCV**, lógica de cálculo, capa visual, índice exhaustivo de archivos.

---

## Índice

1. [Resumen ejecutivo](#1-resumen-ejecutivo)
2. [Arquitectura de capas](#2-arquitectura-de-capas)
3. [Stack tecnológico](#3-stack-tecnológico)
4. [Nomenclatura monetaria (obligatoria)](#4-nomenclatura-monetaria-obligatoria)
5. [Los dos modos operativos](#5-los-dos-modos-operativos)
6. [Motor de precios — la calculadora central](#6-motor-de-precios--la-calculadora-central)
7. [Tasas de cambio y BCV automático](#7-tasas-de-cambio-y-bcv-automático)
8. [Flujo de datos: eventos y localStorage](#8-flujo-de-datos-eventos-y-localstorage)
9. [Identidad visual y CSS](#9-identidad-visual-y-css)
10. [Módulos del sistema (detalle por pantalla)](#10-módulos-del-sistema-detalle-por-pantalla)
11. [Backend — API, servicios y controladores](#11-backend--api-servicios-y-controladores)
12. [Base de datos — tablas y migraciones monetarias](#12-base-de-datos--tablas-y-migraciones-monetarias)
13. [Electron, setup y licencia](#13-electron-setup-y-licencia)
14. [Impresión, PDF y plantillas](#14-impresión-pdf-y-plantillas)
15. [Permisos y roles](#15-permisos-y-roles)
16. [Matriz comparativa multimoneda vs solo BCV](#16-matriz-comparativa-multimoneda-vs-solo-bcv)
17. [Índice maestro de archivos por área](#17-índice-maestro-de-archivos-por-área)
18. [Diagramas de flujo](#18-diagramas-de-flujo)
19. [Reglas de negocio inmutables](#19-reglas-de-negocio-inmutables)
20. [Estado de implementación y deuda conocida](#20-estado-de-implementación-y-deuda-conocida)
21. [Autenticación, sesión y seguridad](#21-autenticación-sesión-y-seguridad)
22. [Middleware del backend](#22-middleware-del-backend)
23. [Electron — IPC y ventanas](#23-electron--ipc-y-ventanas)
24. [Componentes y servicios frontend compartidos](#24-componentes-y-servicios-frontend-compartidos)
25. [Utilidades duales y helpers](#25-utilidades-duales-y-helpers)
26. [Descuento cobro divisa (migr. 041)](#26-descuento-cobro-divisa-migr-041)
27. [IVA, descuentos de línea y anulación](#27-iva-descuentos-de-línea-y-anulación)
28. [Ventas suspendidas e idempotencia](#28-ventas-suspendidas-e-idempotencia)
29. [Devoluciones](#29-devoluciones)
30. [Inventario, stock y alertas](#30-inventario-stock-y-alertas)
31. [Respaldo automático (pg_dump)](#31-respaldo-automático-pg_dump)
32. [Esquema BD completo y catálogo de migraciones](#32-esquema-bd-completo-y-catálogo-de-migraciones)
33. [PDF, tickets e impresión (detalle BCV)](#33-pdf-tickets-e-impresión-detalle-bcv)
34. [Pantallas fuera del SPA principal](#34-pantallas-fuera-del-spa-principal)
35. [Variables de entorno y build](#35-variables-de-entorno-y-build)
36. [Auditoría y logging](#36-auditoría-y-logging)
37. [Huecos detectados en la primera versión (checklist)](#37-huecos-detectados-en-la-primera-versión-checklist)

---

## 1. Resumen ejecutivo

### Qué es Nexus Core

ERP/POS de **escritorio Windows** para **un solo negocio físico** en Venezuela. Cada instalación = una base PostgreSQL local + una licencia vinculada al HWID de la máquina. No es SaaS multitenant.

### El eje del sistema: dos modos de moneda

| Modo | Clave en BD | Descripción |
|------|-------------|-------------|
| **Multimoneda** | `multimoneda` | Comportamiento completo: `tasa_bcv` (oficial) + `tasa_usd` (mercado/calle). Cobro en USD físico, Zelle, Bs, mixtos, descuento por cobro en divisa. |
| **Solo BCV** | `solo_bcv` | Una sola tasa operativa: `tasa_usd` forzada = `tasa_bcv`. UI simplificada, sin cobro USD calle, sin descuento divisa. |

### Principios arquitectónicos que no se negocian

1. **Backend = fuente de verdad** del modo y de las tasas operativas (`PreciosService.resolverTasasOperativas`).
2. **Cadena de precios de 4 pasos** duplicada en backend y frontend (protocolo NEXUS-DUAL).
3. **Dashboard y reportes operativos** muestran montos en **referencia USD BCV**, no en USD calle.
4. **Ventas históricas nunca se reconvierten** al cambiar de modo.
5. **Cambio de modo** solo con caja cerrada, permiso `tasas_edit`, y auditoría.

---

## 2. Arquitectura de capas

```
┌─────────────────────────────────────────────────────────────────┐
│  ELECTRON (electron/main.js, preload.js)                          │
│  - Ventana, splash, setup, activación, tema                     │
│  - IPC: HWID, PDF, impresora, rutas, config PG en userData      │
│  - Carga dotenv → inicia backend Express embebido en :3000        │
└───────────────────────────┬─────────────────────────────────────┘
                            │ http://127.0.0.1:3000
┌───────────────────────────▼─────────────────────────────────────┐
│  BACKEND Express (backend/server.js)                            │
│  - API REST /api/* con JWT + permisos por rol                   │
│  - pg-promise → PostgreSQL local                                │
│  - Migraciones 001–042 (parches incrementales idempotentes)     │
│  - Jobs: BCV automático (dolarapi), respaldo pg_dump            │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│  FRONTEND SPA (frontend/)                                       │
│  - index.html + router.js (hash #/ruta)                         │
│  - Páginas: frontend/pages/[modulo]/[modulo].html + .js         │
│  - Componentes: navbar, sidebar, toast, currencyDisplay         │
│  - preciosClient.js (espejo del motor de precios backend)       │
│  - localStorage: JWT, tasas, modo moneda                        │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│  PostgreSQL                                                     │
│  - configuracion (clave/valor) — modo, tasas, IVA, Cashea…      │
│  - Operativo: productos, ventas, caja, clientes, compras, CXP   │
└─────────────────────────────────────────────────────────────────┘
```

### Arranque de la aplicación

1. Usuario abre `Nexus Core.exe` (Electron).
2. Si no hay configuración PG en `userData` → `frontend/setup.html` (wizard 5 pasos).
3. Si licencia inválida → `frontend/activation.html`.
4. App principal → `frontend/index.html` → login → módulos vía hash router.
5. Al montar chrome: `navbar.hydrateTasasDesdeServidorSilent()` sincroniza tasas y modo.

---

## 3. Stack tecnológico

| Capa | Tecnología |
|------|------------|
| Desktop | Electron 36, Windows x64 (NSIS + portable) |
| Backend | Node 18+, Express 4, pg-promise, winston |
| Frontend | Vanilla JS, HTML parcial por ruta, CSS custom (sin framework UI) |
| BD | PostgreSQL 12+ |
| Auth | JWT (bcrypt passwords) |
| Licencia | Ed25519 offline + servidor Vercel (`license-server/`) |
| Excel | exceljs |
| PDF | jspdf + plantillas HTML en `resources/templates/` |
| Impresora térmica | node-thermal-printer (TCP 9100) |
| Gráficos | chart.js 3.9 (dashboard) |

---

## 4. Nomenclatura monetaria (obligatoria)

En Venezuela el sistema maneja **tres referencias** que no deben confundirse:

| Término en código/UI | Campo típico | Significado |
|---------------------|--------------|-------------|
| **USD efectivo** / USD calle | `precio_usd_efectivo`, `total_usd` | Dólares físicos de mercado (tasa calle) |
| **USD BCV** / ref. BCV | `precio_usd_bcv`, `total_ref_usd_bcv` | Referencia en dólares cadena BCV (fiscal/oficial) |
| **Bs BCV** / Bs cobrar | `precio_bs`, `total_bs_bcv_operativo` | Bolívares a cobrar en mostrador (tasa BCV) |

### Las dos tasas (siempre en Bs por 1 USD)

| Clave `configuracion` | Nombre UI | Origen |
|----------------------|-----------|--------|
| `tasa_bcv` | Tasa BCV / USD BCV | Manual o automática (dolarapi + feriados VE) |
| `tasa_usd` | Tasa USD / USD Mercado | **Siempre manual** (botón Guardar tasas). Antes `tasa_paralela` (migr. 035). |

En **solo BCV**: ambas tasas son **idénticas** en lectura y escritura.

---

## 5. Los dos modos operativos

### 5.1 Persistencia y lectura del modo

**Archivo central:** `backend/services/modoMonedaService.js`

```javascript
CLAVE_MODO = 'modo_moneda_operacion'
MODOS_VALIDOS = ['multimoneda', 'solo_bcv']
leerModo(db)        // default 'multimoneda' si falta o es inválido
esSoloBcv(modo)     // modo === 'solo_bcv'
```

**Seed BD:** migración `037_total_bs_bcv_y_modo_moneda.sql` inserta `multimoneda` por defecto.

**Frontend:** `localStorage.nexus_modo_moneda` sincronizado por `navbar.js` desde `GET /api/configuracion/tasas-actuales`.

### 5.2 Punto único de entrada — tasas operativas

**Backend:** `PreciosService.resolverTasasOperativas(db)` en `backend/services/preciosService.js`

1. Llama `obtenerTasasActuales(db)` (lectura cruda de BD + historial BCV + feriados).
2. Lee modo con `ModoMonedaService.leerModo(db)`.
3. Si `solo_bcv` → fuerza `tasas.tasa_usd = tasas.bcv`.
4. Retorna `{ bcv, tasa_bcv, tasa_usd, modo_moneda_operacion, ... }`.

**Frontend (NEXUS-DUAL):** `PreciosServiceClient.resolverTasasOperativas(tasas)` en `frontend/services/preciosClient.js` — lee modo de `localStorage` y unifica USD=BCV.

**Chokepoint práctico del frontend:** `NexusComponents.loadTasasLocal()` en `navbar.js` ya aplica la unificación antes de que POS/inventario calculen.

### 5.3 Escritura de tasas (doble defensa)

En **solo BCV**, al guardar tasas (manual, BCV auto, apertura de caja):

- `PreciosService.actualizarTasas` → fuerza `usd_4d = bcv_4d`
- `PreciosService.actualizarTasaBcvAutomatica` → mismo forzado
- `setupAdminService.guardarModoMonedaInicial` → unifica al elegir solo_bcv en wizard

### 5.4 Cambio de modo en runtime

**Endpoint:** `PATCH /api/configuracion/modo-moneda`  
**Controlador:** `configuracion.controller.patchModoMoneda`  
**Permiso:** `tasas_edit`  
**Reglas:**
- 409 si hay caja abierta
- `multimoneda → solo_bcv`: unifica USD=BCV inmediatamente
- `solo_bcv → multimoneda`: pide nueva tasa USD en modal
- Auditoría: `CAMBIAR_MODO_MONEDA`
- El PATCH genérico `/api/configuracion` **ya no** acepta el modo (evita bypass)

**UI:** `frontend/pages/configuracion/configuracion.js` → selector `#cfg-modo-moneda` + modal confirmación.

### 5.5 Mecanismo visual global en solo BCV

| Mecanismo | Archivo | Comportamiento |
|-----------|---------|----------------|
| `body.nexus-solo-bcv` | `navbar.js` → `applyModoMonedaBodyClass()` | Clase en `<body>` reactiva al modo |
| `.nexus-usd-only { display: none }` | `frontend/assets/css/components.css` | Oculta elementos USD calle redundantes |
| Evento `nexus:modo-moneda` | `navbar.js` | Notifica cambio de modo a POS, inventario, etc. |
| Evento `nexus:tasas` | `navbar.js` | Notifica cambio de tasas operativas |

---

## 6. Motor de precios — la calculadora central

### 6.1 Archivos duales (obligatorio mantener sincronizados)

| Backend | Frontend |
|---------|----------|
| `backend/services/preciosService.js` | `frontend/services/preciosClient.js` |

### 6.2 Cadena de 4 pasos (idéntica en ambas capas)

```
costo_usd + margen%
        │
        ▼
precio_usd_efectivo  (2 dec)     ← USD calle
        │ × tasa_usd
        ▼
bs_usd_equiv  (2 dec)            ← Bs a tasa calle
        │ ÷ tasa_bcv (aritmética entera, tasa a 4 dec)
        ▼
precio_usd_bcv  (2 dec)          ← Ref. $ BCV (ticket fiscal)
        │ × tasa_bcv
        ▼
precio_bs  (2 dec)               ← Bs a cobrar en mostrador
```

**En solo BCV** (`tasa_usd = tasa_bcv`): los pasos 2–4 colapsan numéricamente (el USD efectivo y el ref. BCV coinciden en la práctica del ticket).

### 6.3 Funciones principales del motor

| Función | Propósito |
|---------|-----------|
| `redondearTasa4(valor)` | Tasas a 4 decimales |
| `assertTasasPositivas(bcv, usd)` | Validación > 0 |
| `calcularPrecios(costoUsd, gananciaPct, tasaBcv, tasaUsd)` | Cadena completa desde costo + margen |
| `aplicarCadenaPorPrecioEfectivo(pe, tasaBcv, tasaUsd, opcs)` | Pasos 2–4 desde USD efectivo fijo |
| `precioBolivaresRefBcvDesdeBsUsd(bsUsdEquiv, tasaBcv)` | Paso 3–4 con aritmética entera |
| `totalBolivaresDesdeRefUsdBcv(usdBcvTotal, tasaBcv)` | Total Bs del ticket desde ref. $ BCV |
| `precioManualUsdDesdeBcvObjetivo(objetivo, …)` | Inverso: USD manual para hit $BCV |
| `gananciaPctDesdePrecioUsdBcvObjetivo(…)` | Búsqueda binaria de margen |
| `costoUsdDesdeCostoBcv(costoBcv, tasaBcv, tasaUsd)` | Conversión costo BCV → USD efectivo |
| `sumaPagosEquivUsdCalle(pagos, tasas)` | Suma pagos en equivalente USD calle |
| `sumaPagosEquivBsBcvOperativo(pagos, tasas, totalBs)` | Validación cobro en cadena BCV |
| `resolverTotalUsdCobro(totalRefBcv, pct)` | Descuento cobro divisa (solo multimoneda) |
| `resolverTasasOperativas(…)` | Unificación por modo |

### 6.4 Precisión y redondeo

| Concepto | Decimales |
|----------|-----------|
| Tasas BCV/USD | 4 |
| Costo producto | 4 |
| Margen % | 2 |
| Precio USD efectivo | 2 (manual: 4 opcional) |
| Bs/USD equiv | 2 |
| Ref. $ BCV y Bs cobrar | 2 |

---

## 7. Tasas de cambio y BCV automático

### 7.1 Lectura de tasas (`obtenerTasasActuales`)

**Archivo:** `backend/services/preciosService.js`

1. Lee `configuracion.tasa_usd` (calle, manual).
2. BCV vía `leerTasaBcvVigenteLegal` → `historial_tasas` + día hábil Caracas.
3. Utilidades: `backend/utils/bcvVigenciaVe.js`, `backend/utils/feriadosBcvVe.js`.
4. Retorna metadatos: `dia_habil_referencia`, `congelada_por_no_habil`, etc.

### 7.2 BCV automático

**Archivo:** `backend/services/bcvTasaAutoService.js`

- Consulta dolarapi (oficial BCV).
- Aplica a medianoche o manualmente desde Configuración.
- En solo_bcv: al subir BCV, `tasa_usd` queda igual (vía `actualizarTasaBcvAutomatica`).
- Config keys: `tasa_bcv_auto_activo`, `tasa_bcv_auto_ultima_sincronizacion`, etc.

### 7.3 Navbar — display de tasas

**Archivo:** `frontend/components/navbar.js`

| Modo | Navbar muestra |
|------|----------------|
| Multimoneda | Tasa BCV + Tasa USD Mercado (`.nexus-usd-only` visible en mercado) |
| Solo BCV | Solo tasa BCV (mercado oculta con CSS) |

**Hydrate:** `GET /api/configuracion/tasas-actuales` → persiste localStorage → dispara eventos.

---

## 8. Flujo de datos: eventos y localStorage

### 8.1 Claves localStorage

| Clave | Contenido |
|-------|-----------|
| `nexus_tasa_bcv` | Tasa BCV operativa |
| `nexus_tasa_usd` | Tasa USD operativa (en solo_bcv = BCV) |
| `nexus_modo_moneda` | `multimoneda` \| `solo_bcv` |
| JWT / sesión | `authClient.js` |

### 8.2 Eventos custom del renderer

| Evento | Emisor | Consumidores |
|--------|--------|--------------|
| `nexus:tasas` | navbar | POS, inventario, configuración |
| `nexus:modo-moneda` | navbar | POS (cobro), inventario (tabs) |
| `nexus:route` | router | sidebar activo |
| `nexus:session` | authClient | chrome, permisos |

### 8.3 Diagrama del chokepoint de modo

```
Configuración (PATCH modo-moneda)
        │
        ▼
GET /api/configuracion/tasas-actuales
        │
        ▼
navbar.hydrateTasasDesdeServidorSilent()
        ├── localStorage (modo + tasas)
        ├── body.nexus-solo-bcv
        ├── nexus:tasas
        └── nexus:modo-moneda
                │
    ┌───────────┼───────────┐
    ▼           ▼           ▼
  POS      Inventario    Caja
loadTasasLocal() en cada módulo
```

---

## 9. Identidad visual y CSS

### 9.1 Orden de carga CSS (`index.html`)

1. `frontend/assets/css/variables.css` — tokens de diseño
2. Script anti-FOUC de tema (`data-theme` dark/light)
3. `base.css` — reset, gradientes radiales del body
4. `components.css` — chrome, botones, tablas, **regla solo_bcv**
5. `pages.css` — estilos por módulo
6. `animations.css` — transiciones de vista
7. `pos.css` — POS específico

### 9.2 Tokens críticos (`variables.css`)

| Token | Valor | Uso |
|-------|-------|-----|
| `--accent-primary` | `#f0a500` | Ámbar financiero — acento único |
| `--font-ui` | Sora | Texto general |
| `--font-display` | Barlow Condensed | Títulos, marca |
| `--font-mono` | DM Mono | **Todo valor numérico** (montos, tasas, facturas, stock) |
| `--radius-lg` | 10px máx | Cards (instrumento financiero, no app móvil) |

### 9.3 Reglas visuales del modo moneda

```css
/* components.css */
body.nexus-solo-bcv .nexus-usd-only {
  display: none !important;
}
```

**Elementos con `.nexus-usd-only`:** tasa USD mercado en navbar, cobro USD/Zelle en POS, preview USD en inventario, cuadre USD en caja, descuento divisa en configuración, etc.

### 9.4 Display BCV en navbar

- Fuente: `var(--font-mono)`
- Color: `var(--accent-primary)` sólido (sin neon/glow)
- Fondo: `var(--accent-primary-bg)`
- Borde: `var(--border-accent)`

---

## 10. Módulos del sistema (detalle por pantalla)

### 10.1 Router y permisos

**Archivo:** `frontend/router.js`

| Ruta hash | Módulo | Permiso mínimo |
|-----------|--------|----------------|
| `#/dashboard` | Dashboard | `dashboard` |
| `#/pos` | Punto de venta | `pos_sales` |
| `#/inventario` | Inventario | `inventario_ver` |
| `#/ventas` | Ventas | `ventas_ver` |
| `#/clientes` | Clientes | `clientes_ver` |
| `#/cartera` | Cartera / Cobrar | `clientes_ver` |
| `#/proveedores` | Proveedores | `proveedores_all` |
| `#/caja` | Caja | `caja_operar` |
| `#/compras` | Compras | `compras_all` |
| `#/cuentas_pagar` | Cuentas por Pagar | `cuentas_pagar_all` |
| `#/reportes` | Reportes | `reportes_all` |
| `#/configuracion` | Configuración | `config_read` |
| `#/usuarios` | Usuarios | `usuarios_all` |
| `#/cashea` | Cashea | `pos_sales` |

**Sidebar:** `frontend/components/sidebar.js` — misma matriz `ROUTE_PERM`.

---

### 10.2 POS — `frontend/pages/pos/`

**Archivos:** `pos.html`, `pos.js` (~3000+ líneas), `pos.css`

#### Métodos de cobro (`COBRO_METODOS`)

| Clave | Label | Moneda | Multimoneda | Solo BCV |
|-------|-------|--------|-------------|----------|
| `efectivo_usd` | Efectivo USD | USD | ✅ | ❌ oculto |
| `efectivo_bs` | Efectivo Bs | BS | ✅ | ✅ |
| `transferencia_bs` | Transferencia Bs | BS | ✅ | ✅ |
| `pago_movil` | Pago Móvil | BS | ✅ | ✅ |
| `zelle` | Zelle | USD | ✅ | ❌ oculto |
| `punto` | Punto De Venta | BS | ✅ | ✅ |
| `credito` | Crédito | USD_BCV | ✅ | ✅ |
| `cashea` | Cashea | USD | ✅ | ✅ (en ref. BCV) |

#### Funciones clave

| Función | Rol |
|---------|-----|
| `getTasas()` | Lee `loadTasasLocal()` — sin defaults hardcodeados |
| `syncPreciosServidorHydrateThenRefresh()` | Hydrate obligatorio al montar |
| `metodoCobroVisible(metodo)` | Filtra USD calle en solo_bcv |
| `renderCobroTabla()` | Tabla de métodos; reacciona a `nexus:modo-moneda` |
| `paidBsBcv()` | Suma pagos en Bs cadena BCV |
| `totalUsdCobroEfectivo()` | Total USD con descuento divisa (multimoneda) |
| `cobroAplicaDescuentoDivisa()` | false en solo_bcv |
| `refUsdBcvDesdeBsCobrar()` | Conversión inversa para validación |

#### Display del carrito

- **Primario:** Bs cobrar (BCV) + Ref. USD BCV
- **Oculto en solo_bcv:** marquee USD efectivo, banner verde USD, tasa calle en pie de cobro

#### Backend al vender

**Archivo:** `backend/controllers/ventas.controller.js` → `create()`

1. `resolverTasasOperativas(t)` dentro de transacción.
2. Rechaza `efectivo_usd`/`zelle` en solo_bcv (400).
3. Recalcula líneas en servidor (ignora precios del cliente).
4. Persiste: `total_usd`, `total_ref_usd_bcv`, `total_bs_bcv_operativo`, tasas aplicadas.
5. Descuento divisa (migr. 041): solo multimoneda + 100% USD/Zelle.
6. Valida pagos: `sumaPagosEquivUsdCalle` y/o `sumaPagosEquivBsBcvOperativo`.

---

### 10.3 Inventario — `frontend/pages/inventario/`

**Archivos:** `inventario.html`, `inventario.js`

#### Modos de costo (`state.modoMonedaCosto`)

| Modo | Entrada | Conversión |
|------|---------|------------|
| `usd_fisico` | Costo en USD calle | → ref. BCV vía cadena |
| `bcv` | Costo en $ BCV directo | → USD efectivo vía `costoUsdDesdeCostoBcv` |

**Solo BCV:** oculta tab `usd_fisico`; default `bcv`.

#### Modos de precio (`state.modoPrecios`)

| Modo | Comportamiento |
|------|----------------|
| `margen` | % ganancia → `calcularPrecios()` |
| `bcv` | Target $ BCV → búsqueda de margen / precio manual |
| `usd` | Target USD físico final |
| `usd_objetivo` | USD a recibir con descuento divisa (solo multimoneda) |

**Solo BCV:** oculta `usd` y `usd_objetivo`; preview divisa oculto.

#### Backend

- `backend/controllers/productos.controller.js` — CRUD producto, campos `moneda_costo`, `precio_manual_usd`
- `backend/controllers/inventario.controller.js` — ajustes, valorizado
- Migración `028_moneda_costo_producto.sql` — columna `moneda_costo`

---

### 10.4 Ventas — `frontend/pages/ventas/`

**Archivos:** `ventas.html`, `ventas.js`

| Función | Rol |
|---------|-----|
| `textoMontoListaVenta(v)` | Lista: USD calle o $ BCV según método |
| `lineaMontosBcvRef(d, venta, sum)` | Detalle líneas proporcional a header ref BCV |
| `ventaUsdRedundante` | Oculta Tasa/Total USD si tasas aplicadas iguales |

**Solo BCV:** devoluciones ocultan reembolso `efectivo_usd`.

**Backend:** `ventas.controller.js` — `list`, `getById`, `anular`; enriquece con `total_ref_usd_bcv`.

---

### 10.5 Caja — `frontend/pages/caja/`

**Archivos:** `caja.html`, `caja.js`  
**Backend:** `backend/controllers/caja.controller.js`

| Operación | Lógica monetaria |
|-----------|------------------|
| Apertura | Snapshot tasas vía `resolverTasasOperativas` |
| Operación | Totales sistema en **ref. $ BCV** (`total_ref_usd_bcv_vendido`) |
| Cierre | Cuadre Bs + (USD solo multimoneda) |

**Solo BCV:** oculta campos USD apertura/cierre; ignora tolerancia USD en botón cerrar.

---

### 10.6 Dashboard — `frontend/pages/dashboard/`

**Archivos:** `dashboard.html`, `dashboard.js`  
**Backend:** `backend/services/dashboardService.js`

- **Todos los KPIs en ref. $ BCV:** `ventas_hoy_bcv`, `ticket_promedio_bcv`, etc.
- SQL canónico: `COALESCE(v.total_ref_usd_bcv, v.total_usd)`
- Banda Bs: `ventas_hoy_bcv × tasa_bcv_usada`
- Gráficos Chart.js: eje Y en `$ BCV`
- Cashea: comisiones y ganancia en BCV
- **Sin branching por modo** — backend ya normaliza

---

### 10.7 Reportes — `frontend/pages/reportes/`

**Archivos:** `reportes.html`, `reportes.js`  
**Backend:** `backend/services/reportesService.js`, `reportes.controller.js`

| Reporte | Moneda mostrada |
|---------|-----------------|
| Ventas día/período/rango | `total_bcv` = COALESCE ref BCV |
| Top productos | Subtotales escalados a BCV |
| Inventario valorizado | `costo_total_bcv_ref`, `valor_venta_total_bcv_ref` |
| Cashea liquidaciones | Ref BCV + Bs depósito |
| Historial tasas | Columna USD (en solo_bcv nuevas filas USD=BCV) |
| Analytics dashboard (`/analytics/dashboard`) | **USD efectivo** (excepción — margen operativo) |

---

### 10.8 Configuración — `frontend/pages/configuracion/`

**Archivos:** `configuracion.html`, `configuracion.js` (~1600 líneas)

#### Pestañas principales

| Pestaña | Contenido monetario relevante |
|---------|------------------------------|
| Tasas | Modo moneda, tasa BCV, tasa USD, BCV auto, descuento divisa |
| Empresa | Datos fiscales, IVA |
| Impresora / Respaldo / Licencia | No monetario |

#### Funciones modo

| Función | Rol |
|---------|-----|
| `aplicarVisibilidadModo(modo)` | UI + `setModoMoneda()` |
| `onCambioSelectorModo()` | Modal confirmación |
| `enviarCambioModo(modo, tasaUsd)` | PATCH modo-moneda |
| `guardarTasas()` | En solo_bcv envía BCV para ambas |

---

### 10.9 Cartera — `frontend/pages/cartera/`

**Archivos:** `cartera.html`, `cartera.js`  
**Backend:** `backend/controllers/cartera.controller.js`, `creditoAbonoService.js`

- Deudas y abonos en **$ BCV reference** (`fBcv`, `celdaMonto`)
- `calcularEquivAbono()` — Bs → ref BCV vía tasa BCV
- **Decisión conservadora:** abonos USD/Zelle siguen disponibles en solo_bcv (crédito puede pagarse en divisa)

---

### 10.10 Clientes — `frontend/pages/clientes/`

**Archivos:** `clientes.html`, `clientes.js`

- Perfil, límite crédito, historial pagos
- Métodos abono similares a cartera
- Límite crédito validado en ventas: convierte BCV→USD efectivo para comparar

---

### 10.11 Cashea — `frontend/pages/cashea/`

**Archivos:** `cashea.html`, `cashea.js`  
**Backend:** `backend/services/casheaService.js`

- Cuotas base: `bs_bcv_cadena` / `usd_bcv_ref`
- Comisiones oficiales (migr. 033)
- Liquidaciones en ref BCV + Bs (reportes)
- **Regla BCV:** dashboard y Cashea en dólares BCV

---

### 10.12 Compras — `frontend/pages/compras/`

**Archivos:** `compras.html`, `compras.js`  
**Backend:** `backend/routes/compras.routes.js`

- Órdenes de compra, recibir mercancía
- Integración con **Cuentas por Pagar** al recibir
- Montos según tasas operativas del momento

---

### 10.13 Cuentas por Pagar — `frontend/pages/cuentas_pagar/`

**Archivos:** `cuentas_pagar.html`, `cuentas_pagar.js`  
**Backend:** `cuentasPagarService.js`, `cuentasPagar.controller.js`  
**Migración:** `039_cuentas_pagar.sql`, `040_cuentas_pagar_permiso_roles.sql`

- CXP proveedores, abonos, anulación
- Usa `resolverTasasOperativas` para montos
- UI con clase `nexus-usd-only` donde aplica USD calle

---

### 10.14 Proveedores — `frontend/pages/proveedores/`

CRUD proveedores — sin lógica monetaria directa; alimenta compras y CXP.

---

### 10.15 Usuarios — `frontend/pages/usuarios/`

Roles, permisos override (migr. 025), passwords. Permiso `tasas_edit` controla cambio de modo.

---

### 10.16 Devoluciones

**Backend:** `backend/controllers/devoluciones.controller.js`, `utils/devolucionesSaldo.js`  
- Montos BCV vía `lineaMontosBcvRef` de `ventaTotalesBcv.js`

---

## 11. Backend — API, servicios y controladores

### 11.1 Montaje en `server.js`

| Prefijo | Archivo rutas |
|---------|---------------|
| `/api/auth` | `auth.routes.js` |
| `/api/licencia` | `licencia.routes.js` |
| `/api/setup` | `setup.routes.js` |
| `/api/productos` | `productos.routes.js` |
| `/api/ventas` | `ventas.routes.js` |
| `/api/inventario` | `inventario.routes.js` |
| `/api/clientes` | `clientes.routes.js` (+ cartera nested) |
| `/api/caja` | `caja.routes.js` |
| `/api/reportes` | `reportes.routes.js` |
| `/api/configuracion` | `configuracion.routes.js` |
| `/api/dashboard` | `dashboard.routes.js` |
| `/api/pdf` | `pdf.routes.js` |
| `/api/compras` | `compras.routes.js` |
| `/api/cashea` | `cashea.routes.js` |
| `/api/devoluciones` | `devoluciones.routes.js` |
| `/api/cuentas-pagar` | `cuentasPagar.routes.js` |
| `/api/usuarios` | `usuarios.routes.js` |
| `/api/proveedores` | `proveedores.routes.js` |

### 11.2 Servicios monetarios (mapa completo)

| Servicio | Responsabilidad |
|----------|-----------------|
| `preciosService.js` | Motor precios, tasas, pagos, descuento divisa |
| `modoMonedaService.js` | Lectura modo |
| `bcvTasaAutoService.js` | Sync BCV dolarapi |
| `dashboardService.js` | KPIs BCV-first |
| `reportesService.js` | Reportes + Excel BCV |
| `excelService.js` | Exportaciones con tasas operativas |
| `pdfService.js` | PDF ticket/factura |
| `impresionService.js` | Térmica |
| `casheaService.js` | Cashea BCV |
| `creditoAbonoService.js` | Abonos cartera BCV |
| `cuentasPagarService.js` | CXP |
| `setupAdminService.js` | Wizard inicial + modo moneda |
| `importProductosService.js` | Import XLSX precios |

### 11.3 Utilidades monetarias

| Utilidad | Rol |
|----------|-----|
| `ventaTotalesBcv.js` | Totales ticket BCV + líneas |
| `bcvVigenciaVe.js` | Día hábil Caracas |
| `feriadosBcvVe.js` | Calendario feriados |
| `devolucionesSaldo.js` | Montos devolución BCV |
| `formatters.js` | Formato moneda servidor |

### 11.4 Middleware estándar

- `requireAuth` — JWT
- `requirePermission(clave)` — matriz roles
- `cajaAbierta` — ventas POS
- `asyncHandler` — obligatorio en rutas async
- `audit.middleware` — cambios sensibles (modo moneda, tasas)

---

## 12. Base de datos — tablas y migraciones monetarias

### 12.1 Tabla `configuracion` — claves monetarias

| Clave | Categoría | Descripción |
|-------|-----------|-------------|
| `tasa_bcv` | moneda | Bs/USD BCV |
| `tasa_usd` | moneda | Bs/USD mercado |
| `modo_moneda_operacion` | moneda | `multimoneda` \| `solo_bcv` |
| `tasa_bcv_auto_activo` | moneda | Toggle auto |
| `tasa_bcv_feriados_ve` | moneda | JSON feriados |
| `descuento_cobro_divisa_activo` | ventas | Toggle descuento (migr. 041) |
| `descuento_cobro_divisa_pct` | ventas | % descuento 0–100 |
| `impuesto_iva` | impuestos | % IVA |

### 12.2 Tabla `ventas` — columnas monetarias clave

| Columna | Migración | Significado |
|---------|-----------|-------------|
| `total_usd` | base | USD efectivo cobrado (puede tener descuento divisa) |
| `total_ref_usd_bcv` | 029 | Ref. $ BCV header |
| `total_bs` | base | Bs ticket (= BCV operativo) |
| `total_bs_bcv_operativo` | 037 | Bs cadena BCV explícito |
| `tasa_cambio_aplicada` | 030 | Tasa USD calle al vender |
| `tasa_bcv_aplicada` | 030 | Tasa BCV al vender |
| `descuento_divisa_pct` | 041 | % si aplicó descuento |
| `descuento_divisa_monto_usd` | 041 | Diferencia ref − cobrado USD |

### 12.3 Otras tablas relevantes

| Tabla | Campos monetarios |
|-------|-------------------|
| `productos` | `costo_usd`, `precio_usd_efectivo`, `precio_usd_bcv`, `precio_bs`, `moneda_costo`, `precio_manual_usd` |
| `historial_tasas` | `tasa_bcv`, `tasa_usd`, fecha |
| `sesiones_caja` | snapshot tasas apertura/cierre |
| `cuentas_cobrar` | `monto_usd_bcv`, tasas pactadas |
| `pagos_venta` | método, monto, moneda |
| `cuentas_pagar` | montos proveedor |

### 12.4 Migraciones monetarias (orden)

| # | Archivo | Qué hace |
|---|---------|----------|
| 007 | `historial_tasas.sql` | Historial diario tasas |
| 028 | `moneda_costo_producto.sql` | `productos.moneda_costo` |
| 029 | `ventas_total_ref_usd_bcv.sql` | Columna ref BCV |
| 030 | `ventas_tasa_bcv_aplicada.sql` | Tasa BCV por venta |
| 035 | `nomenclatura_tasa_usd_sin_paralela.sql` | Rename paralela→usd |
| 037 | `total_bs_bcv_y_modo_moneda.sql` | `total_bs_bcv_operativo` + modo |
| 041 | `descuento_cobro_divisa.sql` | Descuento + columnas venta |

**Runner:** `backend/config/migrations.js` — parches idempotentes post-bootstrap 001–005.

---

## 13. Electron, setup y licencia

### 13.1 Archivos Electron

| Archivo | Rol |
|---------|-----|
| `electron/main.js` | Proceso principal, ventanas, IPC, startBackend |
| `electron/preload.js` | contextBridge canales seguros |
| `electron/setupConfig.js` | Config PG en userData |
| `electron/themePreference.js` | Tema dark/light |

### 13.2 Wizard setup (`frontend/setup.html`)

| Paso | Contenido |
|------|-----------|
| 1 | Conexión PostgreSQL |
| 2 | Activación licencia (HWID) |
| 3 | Admin inicial |
| 4 | **Modo moneda** — `POST /api/setup/modo-moneda-inicial` |
| 5 | Empresa + Cashea inicial |

Default: **Multimoneda**. Renovación licencia sin admin pendiente salta paso 4.

### 13.3 Licencia

- `backend/routes/licencia.routes.js`
- Clave pública Ed25519 (`NEXUS_LICENSE_PUBLIC_KEY`)
- `frontend/activation.html` para reactivación

---

## 14. Impresión, PDF y plantillas

| Archivo | Rol |
|---------|-----|
| `resources/templates/ticket_venta.html` | Ticket POS |
| `resources/templates/nota_entrega.html` | Nota entrega |
| `resources/templates/factura.html` | Factura |
| `backend/services/pdfService.js` | Render PDF |
| `backend/routes/pdf.routes.js` | Endpoints ticket/nota/factura |
| `frontend/services/printFormatters.js` | Formato impresión cliente |

**Totales BCV en ticket:** `backend/utils/ventaTotalesBcv.js` → `resolveTotalesBcvTicket`, `lineaMontosBcvRef`.

---

## 15. Permisos y roles

**Archivo:** `backend/constants/rolePermissions.js` + BD `roles.permisos` (migr. 009, 023, 025)

| Permiso | Relación con modos |
|---------|-------------------|
| `tasas_ver` | Ver tasas en navbar/config |
| `tasas_edit` | Guardar tasas + **cambiar modo moneda** |
| `pos_sales` | POS y Cashea |
| `caja_operar` | Apertura/cierre (bloquea cambio modo si abierta) |
| `config_read` | Entrar a configuración |
| `reportes_all` | Reportes BCV |

---

## 16. Matriz comparativa multimoneda vs solo BCV

| Área | Multimoneda | Solo BCV |
|------|-------------|----------|
| **Tasas en BD** | `tasa_usd ≠ tasa_bcv` (típico) | `tasa_usd = tasa_bcv` siempre |
| **Navbar** | BCV + USD Mercado | Solo BCV |
| **Config — input USD** | Visible | Oculto |
| **Config — descuento divisa** | Configurable (migr. 041) | Oculto / desactivado |
| **POS — Efectivo USD / Zelle** | Visible | Oculto + rechazado API |
| **POS — default método** | `efectivo_usd` | `efectivo_bs` |
| **POS — descuento divisa** | Si 100% USD/Zelle | Nunca |
| **Inventario — costo USD físico** | Tab visible | Oculto, default BCV |
| **Inventario — precio modo USD** | Visible | Oculto |
| **Caja — cuadre USD** | Requerido | Ignorado en UI |
| **Ventas detalle — USD calle** | Si tasas distintas | Oculto si tasas iguales |
| **Dashboard / reportes** | Ref. $ BCV | Ref. $ BCV (igual) |
| **Cartera — abono USD** | Disponible | Disponible (conservador) |
| **Venta nueva tasas** | `tasa_cambio ≠ tasa_bcv` típico | `tasa_cambio = tasa_bcv` |
| **Histórico al cambiar modo** | Intacto | Intacto |

---

## 17. Índice maestro de archivos por área

### Modo moneda y tasas

```
backend/services/modoMonedaService.js
backend/services/preciosService.js          ← resolverTasasOperativas, motor
backend/services/bcvTasaAutoService.js
backend/utils/bcvVigenciaVe.js
backend/utils/feriadosBcvVe.js
backend/controllers/configuracion.controller.js
backend/routes/configuracion.routes.js
backend/services/setupAdminService.js
backend/routes/setup.routes.js
database/migrations/037_total_bs_bcv_y_modo_moneda.sql
frontend/components/navbar.js
frontend/services/preciosClient.js
frontend/pages/configuracion/configuracion.js
frontend/pages/configuracion/configuracion.html
frontend/setup.html
frontend/assets/css/components.css            ← body.nexus-solo-bcv
```

### Motor de precios dual

```
backend/services/preciosService.js
frontend/services/preciosClient.js
```

### Ventas y POS

```
backend/controllers/ventas.controller.js
backend/routes/ventas.routes.js
backend/utils/ventaTotalesBcv.js
frontend/pages/pos/pos.js
frontend/pages/pos/pos.html
frontend/pages/pos/pos.css
frontend/pages/ventas/ventas.js
frontend/pages/ventas/ventas.html
database/migrations/029_ventas_total_ref_usd_bcv.sql
database/migrations/030_ventas_tasa_bcv_aplicada.sql
database/migrations/041_descuento_cobro_divisa.sql
```

### Inventario y productos

```
frontend/pages/inventario/inventario.js
frontend/pages/inventario/inventario.html
backend/controllers/productos.controller.js
backend/controllers/inventario.controller.js
backend/services/importProductosService.js
database/migrations/028_moneda_costo_producto.sql
```

### Caja

```
backend/controllers/caja.controller.js
backend/routes/caja.routes.js
frontend/pages/caja/caja.js
frontend/pages/caja/caja.html
database/migrations/008_caja_schema_upgrade.sql
```

### Dashboard y reportes

```
backend/services/dashboardService.js
backend/routes/dashboard.routes.js
backend/services/reportesService.js
backend/controllers/reportes.controller.js
backend/routes/reportes.routes.js
backend/services/excelService.js
frontend/pages/dashboard/dashboard.js
frontend/pages/dashboard/dashboard.html
frontend/pages/reportes/reportes.js
frontend/pages/reportes/reportes.html
```

### Cartera, clientes, crédito

```
backend/controllers/cartera.controller.js
backend/services/creditoAbonoService.js
frontend/pages/cartera/cartera.js
frontend/pages/cartera/cartera.html
frontend/pages/clientes/clientes.js
frontend/pages/clientes/clientes.html
```

### Cashea

```
backend/services/casheaService.js
backend/routes/cashea.routes.js
frontend/pages/cashea/cashea.js
frontend/pages/cashea/cashea.html
database/migrations/012_cashea_integration.sql
database/migrations/033_cashea_tarifas_comision_oficial.sql
```

### Compras y CXP

```
backend/routes/compras.routes.js
backend/services/cuentasPagarService.js
backend/controllers/cuentasPagar.controller.js
backend/routes/cuentasPagar.routes.js
frontend/pages/compras/compras.js
frontend/pages/compras/compras.html
frontend/pages/cuentas_pagar/cuentas_pagar.js
frontend/pages/cuentas_pagar/cuentas_pagar.html
frontend/services/cuentasPagarClient.js
database/migrations/039_cuentas_pagar.sql
```

### PDF e impresión

```
backend/services/pdfService.js
backend/services/impresionService.js
backend/routes/pdf.routes.js
resources/templates/ticket_venta.html
resources/templates/nota_entrega.html
resources/templates/factura.html
frontend/services/printFormatters.js
```

### Infraestructura

```
electron/main.js
electron/preload.js
backend/server.js
backend/config/migrations.js
frontend/index.html
frontend/app.js
frontend/router.js
frontend/components/sidebar.js
frontend/components/toast.js
frontend/components/currencyDisplay.js
frontend/services/authClient.js
frontend/assets/css/variables.css
frontend/assets/css/base.css
frontend/assets/css/pages.css
frontend/assets/css/animations.css
lib/definitions.ts                          ← contratos TypeScript API
```

---

## 18. Diagramas de flujo

### 18.1 Venta POS → servidor

```
POS                              Backend (ventas.controller.create)
───                              ───────────────────────────────────
Carrito + loadTasasLocal()   →   resolverTasasOperativas(t)
Calcular Bs BCV + ref $      →   Recalcula líneas (ignora precios cliente)
Pagos[]                      →   Valida METODOS_USD_CALLE si solo_bcv
                                 sumaPagosEquivUsdCalle / sumaPagosEquivBsBcvOperativo
POST /api/ventas             →   INSERT ventas + detalle + pagos
                                 Stock FOR UPDATE, movimiento caja
                                 Crédito / Cashea si aplica
```

### 18.2 Cambio de modo

```
Admin en Config → selector modo
        │
        ▼
Modal confirmación (tasa USD si vuelve a multimoneda)
        │
        ▼
PATCH /api/configuracion/modo-moneda
        ├── 409 si caja abierta
        ├── Unifica USD=BCV si solo_bcv
        └── Auditoría CAMBIAR_MODO_MONEDA
        │
        ▼
hydrateTasasDesdeServidorSilent()
        ├── localStorage
        ├── body.nexus-solo-bcv
        ├── nexus:tasas
        └── nexus:modo-moneda
```

### 18.3 Cadena de precios (ambos modos)

```
                    ┌─────────────────┐
                    │  costo_usd      │
                    │  (+ margen %)   │
                    └────────┬────────┘
                             ▼
                    ┌─────────────────┐
                    │ precio_usd      │
                    │ _efectivo       │
                    └────────┬────────┘
                             │ × tasa_usd  ← en solo_bcv = tasa_bcv
                             ▼
                    ┌─────────────────┐
                    │ bs_usd_equiv    │
                    └────────┬────────┘
                             │ ÷ tasa_bcv
                             ▼
                    ┌─────────────────┐
                    │ precio_usd_bcv  │
                    └────────┬────────┘
                             │ × tasa_bcv
                             ▼
                    ┌─────────────────┐
                    │ precio_bs       │
                    └─────────────────┘
```

---

## 19. Reglas de negocio inmutables

1. **Migraciones 001–026 congeladas** — cambios estructurales solo en 027+.
2. **Ventas históricas no se reconvierten** al cambiar modo.
3. **Cambio de modo con caja cerrada** — enforced en API.
4. **Dashboard y KPIs operativos en ref. $ BCV** — regla `.cursor/rules/BCV.mdc`.
5. **Utilidades duales** — cambio en `preciosService` exige cambio en `preciosClient`.
6. **Backend recalcula ventas** — el POS no es fuente de verdad de precios al persistir.
7. **Cobro validado contra cadena BCV** — `total_bs_bcv_operativo` es autoritativo para Bs.
8. **Descuento divisa** — exclusivo multimoneda, migración 041, 100% pago USD/Zelle.

---

## 20. Estado de implementación y deuda conocida

### Implementado (junio 2026)

- `resolverTasasOperativas` en backend y frontend (NEXUS-DUAL)
- Escritura unificada USD=BCV en solo_bcv (manual + auto + caja)
- `ventas.controller` y `caja.controller` usan tasas operativas
- Rechazo API pagos USD calle en solo_bcv (AUD-01)
- Default `metodo_pago` según modo (AUD-02)
- Wizard paso modo moneda + Config selector + modal
- Mecanismo visual `body.nexus-solo-bcv` + `.nexus-usd-only`
- Eventos `nexus:modo-moneda` reactivos en POS/inventario
- Navbar dos tasas en multimoneda, una en solo_bcv
- Backlog AUD P1–P2 marcado resuelto en `backups/PLAN_SOLO_BCV.md`

### Superficies con decisión conservadora (revisar si producto cambia)

| Superficie | Comportamiento actual |
|------------|----------------------|
| Cartera abonos USD/Zelle | Siguen visibles en solo_bcv |
| Reportes analytics dashboard | Agrega en USD efectivo, no BCV |
| PDF/plantillas | Revisar copy "USD efectivo" en tickets solo_bcv |
| Servicios que usan `obtenerTasasActuales` crudo | Funcionan por doble defensa en escritura; lectura defensiva en resolver |

### Documentos relacionados en el repo

| Documento | Contenido |
|-----------|-----------|
| `backups/REPORTE-MODO-MONEDA-OPERATIVO.md` | Reporte maestro histórico (secciones 18+ desactualizadas) |
| `backups/PLAN_SOLO_BCV.md` | Plan implementación + backlog AUD resuelto |
| `docs/PLAN_DESCUENTO_COBRO_DIVISA.md` | Feature descuento divisa (041) |
| `docs/CONTEXTO_PROBLEMATICA_DESCUENTO_DIVISA_Y_MARGENES.md` | Análisis márgenes y descuento |
| `.cursor/rules/BCV.mdc` | Regla dashboard BCV |
| `.cursor/rules/SINCRON-A-DE-UTILIDADES-DUALES.mdc` | Protocolo dual |

---

## 21. Autenticación, sesión y seguridad

### Flujo de login

```
frontend/pages/login/login.html + login.js
        │
        ▼
POST /api/auth/login  →  auth.controller.login
        │
        ▼
JWT firmado (auth.middleware.signAccessToken)
  payload: sub, username, rol, permisos{}
        │
        ▼
authClient.js guarda:
  localStorage.nexus_access_token
  localStorage.nexus_user_json
        │
        ▼
app.js initSession() → GET /api/auth/verify
        │
        ▼
NexusRouter.guardRoute() → permisos por ROUTE_PERM
```

### Archivos

| Archivo | Rol |
|---------|-----|
| `backend/controllers/auth.controller.js` | login, verify, logout |
| `backend/routes/auth.routes.js` | Rutas públicas auth |
| `backend/middleware/auth.middleware.js` | `requireAuth`, firma JWT, validación `JWT_SECRET` |
| `frontend/services/authClient.js` | Token, `apiFetch`, `can(permiso)`, evento `nexus:session` |
| `frontend/pages/login/login.js` | UI acceso |

### Reglas de seguridad

- `JWT_SECRET` obligatorio distinto del fallback en producción (`server.js` aborta).
- Rate limit en login (`express-rate-limit` en auth routes).
- El frontend **nunca** lee `process.env`; API base = `http://127.0.0.1:3000`.
- Permisos en JWT; fallback `rolePermissions.js` si sesión antigua sin `permisos` en token.
- `tasas_edit` requerido para cambiar modo moneda y guardar tasas.

### Licencia (capa auth extendida)

| Archivo | Rol |
|---------|-----|
| `backend/services/licenciaService.js` | Validación Ed25519, activación HWID |
| `backend/routes/licencia.routes.js` | `/estado`, `/activar`, `/activar-inicial` |
| `license-server/` (Vercel) | Servidor remoto de códigos NC1 (no embebido en exe) |
| `frontend/activation.html` | Reactivación offline/online |
| `frontend/services/expiraLicenciaUi.js` | Banner expiración en chrome |

---

## 22. Middleware del backend

| Middleware | Archivo | Uso |
|------------|---------|-----|
| `requireAuth` | `auth.middleware.js` | Todas las rutas `/api/*` protegidas |
| `requirePermission(clave)` | `permissions.middleware.js` | Por endpoint (ej. `tasas_edit`, `ventas_ver`) |
| `cajaAbierta` | `cajaAbierta.middleware.js` | `POST /api/ventas` — exige sesión caja activa |
| `asyncHandler` | `utils/asyncHandler.js` | **Obligatorio** en handlers async; `httpError()` |
| `validation` | `validation.middleware.js` | Validación body/query en rutas sensibles |
| `registrarAuditoria` | `audit.middleware.js` | Cambios modo moneda, tasas, etc. |
| `casheaAdmin` | `casheaAdmin.middleware.js` | Operaciones admin Cashea |
| `errorHandler` | `errorHandler.middleware.js` | Respuesta estándar errores; oculta stack en prod |

**Orden típico en ruta:** `requireAuth` → `requirePermission` → `cajaAbierta` (si aplica) → `asyncHandler(controller)`.

---

## 23. Electron — IPC y ventanas

### Ventanas y HTML

| Ventana | HTML | Preload |
|---------|------|---------|
| Splash | `frontend/splash.html` | `preload-splash.js` |
| Setup | `frontend/setup.html` | (inline / bridge setup) |
| Activación | `frontend/activation.html` | `preload-activation.js` |
| App principal | `frontend/index.html` | `preload.js` |

### Canales IPC (`electron/main.js` → `preload.js`)

| Canal | Propósito |
|-------|-----------|
| `app:get-hardware-id` | HWID para licencia |
| `app:get-hardware-id-bundle` | HWID estable + legado |
| `app:get-version` | Versión app |
| `app:get-path` | Rutas userData, etc. |
| `pdf:open-buffer` | Abrir PDF temporal con visor del SO |
| `app:open-external` | URL en navegador externo |
| `window:focus` / `window:steal-focus` | Foco ventana |
| `theme:save` | Persistir tema dark/light (`themePreference.js`) |
| `license:get-server-url` | URL servidor licencias |
| `setup:*` | Wizard: test PG, guardar config, pasos iniciales |

**Regla:** el renderer solo accede vía `window.nexusCore` / `window.electronAPI` (lista blanca de canales).

### Arranque backend embebido

`electron/main.js` → `startBackend()` → `node backend/server.js` en proceso hijo con variables PG desde `setupConfig.js` (userData).

---

## 24. Componentes y servicios frontend compartidos

### Componentes (`frontend/components/`)

| Archivo | Global | Rol |
|---------|--------|-----|
| `navbar.js` | `NexusComponents` | Tasas, modo moneda, chrome superior |
| `sidebar.js` | `NexusComponents` | Navegación módulos + permisos |
| `toast.js` | `NexusComponents.showToast` | Notificaciones |
| `currencyDisplay.js` | `formatRefUsdBcv` | Formato ref. $ BCV (es-VE, 2 dec) |
| `modal.js` | — | Modales reutilizables |
| `dataTable.js` | — | Tablas con paginación/búsqueda |

### Servicios (`frontend/services/`)

| Archivo | Rol | Relación modos |
|---------|-----|----------------|
| `preciosClient.js` | Motor precios espejo | `resolverTasasOperativas`, descuento divisa |
| `authClient.js` | JWT + `apiFetch` | — |
| `telefonoVe.js` | Formato teléfono VE | NEXUS-DUAL con backend |
| `temaService.js` | Tema dark/light + IPC | — |
| `printFormatters.js` | Formato impresión cliente | BCV en tickets |
| `cuentasPagarClient.js` | API CXP | Tasas operativas vía hydrate |
| `numberStepper.js` | Input numérico +/- | Inventario, config |
| `expiraLicenciaUi.js` | UI vencimiento licencia | — |

### Utilidades renderer (`frontend/utils/`)

| Archivo | Rol |
|---------|-----|
| `domSafe.js` | Sanitización DOM / escape |
| `casheaBrand.js` | Assets/copy marca Cashea |

### Boot (`frontend/app.js`)

- `mountChrome()` una sola vez por sesión (no destruye sidebar/navbar en cada ruta).
- `hydrateTasasDesdeServidorSilent()` al primer chrome.
- Escucha `nexus:session` y `nexus:route` para remontar chrome tras login.

---

## 25. Utilidades duales y helpers

Protocolo: `.cursor/rules/SINCRON-A-DE-UTILIDADES-DUALES.mdc`

| Backend | Frontend | Función |
|---------|----------|---------|
| `utils/telefonoVe.js` | `services/telefonoVe.js` | Normalizar 0412-XXX.XX.XX |
| `utils/formatters.js` | `currencyDisplay.js` / `printFormatters.js` | Moneda BS/USD, ref BCV |
| `utils/validators.js` | validaciones inline en páginas | RIF, CI, formularios |
| `utils/calculations.js` | cálculos POS/inventario | Descuentos, proporciones |
| `services/preciosService.js` | `services/preciosClient.js` | Cadena precios completa |

### Solo backend (sin contraparte de cálculo)

| Archivo | Rol |
|---------|-----|
| `utils/ventaTotalesBcv.js` | Totales ticket BCV |
| `utils/devolucionesSaldo.js` | Montos devolución |
| `utils/bcvVigenciaVe.js` | Día hábil Caracas |
| `utils/feriadosBcvVe.js` | Feriados Sudeban |
| `utils/pgDumpResolver.js` | Localizar binario pg_dump |
| `utils/asyncHandler.js` | Wrapper Express |

**Nota:** `lib/definitions.ts` está referenciado en reglas del proyecto como contrato TypeScript futuro, pero **no existe aún** en el árbol del repo.

---

## 26. Descuento cobro divisa (migr. 041)

Feature **exclusivo multimoneda**. Documentación extendida: `docs/PLAN_DESCUENTO_COBRO_DIVISA.md`.

### Configuración

| Clave | Default | UI |
|-------|---------|-----|
| `descuento_cobro_divisa_activo` | `false` | Config → Tasas (oculto en solo_bcv) |
| `descuento_cobro_divisa_pct` | `0` | 0–100, step 0.5 |

**Endpoint:** `PATCH /api/configuracion/descuento-cobro-divisa`

### Regla de aplicación (venta)

Solo cuando **todas** se cumplen:

1. `modo_moneda_operacion = multimoneda`
2. Config activa y `pct > 0`
3. Pago **100%** en `efectivo_usd` y/o `zelle`
4. No aplica en pagos mixtos ni solo Bs

### Efecto en montos

| Campo | Comportamiento |
|-------|----------------|
| `total_ref_usd_bcv` | **Sin cambio** — referencia fiscal/ticket Bs |
| `total_bs_bcv_operativo` | **Sin cambio** — Bs a cobrar en cadena BCV |
| `total_usd` | **Reducido** — `resolverTotalUsdCobro(ref, pct)` |
| `descuento_divisa_pct` | % aplicado (auditoría) |
| `descuento_divisa_monto_usd` | `ref − total_usd` |

### Frontend

| Módulo | Comportamiento |
|--------|----------------|
| `pos.js` | `cobroAplicaDescuentoDivisa()`, banner rojo USD, `totalUsdCobroEfectivo()` |
| `inventario.js` | Modo precio `usd_objetivo` — margen para USD neto con descuento |
| `configuracion.js` | Toggle + % descuento; nota "solo multimoneda" |

### Solo BCV

- `cobroAplicaDescuentoDivisa()` → siempre `false`
- Config oculta; backend ignora regla si `esSoloBcv`

---

## 27. IVA, descuentos de línea y anulación

### IVA en ventas

- **Fuente:** `configuracion.impuesto_iva` vía `PreciosService.leerImpuestoIvaPorcentaje(db)`.
- El **body del cliente no define** el % IVA usado (`ventas.controller.create`).
- Por producto: `productos.aplica_iva` (null = aplica).
- Migr. `014_ventas_iva_default_zero.sql` — default IVA 0 en ventas nuevas.
- IVA se calcula sobre neto post-descuento global de líneas, en USD efectivo; ref BCV deriva de la cadena.

### Descuento por línea (POS)

- Cada línea del carrito: `descuento_pct` (0–100).
- Afecta subtotal USD efectivo antes de IVA y cadena BCV.

### Descuento global venta

- Campos `ventas.descuento_porcentaje`, `ventas.descuento_monto_usd` (distinto del descuento divisa 041).

### Anulación

- `POST /api/ventas/:id/anular` — permiso `ventas_anular`
- Revierte stock, movimientos caja, crédito (migr. `022_anulacion_credito_reversa.sql`)
- **No re-calcula por modo actual** — respeta tasas históricas de la venta

---

## 28. Ventas suspendidas e idempotencia

### Ventas suspendidas (carritos aparcados)

| Endpoint | Rol |
|----------|-----|
| `GET /api/ventas/suspendidas` | Listar |
| `POST /api/ventas/suspendidas` | Guardar carrito |
| `GET /api/ventas/suspendidas/:id` | Recuperar |
| `DELETE /api/ventas/suspendidas/:id` | Eliminar |

**POS (`pos.js`):** selector "Ventas suspendidas", restaura líneas + puede usar tasas del snapshot guardado vs tasas actuales (`nexus:tasas`).

**Tabla:** `ventas_suspendidas` (001) — JSON del carrito + metadatos.

### Idempotencia de ventas

Evita duplicar ventas por doble clic / reintento red.

| Migración | Qué hace |
|-----------|----------|
| `021_idempotency_ventas.sql` | Columna `idempotency_key` en ventas |
| `024_fix_idempotency_index.sql` | Índice único corregido |
| `031_idempotency_ventas_indice_reconciliar.sql` | Índice por `(usuario_id, idempotency_key)` |

**POS** envía `idempotency_key` en `POST /api/ventas`; servidor retorna venta existente si ya procesada.

---

## 29. Devoluciones

| Capa | Archivo |
|------|---------|
| Rutas | `backend/routes/devoluciones.routes.js` |
| Controlador | `backend/controllers/devoluciones.controller.js` |
| Utilidad montos | `backend/utils/devolucionesSaldo.js` |
| Migración | `017_devoluciones.sql` |

### Flujo

1. Desde **Ventas** → modal devolución (parcial/total por líneas).
2. Montos BCV vía `lineaMontosBcvRef()` (proporcional al header ref BCV).
3. Método reembolso: Bs, USD calle (oculto en solo_bcv en UI), etc.
4. Ajuste stock + movimiento caja + saldo cartera si aplica crédito.

**Modo solo_bcv:** UI oculta reembolso `efectivo_usd`; validar coherencia en backend si se agrega restricción API.

---

## 30. Inventario, stock y alertas

### Servicio de inventario

**Archivo:** `backend/services/inventarioService.js`

- Único punto válido para ajustes que mutan stock (regla migr. 019).
- `inventario.controller.js` — categorías, ajuste masivo, movimientos, valorizado.
- Constraints `stock >= 0` (`019_stock_constraints.sql`).

### Valorizado

- Reporte/API usa `resolverTasasOperativas` para `costo_total_bcv_ref` y `valor_venta_total_bcv_ref`.

### Alertas stock

**Archivo:** `backend/services/alertasService.js`  
**Dashboard:** `GET /api/dashboard/alertas-stock` — productos bajo mínimo (sin distinción de modo; cantidades en unidades).

### Importación productos

**Archivo:** `backend/services/importProductosService.js`  
- Plantilla XLSX, import masivo con recálculo vía `PreciosService`.

### POS — búsqueda producto

- Por nombre, código interno, **código de barras** (`codigo_barras`).
- Librería `jsbarcode` disponible en dependencias para generación/lectura según flujo UI.

---

## 31. Respaldo automático (pg_dump)

| Archivo | Rol |
|---------|-----|
| `backend/services/syncService.js` | Ejecuta `pg_dump`, rotación (max 10), estado JSON |
| `backend/services/backupScheduler.js` | Programación periódica |
| `backend/utils/pgDumpResolver.js` | Encuentra binario pg_dump compatible |

### Configuración

| Fuente | Parámetro |
|--------|-----------|
| BD `configuracion` | `backup_automatico`, `backup_intervalo_horas` |
| `.env` | `NEXUS_BACKUP_DIR`, `NEXUS_BACKUP_INTERVAL_MINUTES`, `NEXUS_PG_*` |
| UI | Configuración → Respaldo |
| Trigger adicional | Cierre de caja / salida app (legacy `caja.routes`) |

**Nota:** el nombre `syncService` es histórico — implementa **backup local**, no sincronización cloud.

---

## 32. Esquema BD completo y catálogo de migraciones

### Tablas núcleo (`001_initial_schema.sql`)

| Tabla | Dominio |
|-------|---------|
| `configuracion` | Clave/valor global (+ `actualizado_por` migr. 042) |
| `roles`, `usuarios` | Auth y permisos |
| `categorias`, `productos`, `lotes_producto` | Catálogo |
| `proveedores`, `compras`, `detalles_compras` | Compras |
| `clientes`, `cuentas_cobrar`, `pagos_credito` | Crédito/cartera |
| `cajas`, `sesiones_caja` | Caja |
| `ventas`, `detalles_ventas`, `ventas_suspendidas` | Ventas |
| `ajustes_inventario` | Movimientos stock |
| `auditoria` | Log cambios sensibles |

### Tablas añadidas en parches relevantes

| Parche | Tablas/columnas |
|--------|-----------------|
| 007 | `historial_tasas` |
| 012 | Cashea (`cashea_config`, `ventas_cashea`, liquidaciones…) |
| 017 | `devoluciones`, `detalles_devolucion` |
| 039 | `cuentas_pagar`, `pagos_proveedor` |
| 037 | `ventas.total_bs_bcv_operativo`, clave `modo_moneda_operacion` |
| 041 | `ventas.descuento_divisa_*` |

### Catálogo completo migraciones 001–042

| # | Archivo | Resumen |
|---|---------|---------|
| 001 | `initial_schema` | Esquema base |
| 002 | `indexes` | Índices |
| 003 | `triggers` | Triggers |
| 004 | `seed_data` | Admin + semilla |
| 005 | `rename_tasa_usd` | Rename tasa |
| 006 | `simplify_productos_costo` | Costo simplificado |
| 007 | `historial_tasas` | Historial diario |
| 008 | `caja_schema_upgrade` | Caja multimoneda |
| 009 | `roles_perm_matrix` | Matriz permisos |
| 010 | `tasas_edit_admin_only` | Tasas solo admin |
| 011 | `fix_trigger_historial_tasas_pg` | Fix trigger |
| 012 | `cashea_integration` | Cashea |
| 013 | `search_performance` | Índices búsqueda |
| 014 | `ventas_iva_default_zero` | IVA default 0 |
| 015 | `ventas_total_bs_cliente_desc_max` | Total Bs cliente |
| 016 | `credito_sequence_cuentas_cobrar` | Secuencia crédito |
| 017 | `devoluciones` | Devoluciones |
| 018 | `cartera_missing_columns` | Columnas cartera |
| 019 | `stock_constraints` | Stock ≥ 0 |
| 020 | `sesiones_huerfanas` | Cierre auto caja |
| 021 | `idempotency_ventas` | Idempotencia |
| 022 | `anulacion_credito_reversa` | Anulación crédito |
| 023 | `roles_perm_dashboard_merge` | Permisos dashboard |
| 024 | `fix_idempotency_index` | Fix índice |
| 025 | `usuario_permisos_override` | Override usuario |
| 026 | `query_performance_indexes` | Performance |
| 027 | `cashea_niveles_y_config_express` | Niveles Cashea |
| 028 | `moneda_costo_producto` | `moneda_costo` |
| 029 | `ventas_total_ref_usd_bcv` | Ref BCV venta |
| 030 | `ventas_tasa_bcv_aplicada` | Tasa BCV por venta |
| 031 | `idempotency_ventas_indice_reconciliar` | Índice idempotencia |
| 032 | `ventas_cashea_pct_inicial_numeric` | % inicial Cashea |
| 033 | `cashea_tarifas_comision_oficial` | Comisiones oficiales |
| 034 | `tasa_bcv_feriados_ve_2026` | Feriados 2026 |
| 035 | `nomenclatura_tasa_usd_sin_paralela` | Sin tasa_paralela |
| 036 | (JS) setup admin legacy | Flag wizard |
| 037 | `total_bs_bcv_y_modo_moneda` | **Modo moneda** |
| 038 | `cashea_pct_inicial_semilla_60` | Semilla 60% |
| 039 | `cuentas_pagar` | CXP |
| 040 | `cuentas_pagar_permiso_roles` | Permiso CXP |
| 041 | `descuento_cobro_divisa` | **Descuento divisa** |
| 042 | `configuracion_actualizado_por` | Auditoría config |

**Runner:** `backend/config/migrations.js` — bootstrap atómico 001–005 si BD vacía; parches 006+ idempotentes en `server.js` al arrancar.

---

## 33. PDF, tickets e impresión (detalle BCV)

### Pipeline

```
venta en BD
    │
    ▼
pdfService.js → resolveTotalesBcvTicket(venta)  [ventaTotalesBcv.js]
    │
    ▼
Plantilla HTML (resources/templates/*.html)
    │
    ▼
jspdf / impresión térmica (impresionService.js)
    │
    ▼
Electron: nexusCore.openPdfBuffer()  [visor SO]
```

### Campos monetarios en ticket

| Campo plantilla | Origen |
|-----------------|--------|
| Total ref. $ BCV | `total_ref_usd_bcv` |
| Total Bs | `total_bs_bcv_operativo` o derivado |
| Líneas | `lineaMontosBcvRef` proporcional |
| Descuento global | `descuento_porcentaje` / `descuento_monto_usd` |
| Descuento divisa | `descuento_divisa_pct` / `descuento_divisa_monto_usd` (solo multimoneda) |
| Tasas | `tasa_bcv_aplicada`, `tasa_cambio_aplicada` |

### Identidad en tickets

- Fuente mono DM Mono en montos (`ticket_venta.html`).
- Acento ámbar `#f0a500` en reglas/separadores (no cyan).
- Ancho ~72mm térmico.

### Endpoints PDF

| Ruta | Documento |
|------|-----------|
| `GET /api/pdf/ticket/:ventaId` | Ticket venta |
| `GET /api/pdf/nota/:ventaId` | Nota entrega |
| `GET /api/pdf/factura/:ventaId` | Factura |
| `POST /api/pdf/ticket-preview` | Preview sin venta guardada |
| `GET /api/reportes/cierre/termico.pdf` | Cierre caja térmico |

**Pendiente producto:** revisar si tickets en solo_bcv deben ocultar líneas "USD efectivo" cuando `tasa_cambio = tasa_bcv` (misma lógica que `ventas.js` detalle).

---

## 34. Pantallas fuera del SPA principal

| Pantalla | Cuándo | Modo moneda |
|----------|--------|-------------|
| `splash.html` | Arranque | — |
| `setup.html` | Primera instalación | Paso 4: elegir multimoneda/solo_bcv |
| `activation.html` | Licencia inválida | — |
| `index.html` + router | App normal | Hereda modo vía navbar hydrate |
| `login/login.html` | Sin sesión | — |

### Configuración — pestañas no monetarias (completar mapa)

| Tab `data-tab` | Panel | Contenido |
|----------------|-------|-----------|
| `tasas` | `#panel-tasas` | Modo, BCV, USD, BCV auto, descuento divisa |
| `empresa` | `#panel-empresa` | RIF, nombre, dirección, IVA |
| `impresora` | `#panel-impresora` | IP térmica, ancho ticket |
| `usuarios` | `#panel-usuarios` | Acceso rápido (módulo completo en `#/usuarios`) |
| `respaldo` | `#panel-respaldo` | Backup automático |
| `licencia` | `#panel-licencia` | Estado HWID |
| `apariencia` | `#panel-apariencia` | Tema dark/light (`temaService.js`) |

---

## 35. Variables de entorno y build

### Variables críticas (`.env` — no commitear)

| Variable | Rol |
|----------|-----|
| `JWT_SECRET` | Firma tokens |
| `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD` | PostgreSQL |
| `NEXUS_LICENSE_PUBLIC_KEY` | Validación licencia |
| `NODE_ENV` | production vs development |
| `NEXUS_BACKUP_DIR` | Directorio respaldos |
| `NEXUS_BACKUP_INTERVAL_MINUTES` | Override intervalo backup |
| `NEXUS_PG_DUMP_PATH` | Ruta explícita pg_dump |

Documentadas en `.env.example`.

### Build Electron

| Script npm | Resultado |
|------------|-----------|
| `npm start` | Dev Electron |
| `npm run dist` | Instalador Windows NSIS |
| `npm run dist:portable` | Portable exe |
| `npm run icons` | Generar icon.ico/png |

**Recursos:** `build-resources/` (icon, installer.nsh), `electron-builder` en `package.json`.

---

## 36. Auditoría y logging

| Sistema | Archivo |
|---------|---------|
| Winston logs | `backend/config/logger.js` → `logs/app.log` |
| Tabla BD | `auditoria` (001) |
| Middleware | `audit.middleware.js` — `CAMBIAR_MODO_MONEDA`, tasas, etc. |
| Config | `configuracion.actualizado_por` (migr. 042) |

**Prohibido:** `console.log` en backend producción; errores frontend → `toast.js`.

---

## 37. Huecos detectados en la primera versión (checklist)

Esta revisión añadió lo que **faltaba** en la v1 del documento:

| Tema | Estado en doc |
|------|---------------|
| Auth JWT + flujo login | ✅ §21 |
| Middleware stack completo | ✅ §22 |
| Canales IPC Electron detallados | ✅ §23 |
| Componentes `modal`, `dataTable`, servicios frontend restantes | ✅ §24 |
| Utilidades duales + nota `definitions.ts` ausente | ✅ §25 |
| Descuento cobro divisa (041) completo | ✅ §26 |
| IVA, descuento línea, anulación | ✅ §27 |
| Ventas suspendidas + idempotencia | ✅ §28 |
| Devoluciones módulo | ✅ §29 |
| inventarioService, stock 019, alertas, barcode POS | ✅ §30 |
| syncService = backup pg_dump | ✅ §31 |
| Catálogo migraciones 001–042 + tablas 001 | ✅ §32 |
| PDF/tickets pipeline BCV + descuento divisa | ✅ §33 |
| splash, setup, activation, tabs config completas | ✅ §34 |
| .env, build electron-builder | ✅ §35 |
| Auditoría + logger | ✅ §36 |
| license-server Vercel | ✅ §21 (licencia) |
| Cashea flujo cuotas BCV | ✅ §10.11 (ya estaba; reforzado en §32 migr. 012–033) |
| POS features: suspendidas, idempotencia, barcode | ✅ §28, §30 |
| `alertasService`, `importProductosService` | ✅ §30 |
| Parche 036 setup legacy, 042 actualizado_por | ✅ §32 |

### Temas aún con cobertura parcial (profundizar en futuras revisiones)

| Tema | Por qué |
|------|---------|
| Flujo Cashea paso a paso (calcular → liquidar) | Requiere diagrama de estados `ventas_cashea` |
| Compras → recibir → CXP en detalle | Handlers inline en `compras.routes.js` |
| Contenido exacto de cada plantilla PDF línea por línea | 3 HTML × modos históricos |
| `reportes.js` — lista completa exports Excel | ~15 endpoints espejo |
| Tests automatizados | No hay suite en repo |
| `license-server/` API contrato | Servicio externo Vercel |

---

*Documento generado como referencia viva del estado del código a junio 2026. Revisión 2 — ampliado con auth, middleware, IPC, utilidades duales, descuento divisa, IVA, suspendidas, devoluciones, backup, catálogo migraciones 001–042, PDF y checklist de huecos. Actualizar cuando se agreguen módulos, migraciones 043+, o cambios en la política de modos de moneda.*
