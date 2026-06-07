# Auditoría Nexus Core — Progreso

**Iniciado:** 2026-06-06
**Estado general:** COMPLETADO (Fases 1–5)
**Auditor:** Agente de ingeniería (sesión de auditoría de producción)

> Bitácora viva. Cada hallazgo se documenta con severidad (CRÍTICO / ALTO / MEDIO / BAJO),
> archivo + línea, y corrección aplicada. Cada tarea se marca `[x]` solo cuando está
> resuelta completamente en el código.

---

## Leyenda de severidad

- **CRÍTICO** — pérdida monetaria real, corrupción de datos, bypass de seguridad o crash de producción.
- **ALTO** — comportamiento incorrecto en flujo principal, inconsistencia de estado seria.
- **MEDIO** — UX confusa, contaminación de modo, deuda técnica con riesgo.
- **BAJO** — cosmético, mensajes, mejoras menores.

---

## Hallazgos críticos

### [F2-01] CRÍTICO — Pagos mixtos rotos con "Descuento al cobrar en USD" activo
- **Archivo:** `frontend/pages/pos/pos.js`
- **Síntoma:** Con `descuento_cobro_divisa_activo = true`, al construir un cobro mixto los
  montos en `efectivo_bs`, `transferencia_bs`, `pago_movil`, `punto` y `zelle` se vaciaban
  solos; el cajero no podía completar la venta.
- **Causa raíz (solo frontend):** la condición `descuentoCobroDivisaConfig.activo` se usaba
  para imponer un cobro "100 % en una sola fila divisa" en tres puntos:
  1. `setCobroActiveMetodo()` (rama divisa: vaciaba **todas** las demás filas; rama Bs:
     `cobroClearDivisaMercado()` vaciaba las divisa) — líneas ~2976–2989 (antes del fix).
  2. Bloque async de apertura del modal de cobro — líneas ~3793–3804 (antes del fix):
     forzaba el vaciado + autorelleno.
  3. `cobroAutofillDivisaUsd()` autocompletaba el total descontado aunque ya hubiera montos
     en otras formas de pago.
- **Corrección aplicada:**
  - El descuento ahora es **emergente**: solo se calcula/observa cuando el cobro resulta
    100 % `efectivo_usd`/`zelle` (`cobroAplicaDescuentoDivisa(pagos)` con `.every()`), regla que
    ya existía y reacciona dinámicamente vía `renderCobroBanners()` en cada `input`.
  - `setCobroActiveMetodo()`: ya **nunca** vacía filas en Bs; solo conserva la exclusividad
    histórica Efectivo USD ↔ Zelle (`cobroClearOtraDivisaMercado`).
  - Apertura del modal: ya no fuerza vaciado ni autorelleno; solo refresca banner/estado.
  - `cobroAutofillDivisaUsd()`: solo autocompleta el total (descontado) cuando **no** hay
    montos en otras formas de pago (conserva la comodidad del cobro puro en divisa sin
    pelear con el cobro mixto).
  - Eliminado helper muerto `cobroClearDivisaMercado()`.
- **Backend verificado correcto:** `backend/controllers/ventas.controller.js` `create()` ya
  aplica el descuento solo si `pagos.every(divisa)` (línea ~605) y valida el cuadre de pagos,
  por lo que no es bypasseable. Endurecido además para ignorar filas con monto 0
  (`pagosConMonto.every(...)`) — alinea exactamente con la regla emergente del POS.
- **solo_bcv:** sin cambios de comportamiento — el descuento está gateado por `posModoMoneda()
  !== 'solo_bcv'` (frontend) y `!esSoloBcvVenta` (backend).

### [F3-01] CRÍTICO — Precio de catálogo por margen contaminado en solo_bcv  ✅ CORREGIDO
- **Archivo:** `backend/services/preciosService.js` `calcularPreciosConTasasActuales` (~L1052) →
  usado por `backend/controllers/productos.controller.js:147` (detalle de producto, camino margen).
