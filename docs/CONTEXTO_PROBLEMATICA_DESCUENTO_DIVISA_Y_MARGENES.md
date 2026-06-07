# Contexto completo — Descuento en divisa, márgenes variables y coherencia de montos en Nexus Core

**Fecha:** 2026-06-06  
**Audiencia:** IA / desarrollador que retome el módulo sin historial de conversación  
**Estado del código:** Regla de descuento divisa **implementada** (migración `041`, POS, ventas, caja, configuración). UX caja, reportes en pantalla y export Excel ventas **implementados**. Preview divisa en inventario y modo «USD a recibir» **implementados**. Pendiente opcional: margen neto por línea en reportes; columnas informativas cobro divisa en import Excel.

**Documentos relacionados:**
- `docs/PLAN_DESCUENTO_COBRO_DIVISA.md` — especificación original de la regla
- `backups/PLAN_SOLO_BCV.md` o documentación de modo moneda en configuración

---

## ⚠️ ALCANCE CRÍTICO — LEER ANTES DE IMPLEMENTAR

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  DESCUENTO AL COBRAR EN DIVISA (USD / Zelle)                                │
│  ═══════════════════════════════════════════                                │
│  • SOLO existe / aplica en modo:  multimoneda                               │
│  • NO existe / NO aplica en modo: solo_bcv                                  │
│                                                                             │
│  En solo_bcv la configuración puede guardarse en BD pero el sistema         │
│  DEBE ignorarla en POS, ventas, caja y cualquier cálculo de cobro.          │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Clave de configuración del modo:** `modo_moneda_operacion` → `'multimoneda'` | `'solo_bcv'`  
**Servicio:** `backend/services/modoMonedaService.js`  
**Default si falta en BD:** `multimoneda`

Toda la problemática de este documento (brecha de tasas, USD calle vs ref. BCV, descuento divisa, confusión caja USD físico vs $ BCV ref.) **asume multimoneda**. En **solo BCV** gran parte de esa problemática **no existe** porque no hay dos tasas ni cobro en USD/Zelle.

---

## 1. Propósito de este documento

Este archivo describe **la problemática real** que enfrenta un negocio venezolano en **modo multimoneda** cuando:

1. Cada producto del inventario tiene un **% de ganancia distinto** (no es homogéneo).
2. Existe una opción de configuración **«descuento al cobrar en USD/Zelle»** (típicamente 20 %).
3. El sistema maneja **varios «tipos de dólar»** simultáneos (ref. BCV, USD calle/brecha, USD físico cobrado).
4. El usuario percibe **números distintos** en caja, dashboard, reportes e inventario y cree que «no cuadra».

El objetivo es dar contexto suficiente para que una IA pueda:
- Explicar el comportamiento sin confundir conceptos.
- Proponer mejoras de producto acordes a márgenes variables.
- Implementar cambios sin romper la cadena de precios ni la regla BCV del dashboard.

---

## 2. Resumen ejecutivo (TL;DR)

| Concepto | Qué es | ¿Cambia con descuento divisa? |
|----------|--------|-------------------------------|
| **Costo USD** | Lo que pagó el negocio por el producto (USD físico o equivalente) | No |
| **% Ganancia (inventario)** | Margen configurado **por producto** sobre el costo | No (es input del usuario) |
| **USD calle** (`precio_usd_efectivo`) | `costo × (1 + ganancia%)` redondeado | No |
| **Ref. $ BCV** (`precio_usd_bcv` / `total_ref_usd_bcv`) | Precio de etiqueta, factura, dashboard | **No** |
| **Bs BCV** (`precio_bs`) | Ref. BCV × tasa BCV | No |
| **USD cobro divisa** | Lo que el cliente paga en billetes/Zelle si la regla aplica | **Sí** — solo **multimoneda**; `ref. BCV × (1 − pct/100)` |
| **`ventas.total_usd`** | Monto USD **realmente cobrado** en esa venta | Sí cuando aplica divisa en multimoneda (ej. $32, no $40 ref.) |

> **Modo solo_bcv:** esta tabla sigue válida para costo, ganancia y ref. BCV, pero **no hay** USD cobro divisa ni cobro USD/Zelle. Ver §4.

**Problema central (multimoneda):** El dueño configura **30 % de ganancia** en un producto y espera ganar **30 % en billetes**, pero con descuento divisa del **20 % sobre la ref. BCV** la ganancia real en USD físico es **menor** (~15 % en un caso típico). Eso **no es un bug**: son dos reglas comerciales distintas que actúan en momentos diferentes.

**Segundo problema (UX):** En cierre de caja, el Paso 1 mostraba volúmenes en **$ BCV ref.** y el Paso 2 pedía contar **USD físico** sin explicar la diferencia → confusión del cajero.

**Tercer problema (operativo):** Con cientos de SKU y márgenes distintos, **no escala** pedir al usuario que «compense» manualmente el % de ganancia (ej. poner 46 % para lograr 30 % real en divisa) en cada producto.

---

## 3. Glosario obligatorio

| Término | Símbolo / campo | Descripción |
|---------|-----------------|-------------|
| Tasa BCV | `tasa_bcv` | Bolívares por 1 USD según referencia BCV (4 decimales en BD). |
| Tasa USD mercado | `tasa_usd` | Bolívares por 1 USD «calle» / paralelo (4 decimales). |
| Brecha | `tasa_usd / tasa_bcv` | Relación entre ambas tasas. Si USD > BCV, la ref. BCV en $ es **mayor** que el USD calle. |
| USD calle / USD efectivo cadena | `precio_usd_efectivo`, `total_usd` (sin divisa) | Precio con margen directo sobre costo, antes de convertir a ref. BCV. |
| Ref. $ BCV | `precio_usd_bcv`, `total_ref_usd_bcv` | Precio de etiqueta en dólares BCV; base del dashboard y reportes «$ BCV». |
| USD físico cobrado | `pagos[].monto` (moneda USD), `ventas.total_usd` con divisa | Billetes o Zelle que entran a la caja. |
| Descuento divisa | `descuento_cobro_divisa_pct` | % de descuento **solo al cobrar** 100 % en efectivo USD o Zelle, aplicado sobre ref. BCV del ticket. |
| Descuento global POS | `descuento_porcentaje` en venta | Promoción que reduce ref. BCV **y** cadena USD/Bs del ticket. Independiente de divisa. |
| Modo multimoneda | `modo_moneda_operacion = multimoneda` | Tasas distintas; USD/Zelle habilitados; aplica evaluación de descuento divisa. |
| Modo solo BCV | `modo_moneda_operacion = solo_bcv` | `tasa_usd = tasa_bcv`; sin USD/Zelle en POS; **descuento divisa ignorado**. |

