# -*- coding: utf-8 -*-
"""Recompone docs/AUDITORIA-TECNICA-NEXUS-CORE.md con núcleo narrativo + anexos de calidad."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "AUDITORIA-TECNICA-NEXUS-CORE.md"
CORE = ROOT / "docs" / "_audit_insert_core.md"
CUR = OUT.read_text(encoding="utf-8") if OUT.exists() else ""

ANEXO_E = r"""
## Anexo E — Modelo de amenazas (STRIDE) aplicado a Nexus Core

Este anexo adapta el modelo **STRIDE** (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege) al contexto **POS local** donde el backend solo escucha en **127.0.0.1** y el usuario opera en una estación Windows potencialmente compartida físicamente con el comercio.

### E.1 Spoofing (suplantación)

**Descripción del riesgo:** un atacante con código en el renderer podría intentar reutilizar un JWT robado para actuar como otro usuario. El vector principal es **compromiso del proceso Chromium** (extensión maliciosa en desarrollo, malware, o bug XSS si se insertara HTML no confiable).

**Controles existentes:** el token viaja en cabecera `Authorization: Bearer`; no está en URL; las reglas del proyecto prohíben volcar datos de API en `innerHTML` sin sanitizar. El login está **rate-limited**.

**Brecha residual:** `localStorage` es legible para cualquier script en el origen `file://` si lograra ejecutarse en el renderer. La superficie se reduce con **no third-party scripts** en producción y políticas de equipo limpio.

**Recomendaciones:** mantener revisión periódica de `pos.js` y pantallas de alto tráfico; valorar **httpOnly cookies** solo si se rediseña arquitectura (hoy no aplica por `file://`); en despliegues futuros con dominio, reevaluar.

### E.2 Tampering (manipulación)

**Descripción del riesgo:** alterar requests HTTP al API local (montos, `sesion_caja_id`, descuentos). Parte de la protección es **validación en servidor** (precios desde catálogo/tasas, id líneas, límites descuento).

**Controles existentes:** guardas en `ventas.controller` (sesión caja vs body); devoluciones usan precios del servidor; `PreciosService` recalcula desde costos y tasas — el cliente no fija la tasa BCV usada en cálculo definitivo.

**Brecha residual:** usuario técnico podría enviar requests artesanales contra `127.0.0.1` desde la misma máquina — en práctica equivalente a acceso DB físico; mitigación organizacional (roles, auditoría, CCTV procedimiento).

### E.3 Repudiation (repudio)

**Descripción del riesgo:** un operador niega haber realizado una venta o ajuste.

**Controles existentes:** tabla `auditoria` y timestamps en entidades; logs winston en servidor (sin datos sensibles). Login registra evento.

**Brecha residual:** múltiples personas con el mismo usuario comparten responsabilidad — mitigación: **usuarios individuales** y política de no compartir credenciales.

### E.4 Information disclosure (divulgación de información)

**Descripción del riesgo:** exposición de estructura de BD o stack en errores.

**Controles existentes:** `errorHandler.middleware.js` clasifica errores PostgreSQL y red; mapea `23514`, `23505` (stock / idempotencia) a mensajes UX; 503 para **DB unavailable** sin filtrar host/puerto en producción.

**Brecha residual:** modo desarrollo puede mostrar más detalle — asegurar `NODE_ENV=production` en builds release.

### E.5 Denial of service (denegación de servicio)

**Descripción del riesgo:** agotar PostgreSQL o el pool Node.

**Controles existentes:** pool con límites y listener `$pool.on('error')`; migraciones y reportes pesados deben monitorearse en hardware modesto.

**Brecha residual:** no hay **quota por usuario** en API — riesgo bajo en uso legítimo de un solo puesto; scripts maliciosos locales podrían spamear; mitigación: endurecer SO y antivirus.

### E.6 Elevation of privilege (elevación)

**Descripción del riesgo:** usuario con permiso limitado obtiene permiso administrativo.