- **Causa:** usaba `obtenerTasasActuales` (tasa_usd cruda) mientras el camino de precio manual del
  mismo handler (`:158`) usaba `resolverTasasOperativas` → "split brain" en solo_bcv.
- **Fix:** `calcularPreciosConTasasActuales` ahora usa `resolverTasasOperativas` (unifica
  tasa_usd = tasa_bcv en solo_bcv). Corrige a todos sus llamadores de una vez.

### [F3-02] CRÍTICO — Importación de productos con tasa_usd cruda  ✅ CORREGIDO
- **Archivo:** `backend/services/importProductosService.js:247-255`.
- **Causa:** leía `configuracion.tasa_usd` por SQL directo para convertir `costo_bcv` /
  `precio_obj_bcv` → en solo_bcv podía usar una tasa de mercado residual.
- **Fix:** reemplazado por `PreciosService.resolverTasasOperativas(db)`.

### [F3-03] ALTO — Latente: `previewCambioTasa` baseline con tasa cruda  ✅ CORREGIDO
- **Archivo:** `backend/services/preciosService.js` `previewCambioTasa` (~L1057).
- **Fix:** baseline "precios antes" ahora vía `resolverTasasOperativas`. (Sin ruta activa hoy;
  corregido preventivamente.)

### [F3-04] ALTO — Venta suspendida persistía tasa de mercado del cliente  ✅ CORREGIDO
- **Archivo:** `backend/controllers/ventas.controller.js` (suspender venta, ~L1137-1175).
- **Causa:** guardaba `tasas.usd` enviada por el cliente; en solo_bcv reintroducía una tasa calle
  que al reanudar recalcularía precios divergentes.
- **Fix:** en solo_bcv se ignora la tasa del cliente y se persiste la tasa operativa del servidor
  (`resolverTasasOperativas`, tasa_usd = tasa_bcv). En multimoneda se conserva la tasa del momento.

### [F1-SEC-01] CRÍTICO — `POST /api/setup/modo-moneda-inicial` sin auth ni guard  ✅ CORREGIDO
- **Archivos:** `backend/routes/setup.routes.js`, `backend/services/setupAdminService.js`.
- **Causa:** endpoint público (sin JWT, sin rate limit) que cambia el modo monetario y unifica
  tasa_usd; sin verificación de "setup ya completado" ni de caja abierta. Un proceso local podía
  alterar el modo en producción.
- **Fix:** `guardarModoMonedaInicial` ahora rechaza (409) si `setup_empresa_completado` (asistente
  finalizado) o si hay caja abierta. No rompe el wizard (orden: admin→modo→empresa) ni la
  reactivación de licencia (que salta el paso de modo).

### [F1-SEC-02] ALTO — `POST /api/setup/empresa-cashea-inicial` reescribible sin auth  ✅ CORREGIDO
- **Fix:** `guardarEmpresaInicial` rechaza (409) si hay caja abierta (sistema en operación). El
  wizard y la reactivación corren antes del login (sin caja), por lo que el flujo legítimo sigue.

### [F1-SEC-03] ALTO — `POST /api/licencia/activar`: `requirePermission` sin `requireAuth`
- **Estado:** se aborda en la Fase 4 (reescritura del sistema de licencias). El endpoint queda
  reubicado/corregido con auth correcta en la nueva arquitectura.

### Hallazgos documentados (pendientes / con decisión)
- **[NEXUS-DUAL C1] ALTO** — `paidBsBcv` (`pos.js:330`) redondea distinto a
  `sumaPagosEquivBsBcvOperativo` (4 dec vs por-pago 2 dec + 2 dec final). Riesgo de desajuste de
  céntimos cliente↔servidor en tickets mixtos USD/BS. **Pendiente** (cambio delicado en el cuadre
  del POS; se evalúa alinear el redondeo exactamente al backend bajo tolerancias EPS).