---

## 4. Multimoneda vs Solo BCV — referencia completa para IA

Esta sección existe para que **ninguna IA confunda** los dos modos ni aplique descuento divisa donde no corresponde.

### 4.1 Qué es cada modo

| Aspecto | **multimoneda** | **solo_bcv** |
|---------|-----------------|--------------|
| Clave BD | `modo_moneda_operacion = 'multimoneda'` | `modo_moneda_operacion = 'solo_bcv'` |
| Tasas operativas | `tasa_bcv` y `tasa_usd` **independientes** (brecha posible) | `tasa_usd` **forzada =** `tasa_bcv` en lectura y escritura |
| Precios USD en catálogo | **Dos:** USD calle + ref. $ BCV (distintos si hay brecha) | **Uno efectivo:** calle = ref. BCV (sin brecha) |
| Cobro Efectivo USD / Zelle | **Habilitado** en POS | **Prohibido** (oculto en UI; rechazado en API) |
| Cobro en Bolívares | Sí | Sí (principal) |
| Cashea / crédito | Según permisos | Según permisos |
| Descuento divisa (USD/Zelle) | **Puede aplicar** si config activa | **Nunca aplica** — ignorar config |
| Descuento global POS / por línea | Sí | Sí (única vía de promoción típica) |
| Cierre caja — sección USD | Relevante (efectivo + Zelle) | **Oculta** (clase `nexus-usd-only`) |
| Problemática de este doc | **Aplica** | **No aplica** (no hay USD físico ni brecha) |

### 4.2 Dónde se persiste y lee el modo

| Capa | Ubicación |
|------|-----------|
| BD | `configuracion.clave = 'modo_moneda_operacion'` |
| Backend lectura | `ModoMonedaService.leerModo(db)` |
| Backend tasas | `PreciosService.resolverTasasOperativas(db)` → incluye `modo_moneda_operacion`; si `solo_bcv` → `tasa_usd = bcv` |
| Cambio de modo (admin) | `PATCH` configuración → `configuracion.controller.js` (al pasar a `solo_bcv` fuerza USD=BCV) |
| Frontend cache | `localStorage` clave `nexus_modo_moneda` + `NexusComponents.getModoMoneda()` |
| Setup inicial | `backend/routes/setup.routes.js` (wizard sin JWT) |

### 4.3 Efecto en la cadena de precios

**Multimoneda** (ej. BCV 563,29 · USD 625):

```
costo $100 + 30 % ganancia
  → USD calle     = $130,00
  → Ref. $ BCV    = $144,24   (mayor por brecha tasa_usd/tasa_bcv)
  → Bs BCV        = precio_bs derivado
```

**Solo BCV** (ej. BCV = USD = 563,29):

```
costo $100 + 30 % ganancia
  → USD calle     = $130,00
  → Ref. $ BCV    = $130,00   (igual — sin brecha)
  → Bs BCV        = $130 × tasa_bcv
```

En solo BCV **no hay** «dos dólares» en el producto: el precio de etiqueta BCV y el USD calle coinciden (salvo redondeos mínimos).

### 4.4 Descuento divisa — árbol de decisión (solo multimoneda)

```
¿modo_moneda_operacion === 'solo_bcv'?
  └─ SÍ → FIN. Ignorar descuento_cobro_divisa_*. Comportamiento legacy unificado.
  └─ NO (multimoneda) →
        ¿descuento_cobro_divisa_activo === true Y pct > 0?
          └─ NO → Cobro USD/Zelle = validación contra USD calle del ticket (sin regla divisa).
          └─ SÍ →
                ¿Pago 100 % efectivo_usd o 100 % zelle?
                  └─ NO (Bs, Cashea, crédito, mixto) → Sin regla divisa.
                  └─ SÍ → totalUsdCobro = ref_BCV × (1 − pct/100)
```

**Implementación backend:** `ventas.controller.js` → `esSoloBcvVenta` debe ser `false` antes de evaluar `resolverDescuentoCobroDivisaConfig`.  
**Implementación frontend POS:** `pos.js` → `aplicaDescuentoCobroDivisa()` retorna `false` si `posModoMoneda() === 'solo_bcv'`.

### 4.5 Comportamiento por módulo según modo

| Módulo | multimoneda | solo_bcv |
|--------|-------------|----------|
| **Configuración — selector modo** | Opción visible | Opción visible |
| **Configuración — descuento divisa** | Sección visible (`nexus-multimoneda-only`) | **Oculta** + nota: usar desc. global POS |
| **Inventario — preview USD calle / BCV** | Ambos precios distintos si hay brecha | Un solo precio efectivo |
| **Inventario — preview divisa** | Mostrar cobro USD estimado + ganancia real billetes | **No mostrar** |
| **POS — métodos Efectivo USD, Zelle** | Visibles | **Ocultos / deshabilitados** |
| **POS — banner cobro USD** | USD calle o USD divisa según regla | N/A |
| **POST /api/ventas — pagos USD** | Permitidos | **HTTP 400** si llegan `efectivo_usd` o `zelle` |
| **POST /api/ventas — descuento divisa** | Evaluar regla | **Saltar** bloque completo |
| **Caja — apertura USD inicial** | Campo visible | Oculto (`nexus-usd-only`) |
| **Caja — cierre Paso 1 USD físico** | Tarjeta + nota si hay ventas USD | Oculto |
| **Caja — cierre Paso 2 / Paso 3 USD** | Cuadre efectivo + Zelle | Panel USD oculto; `difUsd` ignorado al cerrar |
| **Dashboard** | KPIs en ref. BCV (+ tasas duales en navbar) | KPIs en ref. BCV; una sola tasa efectiva |
| **Reportes** | Columnas BCV ref. (`refBcvDeFila`) + contexto multimoneda | Mismas columnas BCV; sin columna «cobro divisa» |
| **Migración 041** | Aplica a ventas multimoneda con USD/Zelle | Columnas pueden ser NULL; regla nunca corre |

