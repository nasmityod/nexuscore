# Plan Solo BCV — 2026-06-06

Implementación del modo operativo `solo_bcv` (una sola tasa) coexistiendo con
`multimoneda` (dos tasas). Backend es la única fuente de verdad del modo.

---

## Estado real del código

### Migración 037 (`037_total_bs_bcv_y_modo_moneda.sql`)
- Crea `ventas.total_bs_bcv_operativo` (NUMERIC) y backfill desde `total_ref_usd_bcv × tasa_bcv_aplicada`.
- Inserta `configuracion('modo_moneda_operacion', 'multimoneda', 'moneda', ...)` con `ON CONFLICT DO NOTHING`.
- Registrada en `migrations.js` (`runPatch037TotalBsBcvModoMoneda`) y llamada en `server.js`.
- **Conclusión:** la columna de clave de modo ya existe. No falta nada de esquema.

### `modoMonedaService.js`
- Exporta `CLAVE_MODO`, `MODOS_VALIDOS` (`multimoneda`|`solo_bcv`), `leerModo(db)` y `esSoloBcv(modo)`.
- `leerModo` retorna `'multimoneda'` por defecto si la clave falta o es inválida.
- **OJO:** `esSoloBcv(modo)` recibe la **cadena del modo**, no `db`. Uso correcto: `esSoloBcv(await leerModo(db))`.

### `preciosService.js` (backend) vs `preciosClient.js` (frontend) — divergencia NEXUS-DUAL
La cadena de 4 pasos y sus utilidades de redondeo están **sincronizadas** entre ambos:
`redondearTasa4`, `assertTasasPositivas`, `precioBolivaresRefBcvDesdeBsUsd`,
`totalBolivaresDesdeRefUsdBcv`, `aplicarCadenaPorPrecioEfectivo`,
`precioManualUsdDesdeBcvObjetivo`, `tienePrecioManualActivo`, `calcularPrecios`,
`gananciaPctDesdePrecioUsdBcvObjetivo`, `gananciaPctDesdePrecioUsdFisicoObjetivo(Exacto)`,
`costoUsdDesdeCostoBcv`. **No hay divergencia de cálculo.**
- Funciones **solo backend** (tocan BD / agregan): `obtenerTasasActuales`, `actualizarTasas`,
  `actualizarTasaBcvAutomatica`, `previewCambioTasa`, `leerTasaBcvVigenteLegal`,
  `leerImpuestoIvaPorcentaje`, `sumaPagosEquivUsdCalle`, `sumaPagosEquivBsBcvOperativo`,
  `precioVentaUnitarioCatalogo`, etc. No requieren contraparte de cálculo.
- **NO existe** `resolverTasasOperativas` en ninguna de las dos capas. Hay que crearlo.
- El nombre `saveTasas` del requerimiento corresponde en el código real a
  `PreciosService.actualizarTasas` (servicio) invocado por `configuracion.controller.saveTasas`.

### `ventas.controller.js`
- `create()` llama `PreciosService.obtenerTasasActuales(t)` (línea ~410) dentro de la `db.tx`.
- Recalcula todos los precios en servidor (ignora lo enviado por el POS). Validación de pagos
  intacta. Solo hay que cambiar el **input de tasas** a `resolverTasasOperativas`.

### `configuracion.controller.js`
- `getTasasActuales` ya devuelve `modo_moneda_operacion` pero **devuelve `tasa_usd` cruda**
  (no unificada). Hay que pasarla por el resolver.
- `updateGeneral` (PATCH `/api/configuracion`) ya acepta `modo_moneda_operacion` vía
  `CLAVES_MODO_MONEDA`, pero **NO** valida caja cerrada, **NO** fuerza `tasa_usd = tasa_bcv`
  y **NO** registra auditoría específica. Hay que endurecerlo.
- `saveTasas` (POST `/api/configuracion/tasas`) delega en `actualizarTasas`.

### `bcvTasaAutoService.js`
- `intentarAplicarPendiente` → `actualizarTasaBcvAutomatica`. Solo sube USD si quedó por
  debajo del BCV. **No** iguala USD a BCV en modo solo_bcv. Hay que forzarlo.

### `navbar.js`
- `renderNavbar` ya muestra **una sola** tasa (USD BCV). No hay segunda tasa que ocultar.
- `hydrateTasasDesdeServidorSilent` **ya** lee `modo_moneda_operacion` del servidor y guarda
  `usdOperativo = (solo_bcv ? bcv : usd)` en localStorage, y dispara `nexus:tasas`. Es decir,
  **ya iguala las tasas en el front** — pero el backend las ignoraba (riesgo: el POS recalcula
  con tasas crudas del servidor). **No** persiste el modo en localStorage.
