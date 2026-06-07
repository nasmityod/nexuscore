# Plan — Descuento al cobrar en divisa (USD / Zelle)

**Fecha:** 2026-06-06  
**Estado:** Especificación (pendiente de implementación)  
**Alcance:** Modo `multimoneda` únicamente

---

## 1. Contexto y problema

En modo **multimoneda**, Nexus Core calcula dos precios por producto a partir de la cadena de tasas:

| Precio | Origen | Ejemplo (Intercomunicador) |
|--------|--------|----------------------------|
| **Ref. $ BCV + Bs BCV** | Precio de etiqueta / factura / cobro en bolívares | $40,00 · Bs. 22.531,57 |
| **USD efectivo** | Brecha natural `tasa_bcv ÷ tasa_usd` | $36,05 |

Muchos negocios en Venezuela aplican una política comercial distinta: **cobran el precio BCV en bolívares, pero al pagar en efectivo USD o Zelle aplican un descuento fijo** (típicamente 20 %) sobre la ref. $ BCV — no sobre la brecha de tasas.

```
Ref. BCV:     $40,00
Descuento:    20 %
USD a cobrar: $32,00   ← lo que el cliente espera
Sistema hoy:  $36,05   ← brecha de tasas (563,29 / 625 ≈ 10 %)
```

Hoy **no existe** esa regla. El campo **Desc. global %** del POS no sirve porque reduce **BCV y USD a la vez**, alterando facturas y cobros en bolívares.

---

## 2. Objetivo

Agregar una opción en **Configuración**, activable y editable, que permita:

1. **Activar / desactivar** la regla (sin impacto cuando está off).
2. **Editar el porcentaje** (ej. 20 %, 15 %, 0 %).
3. Aplicar el descuento **solo al cobrar en Efectivo USD o Zelle**.
4. Operar **exclusivamente en modo `multimoneda`**.

En modo **`solo_bcv`**, esta regla **no aplica**: allí USD físico y Zelle están deshabilitados y un **descuento global** del POS (o por línea) es suficiente para cualquier promoción.

---

## 3. Regla de negocio

### 3.1 Cuándo aplica

| Condición | ¿Aplica descuento divisa? |
|-----------|---------------------------|
| `modo_moneda_operacion = multimoneda` | Evaluar regla |
| `modo_moneda_operacion = solo_bcv` | **No** — ignorar configuración |
| Config `descuento_cobro_divisa_activo = false` | **No** |
| Config activa + `descuento_cobro_divisa_pct = 0` | **No** (equivalente a desactivado) |
| Pago **100 %** Efectivo USD | **Sí** |
| Pago **100 %** Zelle | **Sí** |
| Pago en Bs (efectivo, PM, transferencia, punto) | **No** |
| Cashea | **No** |
| Crédito ($ BCV / cartera) | **No** |
| Pago **mixto** (USD + Bs, USD + otro) | **No** en v1 — cobro estándar actual |

> **v1:** Solo ventas cobradas al **100 %** en `efectivo_usd` o `zelle`. Los pagos mixtos quedan fuera para no ambigüedad en caja. Ampliación futura opcional.

### 3.2 Fórmula

Sobre el total de cabecera **después** del descuento global del POS (si hubiera) y del IVA:

```
totalUsdCobro = round4( totalUsdBcvRef × (1 − descuento_cobro_divisa_pct / 100) )
```

- `totalUsdBcvRef` = suma de líneas en ref. $ BCV (lo que ya muestra el banner verde «TOTAL $… BCV»).
- `totalBsBcv` y `totalUsdBcvRef` en factura **no cambian**.
- El descuento divisa **no sustituye** al descuento global; se aplica **después** sobre la ref. BCV para obtener el USD a cobrar.

### 3.3 Ejemplo completo

**Producto:** Intercomunicador · 1 und.  
**Tasas:** BCV 563,2892 · USD mercado 625,0000  
**Config:** activo = true · pct = 20