### 4.6 Clases CSS y convenciones UI

| Clase / patrón | Comportamiento |
|----------------|----------------|
| `nexus-multimoneda-only` | Elementos visibles **solo** en multimoneda (ej. config descuento divisa) |
| `nexus-usd-only` | Elementos de **divisa de mercado** (USD físico, Zelle, cierre USD) — ocultos en solo_bcv vía JS/CSS del layout |
| `cajaModoMoneda() !== 'solo_bcv'` | Guards en `caja.js` para notas y tarjetas USD físico |

**NEXUS-DUAL:** Si el backend unifica tasas en `solo_bcv`, el frontend debe hacer lo mismo en `preciosClient.js` → `resolverTasasOperativas` / `getModoMonedaLocal()` antes de `calcularPrecios`, o los precios del inventario/POS **divergirán** del servidor.

### 4.7 Promociones y descuentos — qué usar en cada modo

| Necesidad del negocio | multimoneda | solo_bcv |
|-----------------------|-------------|----------|
| «10 % off en todo el ticket» | Desc. global POS | Desc. global POS |
| «20 % si paga en USD/Zelle» | **Descuento divisa** (config) | **No usar** — no hay USD/Zelle |
| «Precio especial en un producto» | Desc. por línea en carrito | Desc. por línea en carrito |
| Reducir solo etiqueta BCV sin tocar Bs cobro | No trivial | N/A |

En **solo_bcv**, intentar replicar descuento divisa con la config `descuento_cobro_divisa_*` es **incorrecto**: el usuario debe usar descuento global o por línea.

### 4.8 Errores que una IA NO debe cometer

| ❌ Incorrecto | ✅ Correcto |
|--------------|------------|
| Aplicar `resolverTotalUsdCobro` en ventas solo_bcv | Comprobar `esSoloBcvVenta` primero; saltar regla |
| Mostrar config descuento divisa en solo_bcv | Ocultar con `nexus-multimoneda-only` |
| Asumir que `ventas.total_usd` siempre es USD calle | Con divisa ON en multimoneda es **USD cobrado** (menor) |
| Asumir brecha de tasas en solo_bcv | `tasa_usd === tasa_bcv` siempre operativamente |
| Exigir cuadre USD en cierre de caja solo_bcv | Ignorar `difUsd`; panel oculto |
| Documentar descuento divisa sin mencionar modo | **Siempre** condicionar a `multimoneda` |
| Unificar dashboard a USD cobrado por divisa | Dashboard = ref. BCV en **ambos** modos |
| Crear preview «cobro divisa» en inventario para solo_bcv | Solo multimoneda + config activa |

### 4.9 Casos de cambio de modo (operador admin)

**De multimoneda → solo_bcv:**
- Sistema fuerza `tasa_usd = tasa_bcv`.
- Ventas futuras no pueden usar USD/Zelle.
- Config descuento divisa queda guardada pero **inactiva en runtime**.
- Cierres de caja futuros sin sección USD.

**De solo_bcv → multimoneda:**
- Admin debe reingresar `tasa_usd` de mercado (la UI lo solicita).
- Reaparecen métodos USD/Zelle en POS.
- Descuento divisa vuelve a evaluarse si `activo = true`.
- Brecha vuelve a separar USD calle y ref. BCV.

**Ventas históricas:** No se recalculan. Una venta hecha en multimoneda con `descuento_divisa_pct = 20` conserva sus montos aunque hoy el negocio esté en solo_bcv.

### 4.10 Resumen una línea para IA

> **Descuento al cobrar en divisa es una feature de multimoneda.** En solo_bcv no hay USD/Zelle ni brecha de tasas; usar descuento global del POS. Cualquier código nuevo que mencione `descuento_cobro_divisa` debe incluir guard `!esSoloBcv` en backend y equivalente en frontend.

---

## 5. Cadena de precios en inventario (motor `PreciosService.calcularPrecios`)

**Nota:** La brecha entre USD calle y ref. $ BCV descrita aquí **solo ocurre en multimoneda**. En solo_bcv ambos convergen.

**Archivos:** `backend/services/preciosService.js` ↔ `frontend/services/preciosClient.js` (NEXUS-DUAL).

### 5.1 Entradas por producto

| Campo | Origen |
|-------|--------|
| `costo_usd` | Costo en USD físico (o derivado si costo ingresado en $ BCV) |
| `margen_ganancia_pct` | % de ganancia **por producto** (cada SKU puede ser distinto) |
| `precio_manual_usd` | Opcional; fija USD calle y salta el margen % |
| `tasa_bcv`, `tasa_usd` | Tasas del día en configuración / historial |

### 5.2 Pasos de la cadena (orden fijo, redondeos críticos)