- `loadRates()` no es consciente del modo (lee `nexus_tasa_usd` crudo).

### `pos.js`
- `COBRO_METODOS.efectivo_usd` (moneda USD) y `COBRO_TABLA_ORDEN` incluye `efectivo_usd`.
- `renderCobroTabla()` (≈3076) construye filas iterando `COBRO_TABLA_ORDEN`.
- `getTasas()` lee `NexusComponents.loadTasasLocal()`; `onTasas` recalcula al evento `nexus:tasas`.

### `inventario.js` / `inventario.html`
- `state.modoMonedaCosto` (`usd_fisico`|`bcv`), `state.modoPrecios` (`margen`|`bcv`|`usd`).
- Tabs costo: `.btn-moneda-costo[data-mc=usd_fisico|bcv]`. Tabs precio: `.btn-modo-precio[data-modo=margen|bcv|usd]`.
- `limpiarWizard` resetea a `usd_fisico` + `margen`. `cambiarModoMonedaCosto` / `cambiarModoPrecio` togglean visibilidad.
- Lee tasas vía `tasasEfectivas()` → `loadTasasLocal()`.

### `configuracion.js` / `configuracion.html`
- Pestaña Tasas: `#input-tasa-bcv`, `#input-tasa-usd`, `#display-bcv`, `#display-usd`, `#btn-guardar-tasas`.
- Sección USD: `<h3>Tasa USD</h3>` (segunda `.config-seccion` dentro de `.cfg-tasas-grid`) + nota `.bcv-auto-nota-usd`.

### `setup.html`
- Wizard de 4 pasos (db, licencia, admin, empresa) con máquina de estados `setStepUi(1..4)`,
  dots `#dot-1..4`, labels `#label-1..4`. El paso empresa (4) finaliza. Endpoints sin JWT en `setup.routes.js`.

### `migrations.js` / directorio
- Último archivo: `038_cashea_pct_inicial_semilla_60.sql`. Siguiente número disponible: **039**.

---

## Decisiones de diseño tomadas

1. **`resolverTasasOperativas(db)` envuelve a `obtenerTasasActuales`** (no al revés). Lee el modo,
   y si `solo_bcv` fuerza `tasa_usd = tasa_bcv` al **leer**. Agrega `modo_moneda_operacion`.
   Razón: cambio mínimo y aislado; `obtenerTasasActuales` queda como lectura cruda reutilizable.
2. **Forzar `tasa_usd = tasa_bcv` también al ESCRIBIR** dentro de `actualizarTasas` y
   `actualizarTasaBcvAutomatica`. Así el almacenamiento queda coherente y cualquier lectura
   (incluso las que no pasen por el resolver) ve tasas unificadas en solo_bcv. Doble defensa.
3. **No se cambian los consumidores de bajo riesgo** (`dashboardService`, `reportesService`,
   `inventario.controller`, `productos.controller`, `excelService`): en solo_bcv el
   almacenamiento ya está unificado (decisión 2), por lo que `obtenerTasasActuales` les devuelve
   `tasa_usd = tasa_bcv`. Se cambian solo `ventas`, `caja` y el endpoint `getTasasActuales`
   (los que el requerimiento exige y el que alimenta a la UI).
4. **Auditoría del cambio de modo** vía `registrarAuditoria` (tabla `auditoria` existente).
   No se necesita migración nueva. **FASE 2 = sin migración.**
5. **Caja cerrada**: el PATCH de modo rechaza con 409 si existe **cualquier** sesión
   `estado='abierta' AND fecha_cierre IS NULL` en `sesiones_caja` (no solo la del usuario).
6. **Wizard**: se agrega un **paso real nuevo** "Moneda" entre Admin (3) y Empresa, quedando
   Empresa como paso 5. Solo se inserta en el flujo de instalación nueva (admin recién creado),
   no en re-ejecuciones de renovación (donde el modo ya existe). Default seleccionado: Multimoneda.
7. **POS**: en solo_bcv se oculta la fila `efectivo_usd` (USD físico). Se conserva `zelle`
   (USD digital) y `cashea` porque el requerimiento nombra explícitamente solo "Efectivo USD";
   decisión conservadora documentada en código.
8. **Reportes**: la columna `tasa_usd` se deja como está. En solo_bcv el historial nuevo guarda
   `tasa_usd = tasa_bcv` (decisión 2), así que la columna refleja el BCV sin tocar histórico.
   Las filas históricas previas al cambio se respetan intactas (regla HISTÓRICO INTACTO).
9. **Frontend chokepoint**: `navbar.loadRates()` se vuelve consciente del modo
   (lee `nexus_modo_moneda` en localStorage). Como POS e Inventario leen tasas vía
   `NexusComponents.loadTasasLocal`, basta unificar ahí + en `preciosClient` (NEXUS-DUAL).

