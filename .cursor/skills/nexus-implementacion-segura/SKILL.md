---
name: nexus-implementacion-segura
description: >
  Activar cuando el usuario solicite implementar una funcionalidad nueva, modificar
  código existente, agregar tablas o campos a la BD, o crear nuevas rutas o componentes
  en Nexus Core. Ejecuta un protocolo de 7 fases de análisis antes de escribir código.
disable-model-invocation: false
---

# NEXUS-SKILL-01 · Protocolo de implementación antirregresión (7 fases)

Antes de escribir **una sola línea de código**, ejecutar las 7 fases **en orden**. No saltar ni combinar fases. Al terminar las fases 1–6: entregar **primero** el reporte técnico (incluye checklist Fase 6). **Después** entregar la implementación siguiendo el orden de la Fase 5 (A→G).

Coexistencia con reglas del repo: respetar `.cursor/rules/` (migraciones 001–026 inmutables; utilidades duales; seguridad Electron/CORS; `lib/definitions.ts`; logging/transacciones pg-promise).

---

## FASE 1 — Reformulación del requerimiento

Reescribir el requerimiento en términos técnicos precisos:

- ¿Qué entidad de negocio se ve afectada? (producto, venta, caja, cliente, licencia, etc.)
- ¿Es creación, modificación, eliminación o consulta?
- ¿Requiere cambios en BD (estructura o datos)?
- ¿Requiere nuevo endpoint REST o modificación de uno existente?
- ¿Requiere cambios en el frontend (nueva página, componente, lógica)?
- ¿Requiere cambios en Electron (IPC, main.js, preload)?

**Salida:** párrafo técnico de 3–5 líneas sin ambigüedades.

---

## FASE 2 — Mapa de dependencias cruzadas por capas

Trazar el flujo completo del cambio a través de las 4 capas de Nexus Core:

### [BD PostgreSQL]

- ¿Qué migración existente (001–026) es relevante?
- ¿Se requiere nueva migración? Si sí → identificar número **027+** (nunca alterar 001–026).
- ¿Qué tablas, columnas, índices o triggers se ven afectados?

### [Express Backend]

- ¿Qué archivo en `backend/routes/` se modifica o crea?
- ¿Qué controlador en `backend/controllers/` se afecta?
- ¿Qué servicio en `backend/services/` se usa o crea?
- ¿Qué middlewares aplican? (`requireAuth`, `requirePermission`, `cajaAbierta`, validation, audit, `asyncHandler`)

### [Electron IPC]

- ¿Nuevo canal IPC en `electron/main.js`?
- ¿Exponer en `preload.js` (`contextBridge`)?
- ¿Afecta arranque (`startBackend()`, `checkLicense()`, etc.)?

### [Frontend Vanilla JS]

- ¿Qué página en `frontend/pages/` se modifica?
- ¿Qué componente en `frontend/components/` se reutiliza o crea?
- ¿Qué servicio en `frontend/services/` (`authClient`, clientes de API, `telefonoVe`, etc.)?
- ¿Qué rutas en `frontend/router.js` y permisos `ROUTES_PERM`?

**Salida:** diagrama de texto o lista jerárquica con cada archivo afectado.

---

## FASE 3 — Verificación de duplicados en el árbol monolítico

El frontend carga scripts vía `index.html` (monolítico). Antes de crear función, clase o componente:

- Buscar si ya existe algo con el mismo propósito en `frontend/utils/`, `frontend/services/`, `frontend/components/`.
- Buscar lógica similar inline en `frontend/pages/[módulo]/`.
- Si hay duplicado: **reutilizar o refactorizar**, nunca copiar-pegar.
- Si se crea un nuevo `.js` en `frontend/`: incluirlo en `index.html` en **orden correcto** (dependencias primero).

**Salida:** lista de duplicados posibles o confirmación de ausencia.

---

## FASE 4 — Validación del contrato de datos en `lib/definitions.ts`