```
PASO 1 — USD calle (precio con margen sobre costo)
  precio_usd_efectivo = round( costo_usd × (1 + margen_ganancia_pct / 100), 2 )

PASO 2 — Equivalente en Bs a tasa USD (sin redondeo intermedio crítico)
  monto_bs_base = precio_usd_efectivo × tasa_usd
  bs_usd_equiv   = round( monto_bs_base, 2 )

PASO 3 — Ref. $ BCV y Bs BCV (aritmética entera con tasa BCV a 4 dec)
  { precio_usd_bcv, precio_bs } = precioBolivaresRefBcvDesdeBsUsd( bs_usd_equiv, tasa_bcv )

PASO 4 — Factor brecha (informativo)
  factor_brecha ≈ precio_usd_bcv / precio_usd_efectivo ≈ tasa_usd / tasa_bcv
```

### 5.3 Tres modos de fijar precio en UI de inventario

| Modo UI | ID interno | Usuario define | Sistema calcula |
|---------|------------|----------------|-----------------|
| % Ganancia | `margen` | `margen_ganancia_pct` | Toda la cadena |
| $ BCV · Precio final | `bcv` | `precio_usd_bcv` objetivo | % ganancia inverso + `precio_manual_usd` |
| $ USD · Precio final | `usd` | `precio_usd_efectivo` objetivo | % ganancia inverso |

**Importante:** El modo **$ USD · Precio final** fija el **USD calle**, no el **USD cobro con descuento divisa**. Si la regla divisa está activa, el cliente pagará **menos** que ese USD calle (porque el descuento va sobre ref. BCV, no sobre USD calle).

### 5.4 Vista previa actual en inventario

El bloque «Costo y precios calculados» muestra:
- Costo ($ BCV ref. arriba / USD abajo)
- Precio de venta ($ BCV ref. / USD calle)
- Ganancia neta ($ BCV / USD calle según modo)

**Implementado (2026-06):** Bloque `#bloque-preview-divisa` muestra cobro USD/Zelle estimado y ganancia real en billetes cuando divisa activa; oculto en `solo_bcv`. Ver `renderPreviewDivisa()` en `inventario.js`.

---

## 6. Regla de descuento al cobrar en divisa (exclusiva de multimoneda)

> **Prerrequisito:** `modo_moneda_operacion === 'multimoneda'`. Ver §4 completo. En `solo_bcv` esta sección **no opera**.

### 6.1 Configuración (tabla `configuracion`)

| Clave | Tipo | Default |
|-------|------|---------|
| `descuento_cobro_divisa_activo` | `'true'` / `'false'` | `false` |
| `descuento_cobro_divisa_pct` | numérico 0–100 | `0` |

**Lectura:** `PreciosService.resolverDescuentoCobroDivisaConfig()`  
**UI:** `frontend/pages/configuracion/configuracion.js` (sección `nexus-multimoneda-only`)

### 6.2 Cuándo aplica (v1 implementada)

| Condición | ¿Aplica? |
|-----------|----------|
| `multimoneda` + activo + pct > 0 | Evaluar |
| Pago **100 %** `efectivo_usd` | **Sí** |
| Pago **100 %** `zelle` | **Sí** |
| Pago en Bs (cualquier método BS) | **No** |
| Cashea | **No** |
| Crédito / cartera | **No** |
| Pago mixto (USD + Bs u otro) | **No** (v1) |
| `solo_bcv` o activo = false | **No** |

### 6.3 Fórmula de cobro

Sobre el total de cabecera **después** del descuento global del POS (si existe) e IVA:

```
total_ref_usd_bcv_final = suma de líneas en ref. $ BCV (cabecera)

totalUsdCobro = round4( total_ref_usd_bcv_final × (1 − descuento_cobro_divisa_pct / 100) )
```

**Lo que NO cambia al activar divisa:**
- Líneas en `detalles_ventas` (precios de catálogo)
- `total_ref_usd_bcv` en factura / ticket (precio de etiqueta)
- `total_bs` / `total_bs_bcv_operativo` (cobro en bolívares)
- Precios en inventario / catálogo

**Lo que SÍ cambia:**
- Total USD exigido en modal de cobro (efectivo USD / Zelle)
- `ventas.total_usd` persistido (= USD cobrado, no USD calle ni ref. BCV)
- `ventas.descuento_divisa_pct` y `ventas.descuento_divisa_monto_usd`
- Montos esperados en cierre de caja (JSON `pagos`)
- Suma `ventas.total_usd` en analytics que usen ese campo

### 6.4 Orden compuesto si hay descuento global POS + divisa

```
refBcv_tras_global = refBcv_bruta × (1 − descuento_global_POS / 100)
totalUsdCobro      = refBcv_tras_global × (1 − descuento_cobro_divisa_pct / 100)
```

El descuento global afecta la ref. BCV del ticket; el descuento divisa se aplica **después** solo para obtener el USD a cobrar.

---

## 7. Comparativa: descuento divisa DESACTIVADO vs ACTIVADO

### 7.1 Misma venta, pago 100 % Efectivo USD

**Producto ejemplo (plan original):** 1 und., ref. BCV $40, tasas BCV 563,2892 · USD 625.

| Concepto | Divisa **OFF** | Divisa **ON** (20 %) |
|----------|----------------|----------------------|
| Ref. $ BCV (factura / dashboard) | $40,00 | $40,00 |
| Bs a cobrar (si paga en Bs) | Bs. 22.531,57 | Bs. 22.531,57 |
| USD calle (cadena sin regla divisa) | ~$36,05 | ~$36,05 (no es el cobro si aplica divisa) |
| **USD exigido al cliente** | **~$36,05** (validación vs USD calle del ticket) | **$32,00** |
| `ventas.total_usd` guardado | ~$36,05 | **$32,00** |
| `descuento_divisa_monto_usd` | NULL | $8,00 |

### 7.2 Misma venta, pago en Bolívares

**Idéntico** con divisa ON u OFF: cliente paga **Bs. 22.531,57** (ref. BCV completa). El descuento divisa **no aplica**.

### 7.3 Sesión de caja real reportada por el usuario

3 ventas solo efectivo USD + Zelle, descuento divisa 20 % activo:

| Vista | Efectivo USD | Zelle | Total |
|-------|--------------|-------|-------|
| Paso 1 — ref. BCV por método | $80 ref. | $40 ref. | **$120 ref.** |
| Paso 2 — USD físico esperado | $64 | $32 | **$96** |
| Relación | 80 × 0,8 = 64 | 40 × 0,8 = 32 | 120 × 0,8 = 96 |

El cajero debe contar **$96 en billetes/Zelle**, no $120.

---

## 8. Ejemplos numéricos con márgenes variables (tasas BCV 563,2892 · USD 625, divisa 20 %)

Cada producto tiene **distinto** `% ganancia` en inventario. El factor brecha es ~**1,1095** (`625/563,2892`).

### 8.1 Producto A — costo $100, margen 30 %

| Etapa | Valor |
|-------|-------|
| USD calle | $130,00 |
| Ref. $ BCV | $144,24 |
| Bs BCV | Bs. 81.248,83 |
| Cobro USD/Zelle (divisa 20 %) | **$115,39** |
| Ganancia real en billetes | **$15,39 → 15,4 %** sobre costo |
| Ganancia si cobra en Bs (ref. BCV − costo BCV ref.) | ~44 % en términos ref. BCV |

### 8.2 Producto B — costo $50, margen 45 %

| Etapa | Valor |
|-------|-------|
| USD calle | $72,50 |
| Ref. $ BCV | $80,44 |
| Cobro divisa | **$64,35** |
| Ganancia real billetes | **28,7 %** |

### 8.3 Producto C — costo $200, margen 20 %

| Etapa | Valor |
|-------|-------|
| USD calle | $240,00 |
| Ref. $ BCV | $266,29 |
| Cobro divisa | **$213,03** |
| Ganancia real billetes | **6,5 %** |

### 8.4 Tabla resumen — margen configurado vs margen real en divisa (20 %)

| Producto | Costo | Margen config. | Cobro USD divisa | Margen **real** USD físico |
|----------|-------|----------------|------------------|----------------------------|
| A | $100 | 30 % | $115,39 | **15,4 %** |
| B | $50 | 45 % | $64,35 | **28,7 %** |
| C | $200 | 20 % | $213,03 | **6,5 %** |

**Conclusión:** El `% ganancia` del inventario **no es** el margen en billetes cuando divisa está activa. La relación depende de:
- margen configurado,
- brecha de tasas,
- % descuento divisa.

### 8.5 Caso hipotético — «quiero 30 % real en billetes» con un solo margen uniforme

Solo válido si **todos** los productos compartieran la misma política (el negocio del usuario **no** cumple esto: cada producto varía).

```
margen_inventario_necesario ≈ margen_objetivo_real / ( (1 − pct_divisa/100) × factor_brecha )
                            ≈ 30 % / ( 0,80 × 1,1095 )
                            ≈ 46,5 %
```

**No recomendado** cuando cada SKU tiene margen distinto.

---

## 9. Persistencia en base de datos (venta completada)

### 9.1 Campos relevantes en `ventas`

| Columna | Significado con divisa ON (ejemplo $40 ref., 20 %) |
|---------|-----------------------------------------------------|
| `total_ref_usd_bcv` | $40,00 (etiqueta) |
| `total_bs` / `total_bs_bcv_operativo` | Bs. cadena BCV |
| `total_usd` | **$32,00** (cobrado) |
| `descuento_divisa_pct` | 20,00 |
| `descuento_divisa_monto_usd` | 8,00 (= ref − cobrado) |
| `pagos` (JSONB) | `[{ metodo, moneda: 'USD', monto: 32 }]` |

### 9.2 Líneas `detalles_ventas`

**No se modifican** por descuento divisa. Siguen reflejando precios de catálogo (`precio_unitario_usd`, `subtotal_usd` en cadena USD de producto).

Implicación para reportes de margen por línea: el ingreso USD real es menor; el ajuste está en cabecera (`descuento_divisa_monto_usd`).

---

## 10. Comportamiento por módulo del sistema

> **Alcance:** Las subsecciones que mencionan descuento divisa, USD/Zelle o «USD físico vs ref. BCV» aplican **solo en multimoneda**. En `solo_bcv` ver §4.5 (columna derecha). Dashboard y reportes BCV ref. aplican en **ambos** modos.

### 10.1 Inventario / alta de productos

- El usuario define **costo** y **% ganancia** (o precio final BCV/USD).
- El motor calcula cadena completa.
- **No aplica** descuento divisa al guardar producto.
- **Preview divisa (multimoneda):** bloque informativo con cobro USD/Zelle y ganancia real en billetes; oculto en `solo_bcv`.
- **Modo «USD a recibir» (`usd_objetivo`):** cuarta pestaña de precio; calcula margen inverso vía `calcularMargenDesdeUsdCobroObjetivo` (NEXUS-DUAL).

**Archivos:** `frontend/pages/inventario/inventario.js`, `inventario.html`

### 10.2 POS — carrito y cobro

- Carrito muestra precios en ref. BCV + Bs (ambos modos).
- **Multimoneda:** con divisa activa y método USD/Zelle, banner de cobro muestra `totalUsdCobro`, no USD calle.
- **Solo BCV:** métodos `efectivo_usd` y `zelle` ocultos; `aplicaDescuentoCobroDivisa()` siempre `false`.
- Validación de pagos contra `totalUsdCobro`.
- Descuento global POS es independiente.

**Archivos:** `frontend/pages/pos/pos.js`, `backend/controllers/ventas.controller.js`

### 10.3 Ventas — creación servidor

Flujo en `ventas.controller.js` → `create`:
1. Recalcula ref. BCV y totales Bs (como siempre).
2. **Solo si `!esSoloBcvVenta` y aplica divisa:** `totalUsdEfectivoCobro = resolverTotalUsdCobro(ref, pct)`.
3. Persiste `total_usd = totalUsdEfectivoCobro`.
4. Valida que pagos USD sumen el cobro esperado.