---

## Riesgos identificados en el código real

- **R1 — Navbar ya "mentía" el evento**: el front igualaba tasas pero el backend recalculaba
  ventas con tasas crudas. Si en solo_bcv el almacenamiento tuviera `tasa_usd != tasa_bcv`,
  el ticket del POS (cadena BCV) y el recálculo del servidor diferirían. Mitigado por decisiones 1+2.
- **R2 — `actualizarTasas` valida `usd >= bcv`**: forzar `usd = bcv` es compatible (igualdad OK).
- **R3 — Caja abierta durante cambio de modo**: si se cambiara el modo con caja abierta, las
  tasas de apertura y las de cobro divergirían. Mitigado por la validación 409 (decisión 5).
- **R4 — Histórico**: ninguna migración/escritura toca filas existentes de `ventas`,
  `ventas_detalle`/`detalles_ventas`, `historial_tasas` ni `sesiones_caja`. Solo se INSERTA.
- **R5 — Wizard de 4→5 pasos**: tocar la máquina de estados puede romper navegación. Mitigado
  insertando el paso solo en la transición admin→empresa y manteniendo los `setStepUi` previos.
- **R6 — `getModoMoneda` offline**: si el back no responde, se usa el último `nexus_modo_moneda`
  de localStorage (default `multimoneda`).

---

## Fases de implementación

### FASE 1 — Backend núcleo de tasas
Estado: ✅ Completa
- [x] `preciosService.resolverTasasOperativas(db)` (nuevo) + `require modoMonedaService`.
- [x] `preciosService.actualizarTasas`: si solo_bcv → `usd = bcv` antes de persistir + auditar.
- [x] `preciosService.actualizarTasaBcvAutomatica`: si solo_bcv → `usd = bcv`.
- [x] `ventas.controller.create`: usar `resolverTasasOperativas(t)`.
- [x] `caja.controller.abrir`: usar `resolverTasasOperativas(db)`.
- [x] `configuracion.controller.getTasasActuales`: usar `resolverTasasOperativas(db)`.
- [x] `configuracion.controller`: nuevo `patchModoMoneda` (PATCH) con 409 caja abierta +
      forzar `usd=bcv` si solo_bcv + auditoría. Ruta en `configuracion.routes.js`.
      Además: `updateGeneral` rechaza `modo_moneda_operacion` (cierra bypass de la regla caja cerrada).
- [x] `setup.routes.js`: `POST /api/setup/modo-moneda-inicial` (sin JWT) +
      `setupAdminService.guardarModoMonedaInicial`.

### FASE 2 — Migración SQL
Estado: ✅ Completa
- [x] Confirmado: **no se requiere migración nueva** (037 ya creó la clave; auditoría usa tabla `auditoria`).

### FASE 3 — Wizard paso de modo
Estado: ✅ Completa
- [x] `setup.html`: panel `#panel-moneda` (paso 4) + dot/label 5, copy exacto, default Multimoneda.
- [x] JS wizard: `goToMonedaStep`, POST `/api/setup/modo-moneda-inicial`, reordenar a Empresa (5).

### FASE 4 — Configuración cambio de modo
Estado: ✅ Completa
- [x] Selector de modo (`#cfg-modo-moneda`) en pestaña Tasas + modal `#modal-confirm-modo`
      (con input tasa_usd cuando se pasa a multimoneda).
- [x] PATCH `/api/configuracion/modo-moneda`, re-hidrata tasas (dispara `nexus:tasas`), maneja 409.
- [x] `guardarTasas` en solo_bcv guarda BCV y deja que el backend iguale USD.

### FASE 5 — Frontend reactividad al modo
Estado: ✅ Completa
- [x] `navbar.js`: persistir `nexus_modo_moneda`, `loadRates` consciente del modo, `getModoMoneda` expuesto.
- [x] `preciosClient.js`: `resolverTasasOperativas(tasas)` + `getModoMonedaLocal` (NEXUS-DUAL).
- [x] `pos.js`: helper `posModoMoneda` + ocultar fila `efectivo_usd` en solo_bcv (Zelle/Cashea se conservan).
- [x] `inventario.js`: default `bcv` para producto nuevo, ocultar tab "USD físico" y modo precio "usd" en solo_bcv;
      re-aplicado en `abrirWizard` y `refrescarInventarioPorTasas`.
- [x] `configuracion.js`/`.html`: ocultar bloque/input/nota USD en solo_bcv (`aplicarVisibilidadModo`).
- [x] `reportes`: sin cambios (decisión 8 — el historial nuevo guarda tasa_usd = tasa_bcv; histórico intacto).