| Concepto | Valor |
|----------|-------|
| Ref. $ BCV (cabecera) | $40,00 |
| Bs BCV a cobrar (si paga en Bs) | Bs. 22.531,57 |
| USD efectivo cadena (sin regla) | $36,05 |
| **USD a cobrar (con regla)** | **$32,00** |
| Factura / líneas impresas | $40,00 ref. BCV · Bs. 22.531,57 |

---

## 4. Configuración en UI

**Ubicación sugerida:** Configuración → pestaña **Ventas** o **Tasas / Moneda** (junto al selector multimoneda / solo BCV).

### 4.1 Controles

| Control | Tipo | Clave BD (`configuracion`) | Default |
|---------|------|----------------------------|---------|
| Activar descuento al cobrar en USD/Zelle | Toggle (checkbox) | `descuento_cobro_divisa_activo` | `false` |
| Porcentaje de descuento | Input numérico 0–100, step 0.5 | `descuento_cobro_divisa_pct` | `0` |

### 4.2 Comportamiento de la UI

- La sección completa lleva clase `nexus-multimoneda-only` (visible solo si `modo_moneda_operacion = multimoneda`).
- En **solo BCV**: ocultar la sección y mostrar nota breve: *«En modo Solo BCV use el descuento global del POS o el descuento por línea.»*
- Validar en servidor: `descuento_cobro_divisa_pct` entre 0 y 100; si `activo = false`, el % se ignora aunque esté guardado.
- Tope opcional alineado con `venta_descuento_max_pct` (actualmente 25 % en BD) — el % divisa no debe superar ese tope salvo rol admin (misma política que descuento global).

### 4.3 Texto de ayuda (copy sugerido)

> Al activar, las ventas cobradas **solo** en Efectivo USD o Zelle usarán un total en dólares igual al **precio ref. $ BCV menos este porcentaje**. El precio en bolívares y en la factura no cambia.

---

## 5. Cambios en Punto de Venta

### 5.1 Carrito (sin cambio visual principal)

- Al agregar productos, el carrito sigue mostrando **precios BCV** (Bs + ref. $ BCV).
- El banner del carrito puede seguir mostrando ambos totales; el USD «cadena» ($36,05) puede mostrarse tachado o reemplazarse por el USD «con regla» ($32) **solo cuando la config esté activa** — decisión de UX en implementación.

### 5.2 Modal de cobro (cambio principal)

Cuando la regla está activa y el cajero selecciona **Efectivo USD** o **Zelle**:

| Elemento | Comportamiento |
|----------|----------------|
| Banner verde «USD $…» | Muestra `totalUsdCobro` ($32), no el USD cadena ($36,05) |
| Banner rojo «Total a cobrar (BCV)» | Sin cambio (Bs. 22.531,57) |
| Banner naranja «DESCUENTO» | Mostrar el % divisa y el monto USD descontado respecto a ref. BCV |
| Validación al confirmar | Comparar pagos USD contra `totalUsdCobro` |
| Autofill «Su pago» | Prellenar con `totalUsdCobro` |

Si el método es Bs, Cashea o crédito: comportamiento **idéntico al actual**.

### 5.3 Descuento global del POS

- **Independiente** de esta regla.
- Si el cajero pone 5 % global + 20 % divisa: primero el 5 % afecta ref. BCV y USD cadena; luego el 20 % divisa se aplica sobre la ref. BCV resultante para obtener el USD a cobrar.
- Documentar orden en implementación: `refBcvFinal = refBcv × (1 − descGlobal/100)` → `totalUsdCobro = refBcvFinal × (1 − pctDivisa/100)`.

---

## 6. Persistencia en venta (auditoría)

Nuevos campos en tabla `ventas` (migración incremental, ej. `041_descuento_cobro_divisa.sql`):

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `descuento_divisa_pct` | NUMERIC(5,2) NULL | % aplicado en esa venta (0 o NULL = no aplicó) |
| `descuento_divisa_monto_usd` | NUMERIC(12,4) NULL | Diferencia `total_ref_usd_bcv − total_usd` cuando aplica |