### 10.4 Caja — cierre / arqueo (confusión USD solo en multimoneda)

**Solo multimoneda — dos capas de números (diseño intencional):**

| Paso | Fuente | Moneda semántica |
|------|--------|------------------|
| Paso 1 resumen | `total_ref_usd_bcv` proporcional por método | **$ BCV ref.** (volumen gerencial) |
| Paso 2 hints / cuadre | `pagos[].monto` agregados | **USD físico** (billetes/Zelle) |

**Mejoras UX implementadas** (`frontend/pages/caja/caja.js`, `caja.html`) — **visibles solo si `cajaModoMoneda() !== 'solo_bcv'`**:
- Tarjeta «USD físico cobrado (efectivo + Zelle)».
- Sublínea `USD cobrado: $X` en desglose por método.
- Nota explicativa cuando ref. BCV ≠ USD cobrado.
- Hints Paso 2: «USD cobrado en caja»; efectivo con desglose inicial + ventas si hay apertura.

**API:** `GET /api/caja/resumen-cierre` → `montosEsperados`, `totalesPorMetodo.total_usd` vs `total_ref_usd_bcv`

### 10.5 Dashboard

**Correcto por diseño** — muestra **ref. BCV** al usuario:
- `ventas_hoy_bcv`, `total_bcv` en gráficas, últimas ventas `total_bcv`.
- Regla de negocio BCV: dashboard en cadena oficial.

**Archivos:** `backend/services/dashboardService.js`, `frontend/pages/dashboard/dashboard.js`

El campo `ventas_hoy` (USD calle/cobrado) existe en API pero el frontend prioriza `*_bcv`.

### 10.6 Reportes (pantalla)

**Problema histórico:** reportes de ventas etiquetaban columnas «Total $ BCV» pero sumaban `total_usd` (USD cobrado).

**Corrección aplicada:** `refBcvDeFila()` en `frontend/pages/reportes/reportes.js` + `total_bcv` en queries de `reportesService.js`.

### 10.7 Exportación Excel

**Implementado:** exportaciones de ventas y por cajero incluyen columnas separadas «USD cobrado (físico)» y «$ BCV ref. (etiqueta)» con nota al pie. `_usdCobradoYRefBcv()` + `_appendNotaColumnasUsd()`.

**Pendiente menor:** historial de cierres de caja en Excel sigue con una sola columna «Total USD vendido» (ambiguo si hubo divisa).

**Archivos:** `backend/services/excelService.js`

### 10.8 PDF / ticket

- Factura mantiene ref. BCV.
- Ticket térmico puede incluir línea de descuento divisa (según implementación en `pdfService.js`).

---

## 11. Problemática del negocio (narrativa del usuario)

### 11.1 Confusión en cierre de caja

El cajero vendió solo en efectivo USD y Zelle. En Paso 1 veía **$120** (volumen BCV). En Paso 2 el sistema pedía **$64 + $32 = $96**. Parecía error.

**Causa:** Dos métricas legítimas sin etiquetar. **No** es faltante de dinero si cuenta $96.

### 11.2 Expectativa de margen vs realidad en divisa

El dueño carga productos con **distintos** porcentajes de ganancia (25 %, 30 %, 45 %…). Asume que ese % es lo que ganará **siempre**.

Con descuento divisa activo:
- En **bolívares** cobra la ref. BCV completa (margen alto en ref. BCV).
- En **USD/Zelle** cobra ref. BCV menos 20 % → margen real en billetes **menor** que el % configurado.

### 11.3 Onboarding masivo (cliente nuevo, muchos SKU)

No es viable:
- Calcular manualmente un % «compensado» por producto.
- Aplicar un único margen global elevado (~46 %) a todo el catálogo cuando cada producto tiene política distinta.

---

## 12. Recomendaciones de producto (priorizadas para márgenes variables)

### 12.1 Prioridad alta — Preview en inventario (sin cambiar el margen guardado)

Al editar/crear producto, si `descuento_cobro_divisa_activo`:

```
Cobro estimado USD/Zelle (20 %):  $115,39
Ganancia real en billetes:         15,4 % sobre costo USD
```

- Respeta que **cada producto tiene su propio %**.
- Elimina calculadora externa.
- El dueño ajusta el % de **ese** producto si el preview no le cierra.

### 12.2 Prioridad media — Modo «USD cobro divisa objetivo» (por producto)

Cuarta pestaña en formulario de precio (solo multimoneda + divisa activa):

> «¿Cuánto quieres recibir en efectivo/Zelle por este producto?»

El sistema calcula el `% ganancia` de ese SKU (igual que hoy con «$ BCV precio final»).

### 12.3 Prioridad baja — Compensación global de margen

Solo si el negocio tuviera **un único** margen objetivo en divisa para todo el catálogo. **No aplica** al caso descrito (márgenes heterogéneos).

### 12.4 Importación Excel

Mantener columna `margen_ganancia_pct` por fila. Opcional: columnas informativas calculadas (no persistidas) con cobro divisa estimado.

### 12.5 Política de negocio sin desarrollo

Aceptar menor margen en divisa a cambio de liquidez; maximizar margen en cobros en Bs.

---

## 13. Errores comunes al interpretar el sistema (para IA)