### FASE 6 — Consistencia final y limpieza
Estado: ✅ Completa
- [x] Único acceso directo a `nexus_tasa_usd` es `navbar.js` (chokepoint `loadRates`, ya consciente del modo).
      POS/Inventario leen vía `NexusComponents.loadTasasLocal`; nada bypassa el filtro.
- [x] Comentario de test de equivalencia en `preciosClient.resolverTasasOperativas`.
      Verificado en backend: `calcularPrecios(1.2, 30, 89.5, 89.5)` → pe=1.56, $BCV=1.56, Bs=139.62.
- [x] Plan actualizado con el estado final (sección siguiente).

---

## Migración SQL (si aplica)

**No aplica.** La clave `modo_moneda_operacion` ya existe (migración 037). La auditoría del
cambio de modo se registra en la tabla `auditoria` existente vía `registrarAuditoria`. No se
agregan columnas ni índices, por lo que no se crea `039_*.sql`.

---

## Protocolo NEXUS-DUAL

| Función | Backend `preciosService.js` | Frontend `preciosClient.js` |
|---|---|---|
| Unificación de tasas por modo | `resolverTasasOperativas(db)` (lee modo de BD) | `resolverTasasOperativas(tasas)` (lee `nexus_modo_moneda` de localStorage) |

La **cadena de cálculo** (`calcularPrecios`, `aplicarCadenaPorPrecioEfectivo`, etc.) **NO cambia**:
solo cambia el input (tasas unificadas) antes de invocarla, en ambas capas.

---

## Cómo verificar que está completo

1. **Multimoneda intacto**: con `modo=multimoneda`, todo funciona igual (dos tasas, POS con Efectivo USD,
   inventario con USD físico, etc.).
2. **Cambio a solo_bcv (caja cerrada)**: Configuración → Tasas → seleccionar Solo BCV → confirmar.
   `tasa_usd` pasa a igualar `tasa_bcv`; navbar muestra una sola tasa; POS oculta Efectivo USD;
   inventario por defecto en $BCV sin tab USD físico ni modo precio USD; pestaña Tasas oculta input USD.
3. **Cambio con caja abierta**: el PATCH responde 409 con mensaje claro; la UI lo informa.
4. **Solo_bcv → multimoneda**: pide nueva tasa USD; al confirmar, vuelven los controles de USD.
5. **Guardar tasas en solo_bcv**: aunque se envíe un USD distinto, el backend lo iguala a BCV.
6. **BCV automático en solo_bcv**: al aplicar nueva tasa BCV, `tasa_usd` queda igual a BCV.
7. **Venta en solo_bcv**: el servidor recalcula con tasas unificadas; el ticket cuadra.
8. **Wizard nuevo**: aparece el paso "¿Cómo maneja tu negocio los precios?" con Multimoneda por defecto.
9. **Histórico**: ventas, historial_tasas y sesiones_caja previas quedan intactas (solo filas nuevas).

---

## Estado final de la implementación (2026-06-06)

### Qué se implementó
- **Backend (fuente de verdad del modo):**
  - `preciosService.resolverTasasOperativas(db)` — único punto de entrada a tasas operativas;
    unifica `tasa_usd = tasa_bcv` en solo_bcv y expone `modo_moneda_operacion`.
  - `preciosService.actualizarTasas` y `actualizarTasaBcvAutomatica` fuerzan `usd = bcv` en solo_bcv
    al **escribir** (manual, apertura de caja y BCV automático).
  - `ventas.controller.create` y `caja.controller.abrir` usan `resolverTasasOperativas`.
  - `configuracion.controller`: `getTasasActuales` usa el resolver; nuevo `patchModoMoneda`
    (PATCH `/api/configuracion/modo-moneda`, permiso `tasas_edit`) con 409 si hay caja abierta,
    unificación inmediata en solo_bcv, tasa USD nueva opcional al volver a multimoneda y auditoría
    `CAMBIAR_MODO_MONEDA`. `updateGeneral` ya **no** acepta el modo (cierra el bypass).
  - `setupAdminService.guardarModoMonedaInicial` + `POST /api/setup/modo-moneda-inicial` (sin JWT).
- **Wizard (`setup.html`):** nuevo paso 4 "Moneda" (Empresa pasa a paso 5) con el copy exacto,
  default Multimoneda, que hace `POST /api/setup/modo-moneda-inicial`.
- **Configuración:** selector de modo + modal de confirmación; en solo_bcv oculta el bloque/nota de
  tasa USD y guarda solo BCV; refresca toda la UI vía `hydrateTasasDesdeServidorSilent` (evento `nexus:tasas`).
- **Reactividad UI:** `navbar` persiste `nexus_modo_moneda` y `loadRates` lo aplica; `preciosClient`
  expone `resolverTasasOperativas` (NEXUS-DUAL); `pos` oculta "Efectivo USD"; `inventario` arranca en $BCV
  y oculta tab "USD físico" y modo precio "$USD".