**Controles existentes:** JWT contiene `permisos` efectivos al login; rutas usan `requirePermission`. Override por `permisos_override` en BD.

**Brecha residual:** **revocación no instantánea** hasta expirar JWT — documentado como TODO (blacklist/refresh). Riesgo operativo: admin desactiva usuario pero token sigue válido hasta **12h** por defecto.
"""

ANEXO_F = r"""
## Anexo F — Atributos de calidad ISO/IEC 25010 (evaluación cualitativa)

Evaluación orientada a **software de facturación** en entorno retail Venezuela.

### F.1 Adecuación funcional

- **Completitud:** módulos POS, inventario, compras, cartera, caja multimoneda, reportes Excel/PDF, Cashea, licencia — conjunto sólido para operación de tienda única.
- **Corrección:** lógica monetaria centralizada en servicios; riesgo residual en divergencia FE/BE si se edita solo un lado.
- **Pertinencia:** orientado a multimoneda BCV/USD y crédito interno — encaje alto con requerimiento de mercado local.

### F.2 Eficiencia de desempeño

- Índices en migraciones **013** y **026** para búsqueda y consultas de ventas.
- Reportes agregados pueden crecer en tiempo lineal con historial — considerar **rango de fechas obligatorio** en UI (verificar en cada pantalla).

### F.3 Compatibilidad

- Coexistencia Win7+ declarada en `package.json`; PostgreSQL externo o portátil.
- Riesgo: **versión `pg_dump` vs servidor** en backups — variable `NEXUS_PG_BIN_DIR` documentada en `.env.example`.

### F.4 Usabilidad

- SPA por hash; sin framework — curva de aprendizaje depende de formación.
- POS con archivo grande (`pos.js`) — beneficio: todo en un lugar; coste: mantenimiento requiere disciplina.

### F.5 Fiabilidad

- Transacciones `db.tx` en ventas y flujos críticos; idempotencia; pool resiliente.
- Single point of failure: una instancia PostgreSQL en el equipo — mitigación: **backups automáticos** y copias fuera del disco.

### F.6 Seguridad

- Véase Anexo E. Confianza en red local **no expuesta** intencionalmente.
- JWT y bcrypt; licencia Ed25519 offline.

### F.7 Mantenibilidad

- Modularidad por `controllers`/`services`/`routes`.
- Duplicación **telefonoVe** y **precios** — protocolo NEXUS-DUAL en reglas del repo.
- Ausencia `lib/definitions.ts` — deuda documental.

### F.8 Portabilidad

- Electron empaquetado; dependencia principal Windows. Linux no es objetivo declarado en el manifiesto analizado.
"""

ANEXO_G = """
## Anexo G — Controles financieros y reconciliación (procedimientos auditables)

### G.1 Conciliación ventas vs detalles

**Objetivo:** para cada `venta_id`, la suma de subtotales en `detalles_ventas` (en la moneda/regla usada al persistir) debe ser coherente con cabecera `ventas`.

**Procedimiento:** exportar vía reportes o SQL controlado; tolerancia de redondeo acordada (p. ej. ±0.02 ref. BCV).

**Si falla:** investigar venta manual en BD, bug de versión cliente viejo, o migración incompleta.

### G.2 Conciliación ventas vs caja

**Objetivo:** movimientos de efectivo/digital registrados en la sesión deben poder trazarse a ventas del mismo período operativo.

**Procedimiento:** usar reportes de **cierre** y `historial-cierres-caja`; cruzar por `sesion_caja_id`.

### G.3 Tasas históricas vs venta

**Objetivo:** validar que `tasa_bcv_aplicada` (post-migración 030) y totales ref. BCV (029) son consistentes con política vigente al timestamp.

**Procedimiento:** muestreo de tickets por día; comparar con `historial_tasas` u origen configurado.

### G.4 Crédito: cuentas_cobrar vs venta

**Objetivo:** saldos pendientes deben reflejar ventas a crédito no canceladas.

**Procedimiento:** listado `deudas-clientes` vs suma `cuentas_cobrar` pendientes por cliente.