| Error | Realidad |
|-------|----------|
| «Descuento divisa aplica en solo_bcv si está activo en config» | **No.** Modo solo_bcv ignora la regla aunque la config exista en BD. |
| «En solo_bcv el cliente puede pagar en Zelle con descuento» | **No.** USD/Zelle rechazados en API; métodos ocultos en POS. |
| «En solo_bcv hay brecha BCV y USD calle» | **No.** `tasa_usd = tasa_bcv` operativamente; un solo precio USD. |
| «El dashboard debería mostrar $96, no $120» | Dashboard = volumen **BCV ref.** por regla de negocio (en ambos modos). |
| «Puse 30 % ganancia y el sistema me estafa con 15 %» | El 30 % configura catálogo; el 20 % divisa reduce cobro USD. |
| «Debo poner 46 % en todos los productos» | Solo si quisieras 30 % uniforme en billetes; con márgenes variables, usar preview por SKU. |
| «Modo $ USD precio final fija lo que cobro en divisa» | Fija **USD calle**; divisa descuenta sobre **ref. BCV**. |
| «Reportes y caja deberían usar el mismo número» | Caja Paso 1 = BCV ref.; Paso 2 = USD físico. Coherente tras mejoras UX. |
| «Descuento global POS = descuento divisa» | Global afecta ticket completo; divisa solo USD/Zelle 100 %. |

---

## 14. Casos borde y límites v1

| Caso | Comportamiento |
|------|----------------|
| Pago mixto USD + Bs | Sin descuento divisa; validación estándar |
| Apertura de caja con USD inicial | Hint efectivo = inicial + ventas USD; tarjeta «USD físico cobrado» = solo ventas |
| `descuento_cobro_divisa_pct = 0` | Equivalente a desactivado |
| Ventas anteriores a migración 041 | Sin `descuento_divisa_*`; `total_ref_usd_bcv` puede ser NULL → fallback `total_usd` |
| Tope `venta_descuento_max_pct` | El % divisa no debe superar máximo del rol |
| Idempotencia POST ventas | Respeta misma lógica de totales |

---

## 15. Referencia de archivos en el repositorio

| Área | Archivo |
|------|---------|
| Motor precios backend | `backend/services/preciosService.js` |
| Motor precios frontend | `frontend/services/preciosClient.js` |
| Config descuento divisa | `frontend/pages/configuracion/configuracion.js` |
| POS cobro | `frontend/pages/pos/pos.js` |
| Crear venta | `backend/controllers/ventas.controller.js` |
| Migración BD | `database/migrations/041_descuento_cobro_divisa.sql` |
| Caja cierre UX | `frontend/pages/caja/caja.js`, `caja.html` |
| Resumen cierre API | `backend/controllers/caja.controller.js` → `resumenCierre` |
| Dashboard KPIs | `backend/services/dashboardService.js` |
| Reportes | `backend/services/reportesService.js`, `frontend/pages/reportes/reportes.js` |
| Inventario | `frontend/pages/inventario/inventario.js` |
| Especificación original | `docs/PLAN_DESCUENTO_COBRO_DIVISA.md` |

---

## 16. Funciones clave (contratos)

### `PreciosService.calcularPrecios(costo, ganancia_pct, tasa_bcv, tasa_usd)`

Retorna: `precio_usd_efectivo`, `precio_usd_bcv`, `precio_bs`, `margen_usd`, etc.

### `PreciosService.resolverTotalUsdCobro(totalUsdBcvRef, pct)`

```javascript
return round4(totalUsdBcvRef * (1 - pct / 100));
```

### `refBcvDeFila(row)` (reportes frontend)

Prioridad: `row.total_bcv` → `row.total_ref_usd_bcv` → `row.total_usd`.

### `sumPorMetodosUsdFisico(totalesPorMetodo, 'usd'|'ref')` (caja frontend)

Suma `total_usd` o `total_ref_usd_bcv` solo para métodos `efectivo_usd` y `zelle`.

---

## 17. Checklist para IA que implemente mejoras

Reglas transversales (verificar en **cualquier** cambio nuevo):

- [x] **Primero:** verificar `modo_moneda_operacion`. Si `solo_bcv` → no tocar descuento divisa.
- [x] Guards backend: `esSoloBcvVenta` / `ModoMonedaService.esSoloBcv` antes de `resolverTotalUsdCobro`.
- [x] Guards frontend: `posModoMoneda()`, `cajaModoMoneda()`, `getModoMonedaLocal()` === `'solo_bcv'`.
- [x] UI nueva con clase `nexus-multimoneda-only` o `nexus-usd-only` según corresponda.
- [x] NEXUS-DUAL: `preciosClient.resolverTasasOperativas` unifica USD=BCV en solo_bcv.
- [x] Preview divisa en inventario **solo** multimoneda + config activa; leer config sin `process.env` en frontend.
- [x] No modificar `total_ref_usd_bcv` al aplicar divisa en venta.
- [x] Dashboard y KPIs gerenciales siguen en BCV ref.
- [x] Caja cuadre USD contra `pagos` JSONB, no contra ref. BCV.
- [x] Reportes en pantalla usan `total_bcv` para columnas «$ BCV».
- [x] Sincronizar NEXUS-DUAL si se toca `resolverTotalUsdCobro` o cadena de precios.
- [x] No aplicar regla en `solo_bcv`.
- [x] Respetar márgenes **por producto**; evitar soluciones de un solo % global salvo que el negocio lo pida explícitamente.

---

## 19. Checklist de implementación — estado actual (2026-06-06)

Auditoría contra el repositorio. `[x]` = implementado y verificado en código; `[ ]` = pendiente u opcional.

### 19.1 Base de datos y migraciones

- [x] Migración `041_descuento_cobro_divisa.sql`: claves `descuento_cobro_divisa_activo`, `descuento_cobro_divisa_pct`
- [x] Columnas `ventas.descuento_divisa_pct`, `ventas.descuento_divisa_monto_usd`
- [x] Registro idempotente en `backend/config/migrations.js` → `runPatch041DescuentoCobroDivisa`

### 19.2 Motor de precios (NEXUS-DUAL)

- [x] `PreciosService.calcularPrecios` — cadena USD calle → ref. BCV → Bs BCV
- [x] `PreciosService.resolverDescuentoCobroDivisaConfig(db)`
- [x] `PreciosService.resolverTotalUsdCobro(ref, pct)` ↔ `preciosClient.resolverTotalUsdCobro`
- [x] `PreciosService.calcularMargenDesdeUsdCobroObjetivo` ↔ `preciosClient.calcularMargenDesdeUsdCobroObjetivo`
- [x] `resolverTasasOperativas`: en `solo_bcv` fuerza `tasa_usd = tasa_bcv` (backend y frontend)