### Migración / despliegue
- **Sin migración nueva.** Reiniciar el backend (nuevas rutas/lógica) y recargar el renderer de Electron.
  Conviene limpiar `localStorage` del renderer solo si se ven tasas viejas (se re-hidratan solas al entrar).

### Decisiones de diseño durante la ejecución
- El forzado de `usd = bcv` se hace **en escritura y en lectura** (doble defensa); por eso los consumidores
  de bajo riesgo (dashboard/reportes/inventario.controller/productos/excel) no se modificaron: ya leen
  tasas unificadas en solo_bcv.
- El cambio de modo se sacó del PATCH genérico `/api/configuracion` hacia un endpoint dedicado para
  poder imponer la regla "caja cerrada" en backend.
- En el wizard el paso de moneda solo aparece en instalación nueva (admin recién creado); en
  re-ejecuciones de renovación se va directo a Empresa (el modo ya existe, default multimoneda).
- En POS se ocultó únicamente `efectivo_usd` (el requerimiento nombra "Efectivo USD"); Zelle y Cashea
  permanecen y operan con tasas unificadas.

### Pruebas manuales (resumen)
Ver sección "Cómo verificar que está completo" arriba. Smoke test de la cadena en solo_bcv:
`node -e "console.log(require('./backend/services/preciosService').calcularPrecios(1.2,30,89.5,89.5))"`
→ `precio_usd_efectivo=1.56`, `precio_usd_bcv=1.56`, `precio_bs=139.62`.

---

## Barrido de consistencia visual (2.ª iteración)

Tras el primer entregable quedaban referencias a USD físico/de mercado visibles en solo_bcv
(apertura de caja con 2 tasas, preview de inventario con columna USD, POS con "USD efectivo",
detalle de venta con "Tasa USD"/"Total USD"). Se resolvió con un mecanismo global reactivo:

### Mecanismo
- **`<body class="nexus-solo-bcv">`** lo administra `components/navbar.js` (`applyModoMonedaBodyClass`)
  de forma reactiva: al cargar (desde localStorage), tras hidratar tasas, en el evento `nexus:tasas`
  y en el evento `storage`. Persistente entre navegaciones SPA.
- **Regla CSS única** en `assets/css/components.css`:
  `body.nexus-solo-bcv .nexus-usd-only { display:none !important; }`.
- Cada elemento con referencia USD redundante se marca con la clase **`nexus-usd-only`**.

### Elementos ocultados en solo_bcv (clase `nexus-usd-only`)
- **POS (`pos.html`):** marquee "USD efectivo" (precio y total), banner verde "USD $X" del cobro,
  y la referencia "USD:" (tasa calle) del pie del cobro. La línea "Ref. USD BCV" se conserva
  (es el valor en $ de la cadena BCV). El carrito ya mostraba solo `Bs + $BCV ref.`
- **POS (`pos.js`):** en `renderCobroTabla` se ocultan los métodos en divisa de mercado
  (`efectivo_usd` y `zelle`); quedan solo métodos Bs + Cashea ($BCV) + Crédito (USD_BCV).
- **Inventario (`inventario.html`):** valores USD del preview (`.precio-valor-usd`), el sufijo
  "· USD abajo" de cada sub-etiqueta, el "/ USD" de los encabezados de tabla y el "· USD: …" de
  "Tasas activas". **(`inventario.js`)** la línea USD de cada fila (`celdaMonedaDoble`).
  (El tab "USD físico" y el modo de precio "$USD" ya se ocultaban por JS en la 1.ª iteración.)
- **Caja (`caja.html`):** en apertura se ocultan los campos "¿Cuántos dólares…?" y "Tasa USD de hoy"
  (la tasa USD se mantiene en el DOM = BCV para que el submit sea válido). En cierre se oculta el
  grupo "DÓLARES" del conteo. **(`caja.js`)** se oculta la línea de cuadre "Dólares (efectivo + Zelle)"
  y las filas USD del arqueo post-cierre.

### Detalle de venta — decisión por registro (no por modo)
`ventas.js` oculta "Tasa USD (Bs/USD)" y "Total USD (efectivo)" **cuando la venta tiene
`tasa_usd_aplicada == tasa_bcv_aplicada`** (venta unificada). Así las ventas multimoneda
**históricas** siguen mostrando su USD real aunque el sistema esté hoy en solo_bcv
(respeta HISTÓRICO INTACTO). No usa la clase global.