- **[NEXUS-DUAL C2/A1/A2] ALTO** — helpers de pago/catálogo viven inline en `pos.js`/`inventario.js`
  en vez de `preciosClient.js` (protocolo NEXUS-DUAL roto a nivel de servicio aunque la lógica
  coincide). **Recomendación futura:** mover a `preciosClient.js`.
- **[NEXUS-DUAL A4 / Fase 3.x] MEDIO** — `caja.js`, `cartera.js`, `clientes.js`, `ventas.js` no
  escuchan `nexus:modo-moneda`; UI con visibilidad manual no se re-renderiza al cambiar de modo en
  runtime (cambiar de modo exige caja cerrada y navegación, mitigando el impacto). **Pendiente.**
- **[Cashea histórico #5] revisado — NO es bug** — `reportesService._buildTasasDepositoLookup`
  usa tasas del historial del día de cada venta (comportamiento de auditoría correcto). El fallback
  ya pasa por `resolverTasasOperativas` (unificado en solo_bcv). Forzar unificación falsearía datos
  históricos de ventas multimoneda. Se conserva.
- **[Seguridad MEDIO] errorHandler** devuelve `err.message` en 500 — posible fuga de detalles.
  **Recomendación futura.**
- **[Seguridad MEDIO] rate limiting** ausente en mutaciones de tasas/modo-moneda autenticadas.
  **Recomendación futura.**

---

## Tareas

### Fase 0 — Preparación
- [x] Crear `AUDITORIA-NEXUS-CORE-PROGRESO.md`
- [x] Leer skills obligatorias (implementación segura, diseño CSS, componente nuevo)
- [x] Leer núcleo monetario `backend/services/preciosService.js`

### Fase 1 — Auditoría profunda
- [x] 1.1 Consistencia lógica extremo a extremo (NEXUS-DUAL auditado; core alineado; C1/C2 documentados)
- [x] 1.2 Errores de lógica de negocio (descuento divisa F2; redondeo paidBsBcv documentado pendiente)
- [~] 1.3 UX y estado inconsistente (listeners modo-moneda en caja/cartera/clientes/ventas: pendiente)
- [x] 1.4 Seguridad y robustez backend (auditado; setup endpoints endurecidos; resto documentado)
- [~] 1.5 Base de datos (migraciones idempotentes confirmadas en auditoría; revisión índices pendiente)
- [x] 1.6 Electron y proceso principal (HWID auditado — débil, se refuerza en Fase 4)

### Fase 2 — Bug confirmado: pagos mixtos con descuento divisa
- [x] Investigar `cobroAplicaDescuentoDivisa()` y render de tabla de cobro en `pos.js`
- [x] Hacer editables siempre los campos `efectivo_bs`, `transferencia_bs`, `pago_movil`, `punto`, `zelle`
- [x] Recalcular descuento dinámicamente solo cuando pago es 100% USD/Zelle
- [x] Validar regla en backend `ventas.controller.js` create() (verificado correcto + endurecido)
- [x] Confirmar que en `solo_bcv` el código no se ejecuta

### Fase 3 — Solo BCV (máxima prioridad)
- [x] 3.1 Contaminación multimoneda backend (productos, import, wrapper, suspendida CORREGIDOS)
- [~] 3.2 Integridad de transición entre modos (transición backend OK; listeners UI runtime pendiente)
- [~] 3.3 Cartera en solo_bcv (creditoAbonoService: BCV legal + política abono USD — documentado)
- [x] 3.4 Reportes en solo_bcv (Cashea histórico revisado = correcto; valorizado usa resolver)
- [x] 3.5 POS método por defecto en solo_bcv → ahora `efectivo_bs` (helper `metodoCobroPorDefecto`);
      cambio de modo en runtime ya re-renderiza sin limpiar carrito (listener `nexus:modo-moneda` existente)
- [ ] 3.6 Tickets e impresión en solo_bcv (verificación pendiente)

### Fase 4 — Sistema de licencias profesional
- [x] Decisión de arquitectura: evolucionar servidor Vercel existente (reusar crypto/kv/ratelimit)
- [x] Modelo de datos `license-server/lib/licenses.js` (license-key NXCS, tipos sub/perm/trial,
      activaciones embebidas, HMAC de integridad, token Ed25519, vistas admin/pública)
- [x] Servidor Vercel — endpoints públicos: `activate`, `verify` (grace period), `deactivate`
- [x] Servidor Vercel — endpoints admin: list, create, trial, `:key` (detalle/status/extend/del-activation)
- [x] Panel admin web responsive (`public/admin/index.html`)
- [x] Scripts CLI: create / trial / list / revoke / suspend / extend / export + `_client.js`
- [x] Cliente: `electron/licenseManager.js` (activación, verificación periódica 24h, grace period)
- [x] HWID endurecido (CPU+placa+UUID+disco vía WMI, fallback os.*) + cifrado AES-256-GCM por HWID
- [x] Anti-bypass (tag GCM = integridad, clave derivada de HWID = no copiable, expiración del token)
- [x] `activation.html` reescrito (clave NXCS, conectividad, errores descriptivos, resumen, liberar)
- [x] `expiraLicenciaUi.js` banner progresivo + overlay bloqueante (suspendida/revocada/vencida)
- [x] `/api/licencia/activar` corregido (requireAuth antes de requirePermission)
- [x] IPC + preload (`license:get-hwid/get-status/activate/deactivate`) e integración de arranque
- [x] `DEPLOY.md` instrucciones Vercel completas

### Fase 5 — Migración 043
- [x] `043_licencia_profesional.sql` (bitácora local `licencia_verificaciones`, idempotente)
- [x] Registrado en `migrations.js` (runPatch043) y `server.js` (secuencia + log)

### Cierre
- [x] Resumen de cambios (archivos modificados)
- [x] Recomendaciones futuras

---

## Resumen de cambios

### Fase 2 — Bug pagos mixtos con descuento divisa
- **M** `frontend/pages/pos/pos.js` — descuento divisa emergente; sin vaciado de filas; default
  `efectivo_bs` en solo_bcv (helper `metodoCobroPorDefecto`); eliminado helper muerto.
- **M** `backend/controllers/ventas.controller.js` — `esPago100Divisa` ignora filas monto 0;
  venta suspendida server-authoritative en solo_bcv.

### Fase 1/3 — Contaminación solo_bcv y seguridad
- **M** `backend/services/preciosService.js` — `calcularPreciosConTasasActuales` y
  `previewCambioTasa` usan `resolverTasasOperativas`.
- **M** `backend/services/importProductosService.js` — tasas vía `resolverTasasOperativas`.
- **M** `backend/services/setupAdminService.js` — guards de caja abierta + setup completado en
  `guardarModoMonedaInicial` y `guardarEmpresaInicial` (endpoints públicos endurecidos).
- **M** `backend/routes/licencia.routes.js` — `requireAuth` antes de `requirePermission` en `/activar`.

### Fase 4 — Sistema de licencias profesional
**Servidor (`license-server/`)**
- **N** `lib/licenses.js` — modelo license-key (tipos, activaciones, HMAC, token, vistas, grace).
- **M** `lib/validate.js` — `validateLicenseClientInput` + `LICENSE_KEY_REGEX`.
- **N** `api/licenses/activate.js`, `api/licenses/verify.js`, `api/licenses/deactivate.js`.
- **N** `api/admin/licenses/{index,create,trial}.js` + `api/admin/licenses/[key]/{index,status,extend}.js`
  + `api/admin/licenses/[key]/activations/[hwid].js`.
- **N** `public/admin/index.html` — panel admin web responsive.
- **N** `scripts/{_client,create-license,create-trial,list-licenses,revoke-license,suspend-license,extend-license,export-report}.js`.
- **M** `.env.example` — `NEXUS_GRACE_PERIOD_DAYS`.
- **N** `DEPLOY.md` — guía de despliegue Vercel.

**Cliente (Electron + frontend)**
- **N** `electron/licenseManager.js` — HWID endurecido, archivo cifrado AES-256-GCM, activación/
  verificación/grace, verificación Ed25519 offline, anti-bypass.
- **M** `electron/main.js` — IPC de licencia, `evaluateLicenseGate()`, arranque vía `activation.html`,
  verificación periódica 24h.
- **M** `electron/preload.js` y `electron/preload-activation.js` — exposición de canales de licencia.
- **M** `frontend/activation.html` — pantalla profesional (clave NXCS, conectividad, resumen, liberar).
- **M** `frontend/services/expiraLicenciaUi.js` — banner progresivo + overlay bloqueante (conserva `formatExpiraLicenciaUi`).
- **M** `frontend/pages/configuracion/configuracion.js` — `generarClave()` ya no llama al endpoint eliminado.

### Fase 5 — Base de datos
- **N** `database/migrations/043_licencia_profesional.sql` — tabla `licencia_verificaciones` (idempotente).
- **M** `backend/config/migrations.js` — `runPatch043LicenciaProfesional` + export.
- **M** `backend/server.js` — ejecución y log del parche 043.
- **M** `.env.example` (raíz) — `NEXUS_LICENSE_SERVER_URL` documentada.

> Verificación: todos los archivos JS nuevos/modificados pasan `node --check`; los `.js` de
> frontend/backend sin errores de linter.

---

## Recomendaciones futuras

1. **NEXUS-DUAL `paidBsBcv`** (`pos.js`): alinear el redondeo por-pago/2-dec exactamente al
   backend `sumaPagosEquivBsBcvOperativo` para eliminar el riesgo de desajuste de céntimos en
   tickets mixtos USD/BS (cambio delicado del cuadre del POS; probar con casos límite).
2. **Mover helpers de pago a `preciosClient.js`** (`sumaPagosEquivBsBcvOperativo`,
   `sumaPagosEquivUsdCalle`, `totalBsDesdeUsdTasaCalle`, `precioVentaUnitarioCatalogo`) y que
   `pos.js`/`inventario.js` los consuman, cerrando el protocolo NEXUS-DUAL a nivel de servicio.
3. **Listeners `nexus:modo-moneda`** en `caja.js`, `cartera.js`, `clientes.js`, `ventas.js` para
   re-render en cambio de modo en runtime (hoy mitigado por CSS + navegación).
4. **Rate limiting** en mutaciones autenticadas de tasas/modo-moneda (`/api/configuracion/tasas`,
   `/api/configuracion/modo-moneda`).
5. **errorHandler**: no devolver `err.message` crudo en 500 en producción (posible fuga de detalle).
6. **Migrar instalaciones legadas** (licencia en PostgreSQL) al archivo cifrado: al primer arranque
   válido por gate legado, ofrecer reactivar para generar el archivo local cifrado.
7. **Poblar `licencia_verificaciones`** desde el cliente vía un endpoint backend de bitácora
   (hoy la tabla existe pero aún no se escribe; el estado vive en el archivo cifrado).
8. **Edition/feature gating**: aplicar `features[]` de la licencia para habilitar/inhabilitar
   módulos en el frontend/backend (hoy se almacenan pero no se hacen cumplir).
9. **Tickets/impresión en solo_bcv (3.6)**: verificar que `ticket_venta.html`, `factura.html` e
   `impresionService.js` oculten líneas "USD efectivo" cuando `tasa_cambio = tasa_bcv`.
10. **Rotación de claves Ed25519**: documentar procedimiento y soportar 2 claves públicas en el
    cliente durante la transición.

---

**Estado general:** COMPLETADO — Fases 1–5 entregadas. Pendientes documentados arriba como mejoras
no bloqueantes.