### 19.3 Configuración

- [x] UI toggle + % con sección `nexus-multimoneda-only`; nota en `solo_bcv`
- [x] `PATCH /api/configuracion/descuento-cobro-divisa` (`configuracion.controller.js`)
- [x] Cache localStorage `nexus_cfg_descuento_cobro_divisa_*`
- [x] Calculador de impacto con ejemplos 20/30/45 % (`renderCalculadorImpactoDivisa`)
- [x] Nota de margen compensado global (~46 %) solo informativa (no auto-aplica)

### 19.4 POS y creación de venta

- [x] `cobroAplicaDescuentoDivisa()` — guard `solo_bcv` + 100 % `efectivo_usd`/`zelle`
- [x] Banner y validación contra `totalUsdCobro` (no USD calle)
- [x] Métodos USD/Zelle ocultos en `solo_bcv` (`nexus-usd-only`)
- [x] `ventas.controller.js`: bloque divisa tras `!esSoloBcvVenta`; persiste campos auditoría
- [x] Rechazo API pagos USD/Zelle en `solo_bcv` (HTTP 400)
- [x] Tope `venta_descuento_max_pct` aplicado al % divisa
- [x] Pago mixto USD+Bs: sin regla divisa (v1)
- [x] Pago en Bs: ref. BCV completa con divisa activa

### 19.5 Caja — cierre y arqueo

- [x] Paso 1: volúmenes en ref. BCV por método (`total_ref_usd_bcv`)
- [x] Paso 2: hints «USD cobrado en caja»; cuadre contra `pagos[].monto`
- [x] Tarjeta «USD físico cobrado (efectivo + Zelle)»
- [x] Sublínea `USD cobrado: $X` en desglose por método
- [x] Nota explicativa ref. BCV ≠ USD cobrado (`textoNotaUsdFisicoCierre`)
- [x] `sumPorMetodosUsdFisico(totalesPorMetodo, 'usd'|'ref')`
- [x] Panel USD oculto en `solo_bcv`; `difUsd` ignorado al cerrar
- [x] API `GET /api/caja/resumen-cierre` con `montosEsperados` y `total_ref_usd_bcv`

### 19.6 Dashboard y reportes

- [x] Dashboard KPIs en ref. BCV (`ventas_hoy_bcv`, `total_bcv` en series)
- [x] Reportes pantalla: `refBcvDeFila()` prioriza `total_bcv` / `total_ref_usd_bcv`
- [x] `reportesService.js`: queries con `COALESCE(total_ref_usd_bcv, total_usd) AS total_bcv`
- [ ] Reportes margen por línea ajustado por `descuento_divisa_monto_usd` (opcional post-v1)

### 19.7 Exportación Excel y PDF

- [x] Excel ventas: columnas «USD cobrado (físico)» + «$ BCV ref. (etiqueta)» + nota al pie
- [x] Excel ventas por cajero: mismas columnas duales + nota
- [ ] Excel historial cierres: columna única «Total USD vendido» (ambiguo con divisa)
- [x] Ticket térmico: fila `{{DESCUENTO_DIVISA_ROW}}` en `ticket_venta.html`
- [x] Factura/PDF: totales en ref. BCV; descuento divisa solo en ticket cuando aplica

### 19.8 Inventario

- [x] Preview divisa: cobro USD estimado + ganancia real en billetes (`renderPreviewDivisa`)
- [x] Oculto en `solo_bcv`; sin config activa muestra estado inactivo
- [x] Modo precio `usd_objetivo` («USD a recibir») — pestaña + cálculo margen inverso
- [x] Visibilidad tabs USD físico / precio $USD según modo (`aplicarVisibilidadModoInventario`)
- [ ] Import Excel: columnas informativas cobro divisa estimado por fila (§12.4 opcional)

### 19.9 Recomendaciones de producto (§12)

| Prioridad | Item | Estado |
|-----------|------|--------|
| Alta | Preview cobro divisa + ganancia real en inventario | [x] Implementado |
| Media | Modo «USD cobro divisa objetivo» por producto | [x] Implementado (`usd_objetivo`) |
| Baja | Compensación global de margen en todo el catálogo | [ ] Solo nota informativa en config |
| Baja | Columnas informativas en plantilla import Excel | [ ] Pendiente |
| — | Política de negocio sin desarrollo | N/A |

---

## 18. Preguntas que la IA debe poder responder tras leer este doc

1. ¿En qué modo aplica el descuento al cobrar en divisa? (**solo multimoneda**)  
2. ¿Qué pasa con `descuento_cobro_divisa_activo` si el negocio está en solo_bcv? (**ignorado en runtime**)  
3. ¿Por qué en solo_bcv no existe la confusión «$120 ref. vs $96 físico» en caja? (**no hay cobro USD/Zelle**)  
4. ¿Por qué el cajero en multimoneda cuenta $96 y no $120?  
5. ¿El 30 % del inventario es ganancia en billetes con divisa 20 %? (**solo en multimoneda**)  
6. ¿Qué campo usa el dashboard para «ventas hoy»? (**ref. BCV en ambos modos**)  
7. ¿Qué pasa si el cliente paga en Bs con divisa activa? (**precio BCV completo; divisa no aplica**)  
8. ¿Por qué cada producto con distinto margen necesita preview y no un % global compensado?  
9. ¿Cuál es la diferencia entre USD calle, ref. BCV y USD cobro divisa? (**último solo multimoneda + regla activa**)  
10. ¿Qué archivos tocar para agregar preview en inventario sin romper la cadena ni activarse en solo_bcv?

---

*Documento de contexto para continuidad de desarrollo y análisis por IA. Refleja el estado del proyecto y la problemática reportada en sesión de junio 2026.*