### Surfaces revisadas sin cambios
- **Dashboard:** ya es BCV-only (`monto()` siempre usa ref. $BCV); no muestra tasa USD aparte.
- **Reportes (historial de tasas):** la columna "Tasa USD" se mantiene; en solo_bcv las filas
  nuevas guardan `tasa_usd = tasa_bcv` y las históricas multimoneda no deben alterarse.
- **Cartera:** los métodos de abono en USD se conservan (el crédito puede pagarse en divisa;
  cambiarlos arriesga la lógica de cuentas por cobrar). Decisión conservadora.

---

## Backlog de correcciones — auditoría post-implementación (2026-06-06)

Revisión en solo lectura de backend + frontend (multimoneda vs solo_bcv). Items pendientes
para corregir en una fase posterior. Prioridad sugerida: **P1** (afecta operación o datos),
**P2** (UX/confusión frecuente), **P3** (borde / cosmético / deuda técnica).

### P1 — Operación y coherencia de datos

| ID | Problema | Dónde | Impacto | Corrección sugerida |
|----|----------|-------|---------|---------------------|
| **AUD-01** | El API de ventas **no rechaza** pagos `efectivo_usd` / `zelle` en modo `solo_bcv`. El POS los oculta en UI, pero un cliente HTTP o un modal de cobro desactualizado puede registrar cobro en USD físico/digital. | `backend/controllers/ventas.controller.js` (`create`) | Ventas incoherentes con el modo elegido; cuadre de caja con montos USD inesperados. | Tras `resolverTasasOperativas`, si `esSoloBcv(modo)` validar que ningún pago use métodos USD calle (`efectivo_usd`, `zelle`) y rechazar con 400. |
| **AUD-02** | Default `metodo_pago = 'efectivo_usd'` cuando el body lo omite. Inadecuado en `solo_bcv`. | `ventas.controller.js` ~344 | Ventas API/script sin `metodo_pago` quedan como USD físico. | Default a un método BCV (`efectivo_bs` o el primero válido del modo) según `modo_moneda_operacion`. |
| **AUD-03** | Servicios secundarios leen `obtenerTasasActuales` (BD cruda) **sin** `resolverTasasOperativas`. Hoy suele estar bien porque la escritura unifica USD=BCV, pero si la BD queda desincronizada no hay defensa en lectura. | `inventario.controller.js`, `productos.controller.js`, `dashboardService.js`, `reportesService.js`, `excelService.js` | Preview masivo de precios, dashboard o exportaciones podrían usar `tasa_usd ≠ tasa_bcv` con el sistema en solo_bcv. | Sustituir por `resolverTasasOperativas(db)` o documentar explícitamente “solo lectura cruda” con comentario NEXUS-DUAL si se mantiene a propósito. |
| **AUD-04** | Cierre de caja: `calcularDiferencias` y `actualizarBotonCerrarCaja` siguen exigiendo cuadre USD (`okUsd && okBs`) aunque el panel “Dólares” esté oculto con `nexus-usd-only`. | `frontend/pages/caja/caja.js` | Si `montosEsperados.efectivo_usd` o `zelle_usd` > 0 (legacy, API, apertura con saldo USD histórico), el botón puede quedar en estado “con diferencia” sin que el cajero vea por qué. | En `solo_bcv`, ignorar la tolerancia USD en el botón de cierre y/o forzar conteo USD esperado a 0 en la UI; alinear con backend si aplica. |

### P2 — Reactividad de UI y fugas visuales