### G.5 Cashea: recálculo de prueba

**Objetivo:** verificar que desglose Cashea en venta coincide con `casheaService` usando mismos inputs persistidos.

**Procedimiento:** extraer JSON o columnas de la venta; pasar por endpoint `POST /api/cashea/calcular` o rutina soporte; comparar comisiones y cuotas.

**Nota:** TTL caché 5 min — si hay discrepancia inmediata tras cambio de config, esperar o reiniciar backend.

### G.6 Inventario: stock vs movimientos

**Objetivo:** `productos.stock_actual` coherente con suma entradas/salidas auditadas.

**Procedimiento:** por SKU de alto rotación, sumar `ajustes_inventario` y líneas venta/devolución en ventana temporal.

### G.7 Devoluciones vs venta origen

**Objetivo:** cantidades devueltas ≤ cantidades vendidas por línea.

**Procedimiento:** ya forzado en controlador; en auditoría, muestrear tickets con devolución parcial.

### G.8 Compras vs costo producto

**Objetivo:** recepción actualiza costo/stock según política de negocio implementada.

**Procedimiento:** traza `compras` → recepción → `productos`/`moneda_costo` (post-028).

### G.9 Backup restauración

**Objetivo:** respaldo `pg_dump` recuperable.

**Procedimiento:** restaurar en instancia de prueba; validar conteo de ventas último día.

### G.10 Permisos efectivos

**Objetivo:** usuario desactivado no opera.

**Procedimiento:** login debe rechazar `activo=false`; recordar que JWT previo puede vivir hasta `JWT_EXPIRES_IN`.

### G.11 Licencia y reloj (trial)

**Objetivo:** trials no abusar de manipulación de reloj sin detección razonable.

**Procedimiento:** revisar comportamiento `licenciaService` cuando hay red vs sin red (documentado en código).

### G.12 Integridad idempotencia

**Objetivo:** misma `idempotency_key` + usuario no duplica venta.

**Procedimiento:** prueba doble POST en entorno de prueba; esperar 200/201 con bandera `idempotent_replay`.

### G.13 Anulación venta con crédito

**Objetivo:** estados `cuentas_cobrar` y reversa coherentes (parche 022).

**Procedimiento:** anular venta de prueba a crédito; verificar saldo y estado.

### G.14 Descuentos máximos

**Objetivo:** respeto de `venta_descuento_max_pct` y totales en BS cliente (015).

**Procedimiento:** intentar superar tope en POS — debe fallar o cap en servidor.

### G.15 Sesiones huérfanas

**Objetivo:** no queden sesiones `abierta` indefinidamente tras crash.

**Procedimiento:** verificar cleanup al arranque y rutas admin de **forzar cierre** documentadas en `caja.routes.js`.
""".strip()

ROUTES_TABLE = r"""
## Anexo H — Catálogo de rutas HTTP (backend Express)

Prefijo **`/api`**: las rutas listadas bajo routers montados tras `requireAuth` exigen JWT salvo indicación contraria.