**Valores guardados en venta con regla activa (ejemplo):**

| Campo | Valor |
|-------|-------|
| `total_ref_usd_bcv` | 40,00 |
| `total_bs` / `total_bs_bcv_operativo` | 22.531,57 |
| `total_usd` | 32,00 |
| `descuento_divisa_pct` | 20,00 |
| `descuento_divisa_monto_usd` | 8,00 |
| `descuento_porcentaje` | 0 (desc. global POS, si no hubo) |
| `metodo_pago` | `efectivo_usd` o `zelle` |

Las líneas en `detalles_ventas` **no se reescriben**: siguen con `precio_unitario_usd` de catálogo (cadena) y la ref. BCV por línea. El ajuste vive en cabecera.

---

## 7. Backend — validación de venta

Archivos principales: `ventas.controller.js`, `preciosService.js` (función nueva de totales cobro).

### 7.1 Flujo servidor (resumen)

1. Leer `modo_moneda_operacion`. Si `solo_bcv` → ignorar regla divisa.
2. Leer `descuento_cobro_divisa_activo` y `descuento_cobro_divisa_pct`.
3. Recalcular totales como hoy (`total_ref_usd_bcv`, `total_bs_bcv_operativo`, `total_usd` cadena).
4. Si aplica regla (multimoneda + activo + pct > 0 + pago 100 % USD/Zelle):
   - `total_usd_esperado = refBcv × (1 − pct/100)` (+ IVA si la fórmula final lo incluye en ref. BCV).
   - Validar `body.total_usd` contra `total_usd_esperado`, no contra el USD cadena.
5. Validar pagos con `sumaPagosEquivUsdCalle` contra `total_usd_esperado`.
6. Persistir campos de auditoría.

### 7.2 Lo que NO debe cambiar en servidor

- Cálculo de precios de catálogo / inventario.
- Cadena `aplicarCadenaPorPrecioEfectivo`.
- Totales BCV para ventas en bolívares.
- Lógica Cashea y cartera.

---

## 8. Impacto en el resto del programa

### 8.1 Sin impacto (regla desactivada o no aplica)

| Módulo | Motivo |
|--------|--------|
| Inventario / importación Excel | Precios de producto intactos |
| Modo solo BCV | Regla ignorada; descuento global basta |
| Ventas en Bs | `total_bs` y ref. BCV iguales que hoy |
| Cashea / crédito | No entran en métodos elegibles |
| Factura A4 / nota de entrega | Siguen con ref. $ BCV y Bs BCV |
| Ventas históricas | Sin recálculo retroactivo |
| Tasas BCV / USD mercado | Sin manipular tasas para simular descuento |

### 8.2 Impacto esperado (correcto por diseño)

| Módulo | Efecto |
|--------|--------|
| Modal cobro USD/Zelle | Total USD menor (ej. $32) |
| `ventas.total_usd` | Refleja lo cobrado en dólares |
| Caja — conteo USD/Zelle | Cuadra con monto real cobrado |
| Dashboard columna **USD efectivo** | Ventas USD suman el monto cobrado ($32) |
| Dashboard columna **BCV** | Sigue usando `total_ref_usd_bcv` ($40) |
| Ticket térmico (opcional v1) | Puede añadir línea «Desc. divisa −$8» si se desea |

### 8.3 Márgenes

El margen por línea en `detalles_ventas` se calcula sobre precio USD de catálogo. Con descuento divisa, el **ingreso real en USD** es menor; reportes de margen en lane USD deben tener en cuenta `descuento_divisa_monto_usd` si se quiere margen neto — mejora opcional post-v1.

---

## 9. Modo Solo BCV — por qué no necesita esta regla

En `solo_bcv`:

- `tasa_usd = tasa_bcv` → no hay brecha de precios dual.
- Efectivo USD y Zelle **no están disponibles** en el POS.
- Un descuento comercial se resuelve con:
  - **Desc. global %** en el POS (afecta un solo precio), o
  - **Desc. % por línea** en el carrito.

Por eso la configuración de descuento divisa debe estar **oculta y desactivada** en solo BCV.

---

## 10. Casos borde y decisiones v1

| Caso | Decisión v1 |
|------|-------------|
| Pago mixto USD + Bs | Sin descuento divisa; validación actual |
| Venta 100 % Zelle | Aplica regla |
| Config activa pero pct = 0 | Tratar como desactivado |
| Desc. global 10 % + divisa 20 % | Compuesto: ver §5.3 |
| Anulación / devolución | Reversar montos cobrados (`total_usd` y pagos reales) |
| Idempotencia POST /api/ventas | Misma key + misma lógica de totales |
| Rol sin permiso de descuento alto | Validar tope como `venta_descuento_max_pct` |

---

## 11. Checklist de implementación

### Fase A — Base de datos y configuración
- [ ] Migración: claves `descuento_cobro_divisa_activo`, `descuento_cobro_divisa_pct` en `configuracion`
- [ ] Migración: columnas `descuento_divisa_pct`, `descuento_divisa_monto_usd` en `ventas`
- [ ] Registrar parches en `migrations.js` + `server.js`
- [ ] UI Configuración: toggle + input %, visible solo en multimoneda
- [ ] API PATCH configuración: validar y persistir

### Fase B — POS
- [ ] Leer config al abrir cobro (cache / IPC)
- [ ] `cartTotals()` o helper `totalUsdCobroOperativo(metodo, pagos)`
- [ ] Banners y validación residual USD en modal cobro
- [ ] `postVenta`: enviar `total_usd` ajustado + flag/metadatos si hace falta

### Fase C — Backend ventas
- [ ] Función `resolverTotalUsdCobro(...)` en `preciosService.js`
- [ ] Espejo en `preciosClient.js` (NEXUS-DUAL)
- [ ] `ventas.controller.create`: validación y persistencia
- [ ] Tests manuales: Bs sin cambio · USD $32 · Zelle · mixto rechazado o sin regla

### Fase D — Documentos (opcional v1)
- [ ] Línea en ticket: «Desc. cobro divisa (20 %): −$8,00»
- [ ] Factura: sin cambio (precio BCV)

---

## 12. Criterios de aceptación

1. Con regla **desactivada**, el comportamiento es **idéntico** al actual (regresión cero).
2. Con regla **activa al 20 %**, venta 100 % Zelle del Intercomunicador:
   - Cobro acepta **$32,00** USD.
   - Cobro rechaza **$36,05** (USD cadena sin regla).
   - Factura muestra **$40,00** ref. BCV y **Bs. 22.531,57**.
3. Misma venta cobrada en **Bs** exige **Bs. 22.531,57** (sin descuento divisa).
4. En **solo BCV**, la opción no aparece en configuración y ninguna venta aplica la regla.
5. Dashboard BCV reporta $40; dashboard USD reporta $32 para esa venta.

---

## 13. Referencias en código actual

| Archivo | Relevancia |
|---------|------------|
| `frontend/pages/pos/pos.js` | `cartTotals()`, `cobroResidualUsdOperativo()`, `postVenta()` |
| `backend/controllers/ventas.controller.js` | Validación `total_usd` vs pagos |
| `backend/services/preciosService.js` | Cadena de precios, `sumaPagosEquivUsdCalle` |
| `frontend/services/preciosClient.js` | Espejo NEXUS-DUAL |
| `backend/services/modoMonedaService.js` | `esSoloBcv()` |
| `frontend/pages/configuracion/` | UI de parámetros |
| `docs/PLAN_SOLO_BCV.md` | Convivencia multimoneda / solo BCV |

---

*Documento de especificación para desarrollo. No modifica código hasta aprobación e implementación por fases.*