| ID | Problema | Dónde | Impacto | Corrección sugerida |
|----|----------|-------|---------|---------------------|
| **AUD-05** | **Ventana de inconsistencia** entre `localStorage` (`nexus_modo_moneda`) y la clase `body.nexus-solo-bcv` hasta que termina `hydrateTasasDesdeServidorSilent()`. `aplicarVisibilidadModo()` en Configuración actualiza localStorage pero **no** llama `applyModoMonedaBodyClass()`. | `navbar.js`, `configuracion.js` | Al entrar a Caja/Inventario/POS justo tras cambiar modo o con caché viejo, pueden verse tasas USD, preview “USD abajo”, etc., hasta el hydrate. | Llamar `applyModoMonedaBodyClass` desde `aplicarVisibilidadModo` y/o disparar evento dedicado `nexus:modo-moneda` además de `nexus:tasas`. Aplicar body class de forma síncrona al cambiar modo. |
| **AUD-06** | POS: el listener `onTasas` hace **early return** si BCV y USD no cambian numéricamente. Al pasar a `solo_bcv` con tasas ya iguales, **no** se llama `renderCobroTabla()`. | `frontend/pages/pos/pos.js` (`onTasas` ~1907) | Con el modal de cobro abierto, Efectivo USD y Zelle pueden seguir visibles hasta cerrar y reabrir el modal. | Escuchar cambio de modo (`nexus:modo-moneda` o comparar modo en el evento) y forzar `renderCobroTabla()` + reset de `activeMetodo` si el método activo quedó oculto. |
| **AUD-07** | Detalle de venta: con `ventaUsdRedundante` se ocultan Tasa USD y Total USD (efectivo), pero **Subtotal USD** sigue mostrándose siempre. | `frontend/pages/ventas/ventas.js` (~433) | En ventas nuevas solo_bcv el detalle sigue mostrando una línea “Subtotal USD” redundante. | Ocultar Subtotal USD bajo la misma condición `ventaUsdRedundante` (o renombrar a “Subtotal ref.” si aplica). |
| **AUD-08** | Navbar muestra **solo** tasa USD BCV incluso en **multimoneda**. No hay display de tasa USD de mercado en el header. | `frontend/components/navbar.js` (`renderNavbar`) | Regresión UX para operadores multimoneda que necesitan ver ambas tasas sin ir a Configuración. | Restaurar badge/input USD mercado en multimoneda; ocultarlo con `nexus-usd-only` o lógica equivalente en solo_bcv. |
| **AUD-09** | Inventario: al cambiar a `solo_bcv` con el wizard abierto, `aplicarVisibilidadModoInventario` oculta el tab “USD físico” pero **no** resetea `state.modoMonedaCosto` si ya estaba en `usd_fisico`. | `frontend/pages/inventario/inventario.js` | Estado interno en modo que la UI ya no muestra; confusión al guardar producto o al volver a multimoneda. | En `aplicarVisibilidadModoInventario`, si `solo_bcv` y `modoMonedaCosto === 'usd_fisico'`, llamar `cambiarModoMonedaCosto(host, 'bcv')` (y análogo para `modoPrecios === 'usd'`). |
| **AUD-10** | Devoluciones en Ventas: el selector de método sigue ofreciendo `efectivo_usd` sin adaptar al modo. | `frontend/pages/ventas/ventas.html`, `ventas.js` | En solo_bcv el usuario puede intentar devolver en USD físico desde la UI. | Ocultar opciones USD calle en solo_bcv (CSS/JS) y validar en backend si hay endpoint de devolución. |

### P3 — Deuda técnica, bordes y documentación

| ID | Problema | Dónde | Impacto | Corrección sugerida |
|----|----------|-------|---------|---------------------|
| **AUD-11** | `preciosClient.resolverTasasOperativas` existe (NEXUS-DUAL) pero **ningún módulo lo invoca**; todo pasa por `NexusComponents.loadTasasLocal()`. | `frontend/services/preciosClient.js` | Riesgo futuro si alguien calcula con tasas crudas sin pasar por el chokepoint del navbar. | Usar `resolverTasasOperativas(loadTasasLocal())` en inventario/POS al calcular, o documentar que `loadTasasLocal` es el único punto válido. |
| **AUD-12** | Wizard: renovación de licencia (`adminPendiente === false`) salta el paso Moneda y va directo a Empresa. El modo queda en default BD (`multimoneda`). | `frontend/setup.html` (`proceedAfterLicense`) | Comportamiento esperado en re-instalación, pero un negocio que reinstale sin recrear admin nunca ve el paso Moneda en wizard. | Documentar en UI o ofrecer enlace a Configuración → Tasas; opcional: detectar si modo nunca se “confirmó” en wizard. |
| **AUD-13** | Criterio `ventaUsdRedundante` usa igualdad exacta `Math.round(tasa * 10000)`. Pequeñas diferencias de redondeo históricas podrían mostrar líneas USD en ventas que en la práctica son unificadas. | `frontend/pages/ventas/ventas.js` | Falso negativo: ocultar USD cuando no debería, o falso positivo: mostrar USD redundante. | Tolerancia ε (ej. diferencia < 0.0001) o flag explícito en BD si se añade en el futuro (sin tocar migraciones 001–026). |
| **AUD-14** | POS al abrir cobro asigna `activeMetodo = COBRO_TABLA_ORDEN[0]` (`punto`). Correcto hoy, pero `setCobroActiveMetodo` no valida si el método está permitido en el modo actual. | `frontend/pages/pos/pos.js` | Si en el futuro el primer método de la lista fuera USD-only, volvería el bug de fila activa invisible. | Helper `primerMetodoCobroVisible()` que respete `solo_bcv`. |
| **AUD-15** | Toast “Carrito recalculado con nuevas tasas” en POS dispara en **cualquier** `nexus:tasas`, incluido hydrate al entrar a la página (si las tasas cambian respecto a 0). | `frontend/pages/pos/pos.js` (`onTasas`) | Ruido UX al navegar o al cambiar solo el modo sin cambio numérico de tasa. | Suprimir toast en hydrate silencioso o si solo cambió el modo. |
| **AUD-16** | Plan/decisión §7 (FASE 5) dice conservar **Zelle** en solo_bcv; la 2.ª iteración lo oculta junto con `efectivo_usd` en `renderCobroTabla`. | `pos.js`, este documento § líneas 105–107 vs §284–285 | Documentación interna contradictoria; producto puede haber cambiado de opinión sin actualizar decisiones. | Decidir política final (¿Zelle sí o no en solo_bcv?) y alinear código + este plan. |
| **AUD-17** | Sección “Estado real del código” al inicio de este archivo está **desactualizada** (dice que no existe `resolverTasasOperativas`, que `loadRates` no es consciente del modo, etc.). | `docs/PLAN_SOLO_BCV.md` § líneas 21–59 | Confunde futuras lecturas del plan. | Archivar o marcar como histórico el bloque inicial; mantener solo “Estado final” + backlog como referencia viva. |
| **AUD-18** | `configuracion.js` → `aplicarVisibilidadModo` no sincroniza `document.body.classList` con el modo hasta el hydrate posterior. | `configuracion.js` | Misma clase de problema que AUD-05, vista desde pestaña Tasas sin recargar otras páginas ya montadas. | Unificar con AUD-05: evento global de modo + body class inmediata. |
| **AUD-19** | Lista de ventas (`textoMontoListaVenta`) sigue mostrando montos “$ X USD” para ventas `efectivo_usd`/`zelle` sin distinción por modo. Correcto para histórico multimoneda; en ventas nuevas solo_bcv no deberían existir esos métodos si AUD-01 se corrige. | `frontend/pages/ventas/ventas.js` | Solo informativo tras corregir AUD-01; no es bug si el histórico se respeta. | Ninguna acción salvo validar que no entren ventas USD nuevas en solo_bcv. |
| **AUD-20** | Cartera y Clientes conservan abonos en Efectivo USD / Zelle en solo_bcv (decisión conservadora). Puede confundir a usuarios que eligieron “solo bolívares”. | `cartera.html`, `clientes.html` | No es bug de cálculo; inconsistencia de expectativa de producto. | Copy de ayuda en Configuración (“en Solo BCV los abonos en USD siguen disponibles para cartera”) u ocultar métodos USD en abonos si negocio lo confirma. |