| Método | Ruta aproximada | Permiso / notas |
|--------|-----------------|------------------|
| POST | `/api/auth/login` | Público, rate limit |
| GET | `/api/auth/verify` | Auth |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/licencia/estado` | Uso desde Electron sin sesión usuario |
| POST | `/api/licencia/activar` | `usuarios_all` |
| POST | `/api/licencia/activar-inicial` | Activación primera |
| GET | `/api/productos` | `inventario_ver` |
| GET | `/api/productos/:id` | `inventario_ver` |
| POST | `/api/productos` | `inventario_edit` |
| PATCH | `/api/productos/:id` | `inventario_edit` |
| DELETE | `/api/productos/:id` | Soft delete |
| GET | `/api/productos` (búsqueda POS) | Rutas adicionales en `productos.routes` |
| GET | `/api/ventas` | `ventas_ver` |
| POST | `/api/ventas` | `pos_sales` + caja abierta |
| GET | `/api/ventas/:id` | `ventas_ver` |
| POST | `/api/ventas/:id/anular` | `ventas_anular` |
| GET/POST/DELETE | `/api/ventas/suspendidas` | POS suspendidos |
| GET | `/api/inventario/categorias` | `inventario_ver` / edit |
| POST | `/api/inventario/categorias` | `inventario_edit` |
| GET | `/api/inventario/preview-ajuste` | Ajuste masivo preview |
| POST | `/api/inventario/ajuste-masivo` | `inventario_edit` |
| POST | `/api/inventario/ajuste-stock` | `inventario_edit` |
| GET | `/api/inventario/movimientos/:producto_id` | Historial |
| GET | `/api/inventario/valorizado` | Valorización |
| GET | `/api/clientes` | `clientes_ver` |
| POST | `/api/clientes` | `clientes_edit` |
| PATCH | `/api/clientes/:id` | `clientes_edit` |
| DELETE | `/api/clientes/:id` | Soft delete |
| GET | `/api/clientes/:id` | Perfil |
| GET | `/api/clientes/:id/perfil` | Perfil extendido |
| POST | `/api/clientes/:id/pagos` | Pagos |
| GET | `/api/clientes/cartera/resumen` | Cartera |
| GET | `/api/clientes/cartera/cuentas` | Cuentas |
| POST | `/api/clientes/cartera/cuentas/:cuentaId/abono` | Abono |
| GET | `/api/clientes/cartera/estado-cuenta/:clienteId` | PDF estado cuenta |
| GET-DELETE | `/api/proveedores`… | CRUD — **verificar permisos en controlador** |
| GET | `/api/caja/sesion-activa` | `pos_sales` |
| POST | `/api/caja/abrir` | `caja_operar` |
| POST | `/api/caja/cerrar` | `caja_operar` |
| GET | `/api/caja/resumen-cierre` | `caja_operar` |
| GET | `/api/caja/historial` | `caja_operar` |
| GET | `/api/caja/detalle/:id` | `caja_operar` |
| GET | `/api/caja/sesiones-abiertas` | `config_write` o `usuarios_all` |
| POST | `/api/caja/forzar-cierre/:id` | Admin |
| POST | `/api/caja/sesion/cerrar` | Cierre forzado |
| GET | `/api/configuracion` | `config_read` |
| PATCH | `/api/configuracion` | `config_write` |
| GET | `/api/configuracion/tasas-actuales` | `tasas_ver` |
| POST | `/api/configuracion/tasas` | `tasas_edit` |
| GET | `/api/configuracion/impuesto-iva-venta` | POS |
| POST | `/api/configuracion/impresora/prueba` | Impresión |
| GET/POST | `/api/configuracion/respaldo` | Backup manual |
| GET | `/api/usuarios` | Lista usuarios |
| POST | `/api/usuarios` | Alta |
| PATCH | `/api/usuarios/:id` | Edición |
| DELETE | `/api/usuarios/:id` | Baja |
| GET | `/api/usuarios/roles` | Roles |
| POST | `/api/usuarios/roles` | `usuarios_all` |
| POST | `/api/usuarios/:id/cambiar-password` | Cambio pass |
| GET | `/api/pdf/...` | Varios PDF |
| GET | `/api/dashboard/*` | KPIs, alertas, series temporales |
| GET | `/api/compras` | Listado compras |
| GET | `/api/compras/:id` | Detalle |
| POST | `/api/compras` | Crear |
| POST | `/api/compras/:id/recibir` | Recepción |
| POST | `/api/compras/:id/cancelar` | Cancelar |
| GET | `/api/cashea/config` | Config Cashea |
| PUT | `/api/cashea/config` | `requireCasheaAdmin` |
| POST | `/api/cashea/calcular` | Cálculo cuotas |
| GET | `/api/cashea/estadisticas` | Estadísticas |
| GET | `/api/cashea/pendientes` | Admin |
| POST | `/api/cashea/liquidar` | Admin |
| GET | `/api/cashea/liquidaciones` | Admin |
| GET | `/api/cashea/liquidaciones/:id` | Detalle liquidación |
| GET | `/api/devoluciones` | `ventas_ver` |
| POST | `/api/devoluciones` | `ventas_anular` (crear) |
| GET | `/api/devoluciones/:id` | Detalle |
| POST | `/api/devoluciones/:id/anular` | Anular devolución |
| GET | `/api/reportes/analytics/dashboard` | Analytics |
| GET | `/api/reportes/cierre/termico.pdf` | Ticket térmico cierre |
| GET | `/api/reportes/ventas-dia` | Reporte día |
| GET | `/api/reportes/ventas-periodo` | Periodo |
| GET | `/api/reportes/top-productos` | Ranking |
| GET | `/api/reportes/rentabilidad-categorias` | Rentabilidad |
| GET | `/api/reportes/sugerencia-reposicion` | Reposición |
| GET | `/api/reportes/deudas-clientes` | Morosidad |
| GET | `/api/reportes/historial-cierres-caja` | Cierres |
| GET | `/api/reportes/ventas-cajero` | Por cajero |
| GET | `/api/reportes/inventario-valorizado` | Valorizado |
| GET | `/api/reportes/historial-tasas` | Tasas |
| GET | `/api/reportes/ventas-rango` | Rango |
| GET | `/api/reportes/ventas-rango-resumen` | Resumen |
| GET | `/api/reportes/excel/*` | Múltiples export Excel (ver `reportes.routes.js`) |

*Nota:** el orden exacto de registro de rutas importa cuando hay parámetros (`:id`); consultar archivos en `backend/routes/` para rutas más específicas antes que genéricas.
"""

FRONT_ANNEX = r"""
## Anexo I — Superficie frontend (SPA)

Carga en `frontend/index.html`: scripts globales (`authClient`, `preciosClient`, `router`, componentes, **todas** las páginas JS) — patrón “carga upfront” para simplificar empaquetado Electron.

| Ruta hash | Archivo principal | Rol funcional |
|-----------|-------------------|---------------|
| `#/login` | `pages/login/login.html` | Autenticación |
| `#/dashboard` | `pages/dashboard/dashboard.js` | KPIs Chart.js |
| `#/pos` | `pages/pos/pos.js` | **POS** — archivo grande, carrito, pagos, Cashea |
| `#/inventario` | `pages/inventario/inventario.js` | Stock y ajustes |
| `#/ventas` | `pages/ventas/ventas.js` | Historial ventas |
| `#/clientes` | `pages/clientes/clientes.js` | CRM básico |
| `#/cartera` | `pages/cartera/cartera.js` | Cobranzas |
| `#/proveedores` | `pages/proveedores/proveedores.js` | Proveedores |
| `#/caja` | `pages/caja/caja.js` | Apertura/cierre |
| `#/compras` | `pages/compras/compras.js` | Órdenes |
| `#/reportes` | `pages/reportes/reportes.js` | Reportes |
| `#/configuracion` | `pages/configuracion/configuracion.js` | Tasas, empresa |
| `#/usuarios` | `pages/usuarios/usuarios.js` | ABM usuarios |
| `#/cashea` | `pages/cashea/cashea.js` | Panel Cashea |

**Consideración:** `ROUTE_PERM` en `router.js` alinea permiso mínimo por vista con sidebar — inconsistencia entre router y backend genera **403** confuso para el usuario; validar al agregar rutas nuevas.
"""

ELECTRON_ANNEX = r"""
## Anexo J — Proceso Electron y licencia

### J.1 Orden de arranque

1. `dotenv` desde raíz del proyecto.
2. `applyNexusBackupEnv()` — directorio respaldos y binarios `pg_dump`.
3. `startBackend()` desde `backend/server.js` — migraciones y `listen`.
4. **Licencia:** HTTP GET a `/api/licencia/estado` con HWID (estable + compat) calculado de interfaces de red, CPU, hostname — reintentos ante **`ECONNREFUSED`** para carrera con servidor aún no listo.
5. Splash → ventana principal o `activation.html`.

### J.2 HWID dual

**Razón:** licencias antiguas atadas a primera MAC; Windows puede reordenar — se envían dos candidatos en query cuando difieren.

### J.3 IPC expuesto al renderer (`preload.js`)

Canales permitidos: rutas de app, PDF buffer, HWID, versión, abrir externo, foco ventana — lista **cerrada**.

### J.4 Seguridad ventanas

`contextIsolation: true`, `nodeIntegration: false`; splash con `sandbox: true`; ventana activación con `sandbox: false` (revisar si puede endurecerse sin romper flujo).

### J.5 Apagado

`shutdownBackend` dispara `SyncService.runFullBackup` — respaldo al salvo dependiente de `pg_dump` disponible.
"""

ANEXO_L = r"""
## Anexo L — Servicios de dominio (backend/services)

Desglose orientado a **auditoría de facturación**: responsabilidad, datos que manipulan y riesgos.

### L.1 `preciosService.js`

Núcleo del **cálculo de precios de venta** en multimoneda Venezuela. Define redondeos (`redondearTasa4`), cadena desde costo y márgenes, conversión paralelo ↔ ref. BCV (`precioBolivaresRefBcvDesdeParalelo`, `totalBolivaresDesdeRefUsdBcv`), y lectura de tasas desde transacción. Toda modificación aquí **obliga** la misma lógica en `frontend/services/preciosClient.js`.

**Riesgos:** drift de céntimos si el POS calcula por otro camino; por eso el servidor recalcula en `ventas.controller`.

### L.2 `casheaService.js`

Reglas **Cashea** (niveles, comisiones, Express, próximo pago semanal). Usa **caché de configuración 5 min**. Para auditoría: validar que liquidaciones y ventas usen los mismos porcentajes que figuran en tabla `cashea_config` al momento de la operación (considerar TTL).

### L.3 `licenciaService.js`

Verificación **NC1** Ed25519, HWID, trial con tiempo red (múltiples formatos JSON de APIs públicas). No almacenar claves completas en logs (reglas del proyecto).

### L.4 `syncService.js`

Respaldo `pg_dump`, rotación de archivos, detección **version mismatch** cliente/servidor. Crítico para continuidad del negocio ante fallo de disco; riesgo operativo si backups fallan silenciosamente — revisar logs al cerrar app.

### L.5 `reportesService.js` + `reportes.controller.js` (acoplado)

Agregaciones para dashboard y exports; consultas pesadas posibles — índices **026** y filtros de fecha mitigan. Excel vía `excelService`.

### L.6 `excelService.js`

Generación de libros Excel (control precios, ventas, cierres, etc.). Riesgo: uso de memoria con datasets muy grandes — validar en hardware mínimo del cliente.

### L.7 `pdfService.js`

PDF facturas, estados de cuenta, documentos contables internos. Convive con rutas `pdf.routes.js` y generación cliente-side en algunos flujos — no duplicar fuentes de verdad de totales.

### L.8 `impresionService.js`

Integración **node-thermal-printer**; prueba desde configuración. Hardware fallido no debe corromper datos — operaciones deben ser idempotentes o con error claro.

### L.9 `inventarioService.js`

Ajustes de stock con auditoría; debe respetar **constraint stock ≥ 0** y triggers migración 019. Prohibido insertar movimientos que salten la lógica del servicio.

### L.10 `importProductosService.js`

Importación masiva de productos (Excel u otro); validación de códigos duplicados y tasas; riesgo de carga inconsistente si se interrumpe mitad de proceso — debe usar transacciones en el diseño actual (verificar al evolucionar).

### L.11 `alertasService.js`

Alertas de stock u operación (consumido por dashboard); no monetario directamente pero afecta reposición.

### L.M Middlewares transversales relevantes

- **`auth.middleware.js`:** JWT, rechazo de secret débil en producción.
- **`permissions.middleware.js`:** fusión **rol + override** + detección JSON legacy.
- **`cajaAbierta.middleware.js`:** determina `req.sesionCajaAbierta` para ventas.
- **`errorHandler.middleware.js`:** UX de errores BD y negocio en español, códigos `DB_UNAVAILABLE`, constraints conocidos.
- **`audit.middleware`:** registro de eventos sensibles (login, etc.).

### L.N Controladores como orquestadores

Los **controllers** deben permanecer delgados: parseo de request, llamada a servicio, respuesta. Lógica monetaria repetida entre controladores es señal de refactor hacia servicio común — el tamaño de `ventas.controller.js` amerita inventario de funciones en revisiones anuales.

"""

ENV_ANNEX = r"""
## Anexo K — Variables de entorno relevantes

Resumen alineado con `.env.example` del repositorio (no copiar valores secretos reales en documentación versionada).

| Variable | Rol |
|----------|-----|
| `JWT_SECRET` | Firma JWT — obligatorio fuerte en producción |
| `JWT_EXPIRES_IN` | TTL token (p. ej. `12h`) |
| `PG_*` / `DATABASE_URL` | Conexión PostgreSQL |
| `PG_POOL_MAX` | Tamaño pool |
| `PORT` | Puerto Express (default 3000) |
| `NODE_ENV` | `production` activa endurecimiento |
| `NEXUS_BACKUP_DIR` | Carpeta de salida `pg_dump` |
| `NEXUS_PG_BIN_DIR` / `NEXUS_PG_DUMP` | Binarios compatibles con servidor PG |
| `NEXUS_LICENSE_PUBLIC_KEY` | Override clave pública Ed25519 |
| `NEXUS_LICENSE_ADMIN_URL` / `NEXUS_ADMIN_API_KEY` | Solo flujos admin generación licencias |

**Prohibición de frontend:** el renderer no debe leer `process.env` (reglas del proyecto); configuración sensible fluye por IPC donde aplique.
"""

BACKEND_SUMMARY = r"""
## Anexo B — Inventario backend (resumen por carpeta)

| Carpeta / área | Archivos `.js` (aprox.) | Comentario auditoría |
|----------------|-------------------------|----------------------|
| `backend/config/` | database, logger, migrations, constants | Bootstrap BD, registro parches, logging estructurado |
| `backend/controllers/` | auth, ventas, productos, caja, clientes, cartera, inventario, reportes, compras, cashea, configuración, devoluciones, proveedores, usuarios | Capa HTTP → dominio; deben delegar SQL a servicios/transacciones |
| `backend/middleware/` | auth, permissions, caja abierta, audit, error, validation, cashea admin | Cadena de seguridad y contexto `req.user` |
| `backend/routes/` | ~15 routers | Montaje Express; revisar orden de rutas con `:id` |
| `backend/services/` | precios, cashea, licencia, pdf, excel, reportes, inventario, impresión, import, alertas, sync | Reglas de negocio y side effects |
| `backend/utils/` | asyncHandler, validators, formatters, calculations, telefonoVe | Duplicar cambios con frontend donde aplique regla NEXUS-DUAL |
| `backend/constants/` | rolePermissions | Presets permiso por nombre de rol |

El inventario **detallado archivo por archivo** puede regenerarse con `scripts/generate_audit_document.py` si se requiere trazabilidad de cada módulo; en informe humano suele bastar este **mapa por capa**.
"""


def main() -> None:
    core = CORE.read_text(encoding="utf-8")

    start_d = CUR.find("## Anexo D")
    start_e = CUR.find("## Anexo E")
    if start_d < 0 or start_e < 0:
        raise SystemExit("No se encontró Anexo D/E en el archivo actual; conserva una copia previa.")
    annex_d_cb = CUR[start_d:start_e].strip()

    head = """# Auditoría técnica extendida — Nexus Core (edición exhaustiva)

> **Versión del documento:** 2.1 (recompuesta)
> **Alcance:** análisis estático del repositorio; ~2600+ líneas con anexos operativos.
> **Advertencia:** no sustituye dictamen legal/fiscal ni pentest.

---

## Tabla de contenidos

1. Resumen ejecutivo  
2. Metodología y alcance  
3. Arquitectura de referencia  
4. Parte narrativa (producto, stack, procesos, riesgos — documento base)  
5. Anexos B–K (SQL, API, STRIDE, ISO, controles, rutas, frontend, Electron, entorno)  

---

## 1. Resumen ejecutivo

Nexus Core es una aplicación **desktop-first** para Windows (**Electron** + **Node.js** ≥ 18) con API **Express** en **127.0.0.1**, persistencia **PostgreSQL** (**pg-promise**), frontend **SPA vanilla** por **hash** (`#/pos`, etc.). Cubre POS multimoneda (BCV/USD), inventario, compras, cartera, caja, reportes Excel/PDF, **Cashea**, licenciamiento **NC1 Ed25519** y respaldos `pg_dump`.

**Fortalezas:** transacciones en ventas, **idempotencia** en POST venta, servicios de precios con aritmética explícita, migraciones con bootstrap atómico, CORS estricto, IPC acotado.

**Debilidades estructurales:** JWT con permisos hasta expiración sin blacklist; utilidades duales FE/BE deben mantenerse sincronizadas; `proveedores.routes` requiere verificación de permisos en controlador; suite de tests no evidenciada en el árbol.

---

## 2. Metodología y alcance

Revisión de código fuente en `backend/`, `frontend/`, `electron/`, `database/migrations/`; políticas en `.cursor/rules`; `.env.example`. Sin ejecución dinámica de carga ni revisión de instalación física en comercio.

---

## 3. Arquitectura de referencia (consolidada)

El patrón es **local-first**: PostgreSQL es fuente de verdad; Express valida toda operación monetaria; Chromium solo presenta y captura eventos.

```
Usuario → Chromium (renderer) → fetch http://127.0.0.1:PORT → Express → pg-promise → PostgreSQL
                ↑                                                           ↓
            IPC (HWID, PDF)                                    syncService → pg_dump
```

---

"""

    tail = """

---

## Cierre

Este informe **recompone** el análisis técnico con anexos revisados para reducir repetición mecánica y maximizar utilidad para **auditoría interna**, **soporte avanzado** y **diseño de release**. Regeneración parcial: `scripts/recompose_audit.py` (requiere copia previa del archivo con Anexos D–C–B largos en `AUDITORIA-TECNICA-NEXUS-CORE.md`).

*Fin del documento.*

"""

    pieces = [
        head,
        "# Parte narrativa — Descripción del producto (documento base v1)\n\n",
        core,
        "\n\n---\n\n",
        BACKEND_SUMMARY.strip(),
        "\n\n---\n\n",
        "## Anexo C — Catálogo de rutas (resumen)\n\n",
        "El detalle exhaustivo se lista en **Anexo H**. El router `server.js` monta `/api/auth` y `/api/licencia` antes del router protegido; el resto exige `Authorization: Bearer`.\n\n",
        "---\n\n",
        annex_d_cb,
        "\n\n---\n\n",
        ANEXO_E.strip(),
        "\n\n---\n\n",
        ANEXO_F.strip(),
        "\n\n---\n\n",
        ANEXO_G.strip(),
        "\n\n---\n\n",
        ROUTES_TABLE.strip(),
        "\n\n---\n\n",
        FRONT_ANNEX.strip(),
        "\n\n---\n\n",
        ELECTRON_ANNEX.strip(),
        "\n\n---\n\n",
        ANEXO_L.strip(),
        "\n\n---\n\n",
        ENV_ANNEX.strip(),
        tail,
    ]

    text = "".join(pieces)
    OUT.write_text(text, encoding="utf-8")
    n = len(text.splitlines())
    print(f"OK {OUT} ({n} líneas)")


if __name__ == "__main__":
    main()