- Revisar `lib/definitions.ts`: ¿existen tipos para request/response y entidades involucradas?
- Si el tipo **ya existe**: usarlo sin romper consumidores.
- Si **necesita extensión**: campos opcionales + JSDoc/TS; no romper contratos que el frontend ya usa.
- Si **no existe**: crear el tipo **antes** del controlador.
- Alinear shape SQL ↔ tipo TS; si difiere, **mapear explícitamente** en el controlador/servicio.

**Salida:** tipos relevantes y confirmación de consistencia.

---

## FASE 5 — Orden de implementación: datos → lógica → UI

Implementación **siempre** en este orden. **Prohibido** empezar por el frontend.

| Paso | Ámbito | Acción |
|------|--------|--------|
| **A** | Migración SQL | Parche nuevo si aplica; registrar en `backend/config/migrations.js`; idempotente (`IF NOT EXISTS`, etc.). |
| **B** | `backend/services/` | Lógica de negocio y queries pg-promise; sin acoplar a Express (`req`/`res`). |
| **C** | `backend/controllers/` | Delegar al servicio; respuesta HTTP; sin negocio inline. |
| **D** | `backend/routes/` + `server.js` | Ruta con middlewares correctos; montada en el servidor. |
| **E** | `frontend/services/` | Cliente API autenticado (patrón `authClient`). |
| **F** | `frontend/pages/[módulo]/` | Consumir servicio; **no** `fetch()` directo en la página. |
| **G** | UI/eventos | DOM; errores vía `toast.js`. |

**Salida:** código de cada paso **en este orden** (tras el reporte de fases 1–6 y Fase 7).

---

## FASE 6 — Checklist mental de errores potenciales

Antes de entregar código, revisar cada ítem y marcar **`[✓]`** o **`[✗ PENDIENTE: …]`**.

### Seguridad

- [ ] ¿El endpoint tiene `requireAuth` y `requirePermission` correctos?
- [ ] ¿Inputs validados/sanitizados (p. ej. `validation.middleware.js`)?
- [ ] ¿El renderer evita XSS (sin `innerHTML` con datos de usuario)?
- [ ] ¿Riesgo de secretos o datos sensibles en log o DOM?

### Base de datos

- [ ] ¿Escrituras críticas en `db.tx()`?
- [ ] ¿Parche SQL idempotente?
- [ ] ¿Constraints de inventario/stock respetadas donde aplique?
- [ ] ¿Idempotencia de ventas respetada donde aplique?

### Frontend

- [ ] ¿Script nuevo en `index.html` en orden correcto?
- [ ] ¿Errores de red con `toast.js`, no `alert()`?
- [ ] ¿Hash-route y `ROUTES_PERM` actualizados si aplica?

### Electron

- [ ] ¿IPC nuevo en lista blanca de `preload.js`?
- [ ] ¿Sin exponer `ipcRenderer` directo al renderer?

### Dualidad

- [ ] ¿Se tocó utilidad dual (`telefonoVe`, formatters, validators, etc.)? Si sí → **ambas** capas sincronizadas o comentario `NEXUS-DUAL` según reglas del repo.

**Salida:** checklist con estado por ítem.

---

## FASE 7 — Reporte técnico final al desarrollador

Incluir:

### Resumen del cambio

- Una línea: qué se implementó.

### Archivos modificados

- Lista completa: nuevo / modificado / eliminado.

### Migraciones

- Número de parche (027+) si aplica y efecto en BD.

### Pasos de despliegue

- ¿Reinicio backend? ¿Reinicio Electron? ¿Limpiar `localStorage` del renderer?

### Riesgos identificados

- Posibles regresiones o efectos secundarios.

### Pruebas manuales recomendadas

- Flujo mínimo para validar el cambio.
- Flujo mínimo para validar que no se rompió lo existente.

---

## Notas operativas para el agente

1. **Herramientas:** usar búsqueda en repo (`grep`/exploración) para Fases 2–4 y 6.
2. **Alcance:** solo lo necesario para el requerimiento; no refactorizar sin pedirlo.
3. **Entrega:** orden sugerido en un mismo turno o mensajes consecutivos: (a) Fases 1–6 + Fase 7 estructurado; (b) implementación Fase 5 paso A→G.