### Superficies sin `nexus-usd-only` (revisar si deben ocultarse en solo_bcv)

Checklist para un tercer barrido visual. Hoy **intencionalmente sin cambio** salvo que producto decida lo contrario:

- [ ] **Cartera** — métodos de abono USD (`AUD-20`)
- [ ] **Clientes** — pago/abono en `efectivo_usd`, `zelle`
- [ ] **Ventas** — lista y devoluciones (`AUD-07`, `AUD-10`)
- [ ] **Reportes** — columna Tasa USD (histórico; filas nuevas ya tienen USD=BCV)
- [ ] **Dashboard** — verificar que no reaparezca tasa USD suelta tras cambios futuros
- [ ] **Configuración** — bloque USD ya se oculta por JS en pestaña Tasas (además del modo)
- [ ] **Factura/PDF** — revisar plantillas en `resources/templates/` si muestran “USD efectivo” en tickets solo_bcv
- [ ] **Impresión ticket POS** — misma revisión que PDF

### Orden de corrección recomendado

1. **AUD-05 + AUD-18** — body class y evento `nexus:modo-moneda` (desbloquea la mayoría de fugas visuales).
2. **AUD-06 + AUD-14** — POS cobro reactivo al modo.
3. **AUD-01 + AUD-02** — validación backend ventas (cierre de bypass API).
4. **AUD-04** — cierre de caja sin cuadre USD fantasma en solo_bcv.
5. **AUD-07, AUD-08, AUD-09, AUD-10** — pulido por pantalla.
6. **AUD-03, AUD-11, AUD-16, AUD-17** — deuda técnica y alineación documentación.

### Criterio de “hecho” para cerrar este backlog

- [ ] Cambiar modo con caja cerrada: **cero** parpadeo de USD redundante en Caja, Inventario, POS y Ventas (detalle) durante 5 s tras confirmar.
- [ ] Modal de cobro POS abierto durante cambio de modo: métodos USD calle desaparecen sin recargar página.
- [ ] `POST /api/ventas` con pago `efectivo_usd` en `solo_bcv` → **400** con mensaje claro.
- [ ] Cierre de caja en solo_bcv sin ventas USD: botón de cierre coherente sin exigir cuadre USD invisible.
- [ ] Multimoneda: navbar muestra **dos** tasas (o decisión explícita documentada de no hacerlo).
- [ ] Este documento: decisiones §7 y §284–285 alineadas (Zelle); bloque inicial marcado como histórico.
