# Análisis visual completo — Nexus Core

> **Propósito:** inventario exhaustivo de todo lo relacionado con la apariencia del sistema, como base para implementar **modo normal (claro)** y **modo oscuro**.
>
> **Fecha de análisis:** 2026-06-06  
> **Estado actual:** la app es **dark-first y dark-only**. No existe toggle de tema, `data-theme`, `prefers-color-scheme` ni persistencia de preferencia visual en `localStorage`.

---

## Tabla de contenidos

1. [Resumen ejecutivo](#1-resumen-ejecutivo)
2. [Arquitectura CSS](#2-arquitectura-css)
3. [Design tokens (`variables.css`)](#3-design-tokens-variablescss)
4. [Identidad visual y reglas fijas](#4-identidad-visual-y-reglas-fijas)
5. [Layout y shell de la aplicación](#5-layout-y-shell-de-la-aplicación)
6. [Componentes transversales (`components.css`)](#6-componentes-transversales-componentscss)
7. [Base y utilidades (`base.css`)](#7-base-y-utilidades-basecss)
8. [Animaciones (`animations.css`)](#8-animaciones-animationscss)
9. [Módulos de página (`pages.css`)](#9-módulos-de-página-pagescss)
10. [Punto de venta (`pos.css`)](#10-punto-de-venta-poscss)
11. [Páginas standalone (fuera del shell principal)](#11-páginas-standalone-fuera-del-shell-principal)
12. [Plantillas de impresión / PDF](#12-plantillas-de-impresión--pdf)
13. [Assets gráficos](#13-assets-gráficos)
14. [HTML generado por JavaScript](#14-html-generado-por-javascript)
15. [Colores hardcodeados en JavaScript](#15-colores-hardcodeados-en-javascript)
16. [Estilos inline en HTML](#16-estilos-inline-en-html)
17. [Chart.js (dashboard)](#17-chartjs-dashboard)
18. [Electron — ventanas y chrome del SO](#18-electron--ventanas-y-chrome-del-so)
19. [Responsive y breakpoints](#19-responsive-y-breakpoints)
20. [Clases de body y estados globales](#20-clases-de-body-y-estados-globales)
21. [Deuda técnica visual (bloqueadores para dual-theme)](#21-deuda-técnica-visual-bloqueadores-para-dual-theme)
22. [Plan recomendado para modo claro + oscuro](#22-plan-recomendado-para-modo-claro--oscuro)

---

## 1. Resumen ejecutivo

| Aspecto | Estado actual |
|---------|---------------|
| **Tema activo** | Solo oscuro (`:root` en `variables.css`, línea 6: *"Modo: Dark exclusivo"*) |
| **Toggle de tema** | No existe |
| **Fuente de verdad de colores** | `frontend/assets/css/variables.css` (~40 tokens CSS) |
| **Archivos CSS** | 6 archivos, orden fijo en `index.html` |
| **Concepto visual** | Sala de control financiero (Bloomberg/Refinitiv, no SaaS) |
| **Acento principal** | Ámbar `#f0a500` — innegociable |
| **Tipografía UI** | Sora |
| **Tipografía display/marca** | Barlow Condensed |
| **Tipografía numérica** | DM Mono — **obligatoria** en montos, tasas, stock, KPIs |
| **Fondo** | Nunca plano: gradientes radiales ámbar + azul info |
| **Hex hardcodeados fuera de tokens** | ~70 en `components.css`, `pages.css`, `pos.css` |
| **Páginas con CSS propio** | `splash.html`, `setup.html`, `activation.html` (duplican tokens) |
| **Impresión** | Tema claro independiente (tickets, notas de entrega) |

---

## 2. Arquitectura CSS

### Orden de carga (INMUTABLE en `frontend/index.html`)

```
1. variables.css   → Design tokens (único lugar canónico de colores/fuentes)
2. base.css        → Reset, body, layout root, KPI base, responsive layout
3. components.css  → Sidebar, navbar, botones, tablas, forms, modales, toasts
4. pages.css       → Estilos por módulo (~2700 líneas)
5. animations.css  → Transiciones de router y keyframes
6. pos.css         → UI exclusiva del POS (~1900 líneas)
```

### Meta visual en `index.html`

```html
<meta name="theme-color" content="#0a0e1a">
<link rel="icon" type="image/svg+xml" href="assets/img/logo.svg">
```

### Fuentes externas

Cargadas vía Google Fonts en `variables.css`:

- **Sora** — pesos 300–800
- **Barlow Condensed** — pesos 500–800
- **DM Mono** — pesos 400–500

---

## 3. Design tokens (`variables.css`)

Todos viven en `:root`. Para dual-theme, estos son los tokens que **deben duplicarse** en `[data-theme="dark"]` y `[data-theme="light"]` (o equivalente).

### Fondos (elevación de oscuro a claro visual)

| Token | Valor actual (dark) | Uso |
|-------|---------------------|-----|
| `--bg-primary` | `#05080f` | Base app, scrollbar track |
| `--bg-secondary` | `#090d18` | Sidebar, cards, header |
| `--bg-tertiary` | `#0d1424` | Inputs, thead, hover suave |
| `--bg-accent` | `#111d32` | Filas hover, ítem activo sidebar |
| `--bg-elevated` | `#162035` | Modales, dropdowns, tooltips |
| `--bg-glass` | `rgba(9,13,24,0.85)` | Overlays semitransparentes |
| `--bg-surface` | alias → `--bg-tertiary` | Legado |
| `--bg-hover` | alias → `--bg-accent` | Legado |

### Acento identitario

| Token | Valor | Uso |
|-------|-------|-----|
| `--accent-primary` | `#f0a500` | Botón primario, tasa BCV, ítem activo sidebar |
| `--accent-primary-dim` | `#c47f00` | Hover botón primario |
| `--accent-primary-glow` | `rgba(240,165,0,0.12)` | Tinte de fondo (NO halo neon) |
| `--accent-primary-bg` | `rgba(240,165,0,0.07)` | Fondo ítem activo, focus ring |
| `--accent-secondary` | alias → `--accent-primary` | |
| `--accent-info` | `#3b82f6` | Solo datos informativos BCV |
| `--accent-info-dim` | `rgba(59,130,246,0.15)` | |

### Estados semáforo

| Token | Valor | Uso |
|-------|-------|-----|
| `--accent-success` | `#22c55e` | Ventas OK, stock OK |
| `--accent-warning` | `#f59e0b` | Stock bajo, alertas |
| `--accent-danger` | `#ef4444` | Anulaciones, errores |

### Texto

| Token | Valor | Uso |
|-------|-------|-----|
| `--text-primary` | `#edf2f7` | Cuerpo principal |
| `--text-secondary` | `#7a8fa8` | Labels, metadatos |
| `--text-muted` | `#3d5068` | Headers tabla, hints |
| `--text-bright` | `#ffffff` | Títulos, KPIs grandes |
| `--text-accent` | → `--accent-primary` | Links |
| `--text-on-accent` | `#05080f` | Texto sobre botón ámbar |

### Bordes

| Token | Valor |
|-------|-------|
| `--border-primary` | `#1a2540` |
| `--border-subtle` | `#0e1a2e` |
| `--border-accent` | `rgba(240,165,0,0.25)` |
| `--border-muted` | `rgba(255,255,255,0.04)` |

### Tipografía

| Token | Valor |
|-------|-------|
| `--font-ui` / `--font-primary` | `'Sora', system-ui, sans-serif` |
| `--font-display` | `'Barlow Condensed', 'Sora', sans-serif` |
| `--font-mono` | `'DM Mono', 'JetBrains Mono', 'Fira Code', monospace` |

### Escala tipográfica

| Token | Tamaño | Uso |
|-------|--------|-----|
| `--text-xs` | 11px | Badges, metadatos |
| `--text-sm` | 12px | Labels secundarios |
| `--text-base` | 13.5px | Cuerpo general |
| `--text-md` | 15px | Subtítulos |
| `--text-lg` | 17px | Títulos sección |
| `--text-xl` | 20px | `.page-title` |
| `--text-2xl` | 26px | KPIs secundarios |
| `--text-3xl` | 36px | KPI principal dashboard |

### Espaciado

`--space-1` (4px) → `--space-10` (40px) en incrementos estándar.

### Radios

| Token | Valor | Regla |
|-------|-------|-------|
| `--radius-sm` | 3px | Botones, inputs, badges |
| `--radius-md` | 6px | Cards normales |
| `--radius-lg` | 10px | Modales |
| `--radius-xl` | 12px | Solo modal cobro POS |
| `--radius-pill` | 999px | Scrollbar thumb |

**Regla de identidad:** `border-radius > 8px` prohibido en cards/panels de datos.

### Alturas de componentes

| Token | Valor |
|-------|-------|
| `--height-btn` | 38px |
| `--height-btn-pos` | 56px |
| `--height-input` | 38px |
| `--height-input-sm` | 32px |

### Sombras

| Token | Valor |
|-------|-------|
| `--shadow-sm` | `0 1px 3px rgba(0,0,0,0.4)` |
| `--shadow-md` | `0 4px 16px rgba(0,0,0,0.5)` |
| `--shadow-lg` | `0 8px 32px rgba(0,0,0,0.6)` |
| `--shadow-accent` | `0 2px 10px rgba(240,165,0,0.22), 0 1px 3px rgba(0,0,0,0.45)` |
| `--shadow-inset` | `inset 0 1px 0 rgba(255,255,255,0.03)` |
| `--shadow-success` | `0 1px 4px rgba(34,197,94,0.25)` |
| `--shadow-danger` | `0 1px 4px rgba(239,68,68,0.25)` |

### Transiciones

| Token | Valor |
|-------|-------|
| `--transition-fast` | 120ms ease |
| `--transition-base` | 200ms ease |
| `--transition-slow` | 350ms ease |
| `--transition-page` | → `--transition-base` |

### Layout

| Token | Valor | Responsive |
|-------|-------|------------|
| `--sidebar-width` | 210px | → 64px (≤1100px) → 52px (≤860px) |
| `--header-height` | 50px | |
| `--scrollbar-thumb` | → `--border-primary` | |
| `--scrollbar-track` | → `--bg-primary` | |

### Utilidades tipográficas en `variables.css`

```css
.font-mono, .tasa-valor, .monto-usd, .monto-ves, .precio-celda,
.stock-celda, .bcv-rate → var(--font-mono)

.font-display, .sidebar-brand-title, .page-title, .pos-total-amount
→ var(--font-display)
```

### Scrollbars (definidas en `variables.css` y duplicadas en `base.css`)

- Ancho/alto: 5px
- Track: `--bg-primary`
- Thumb: `--border-primary`, hover → `--accent-primary`
- Firefox: `scrollbar-color: var(--border-primary) var(--bg-primary)`

---

## 4. Identidad visual y reglas fijas

Estas reglas están en `.cursor/rules/IDENTIDAD-VISUAL-NEXUS-CORE.mdc` y **aplican en ambos modos**:

### Prohibiciones absolutas

- Acento cyan/teal/azul eléctrico como primario (`#00d4ff`, `#06b6d4`, etc.)
- Efectos neon: `text-shadow` con blur de color, `box-shadow` tipo halo `0 0 Npx`, `filter: drop-shadow` colorido
- Fuentes genéricas como UI principal: Inter, Roboto, Poppins, system-ui visible
- `border-radius > 8px` en cards/panels de datos
- Badges tipo pill (máximo 2–3px radius)
- Gradientes decorativos purple→pink→cyan en botones

### Elementos de firma (preservar en claro y oscuro)

1. **Display tasa BCV** — mono, ámbar sólido, fondo tintado, borde `--border-accent`, sin glow
2. **Sidebar ítem activo** — `border-left: 2px solid var(--accent-primary)`, fondo `--accent-primary-bg`
3. **Botón primario** — fondo `--accent-primary`, texto `--text-on-accent`
4. **Fondo con gradientes radiales** — ámbar arriba-izq, azul info abajo-der (opacidades bajas)
5. **Headers de tabla** — mono, 10px, uppercase, letter-spacing 0.14em, `--text-muted`

### Regla monoespaciada

Todo valor numérico en pantalla usa `--font-mono`: montos BCV/USD, tasas, facturas, stock, KPIs, columnas numéricas.

---

## 5. Layout y shell de la aplicación

### Estructura DOM (`index.html`)

```
#layout-root.layout-root
├── #sidebar-host          → sidebar.js inyecta <aside class="sidebar">
└── .layout-main
    ├── #navbar-host       → navbar.js inyecta <header class="app-header">
    └── #view.view-container  → router carga módulos aquí
```

### Clases de layout (`base.css`)

| Clase | Función |
|-------|---------|
| `.layout-root` | Flex horizontal, 100vh |
| `.layout-main` | Columna principal, `margin-left: var(--sidebar-width)` |
| `.layout-root.layout-guest` | Oculta sidebar y navbar (login) |
| `.view-container` | Área de contenido con scroll, padding 1.25rem 1.5rem |
| `.page-header` | Título + acciones, borde inferior `--border-subtle` |
| `.page-title` | Display, uppercase, `--text-bright` |
| `.page-subtitle` | 12px, `--text-muted` |
| `.kpi-grid` / `.kpi-card` | Grid responsive de KPIs |

### Fondo del body (`base.css`)

```css
background-color: var(--bg-primary);
background-image:
  radial-gradient(ellipse 80% 50% at 15% -10%, rgba(240,165,0,0.04) 0%, transparent 70%),
  radial-gradient(ellipse 60% 40% at 85% 110%, rgba(59,130,246,0.03) 0%, transparent 70%);
background-attachment: fixed;
```

En modo claro habrá que **redefinir** estos gradientes (misma posición, opacidades adaptadas).

---

## 6. Componentes transversales (`components.css`)

~1200 líneas. Componentes que aparecen en 2+ módulos.

### Sidebar

| Clase | Detalle visual |
|-------|----------------|
| `.sidebar` | Fijo 210px, `--bg-secondary`, gradiente ámbar top 200px, borde derecho |
| `.sidebar-brand-logo` | SVG 32px, `color: var(--accent-primary)` |
| `.sidebar-brand-title` | Display 18px/800, uppercase, `--text-bright` |
| `.sidebar-brand-sub` | Mono 10px, `--accent-primary`, "ERP · POS" |
| `.sidebar-nav-group-label` | Mono 9.5px, uppercase, `--text-muted` |
| `.sidebar-nav-link` | 12.5px, borde izq transparente, hover `--bg-accent` |
| `.sidebar-nav-link.is-active` | Ámbar: fondo `--accent-primary-bg`, borde izq 2px ámbar |
| `.sidebar-footer` | Versión + Electron, `--text-muted` |

### Navbar / Header

| Clase | Detalle visual |
|-------|----------------|
| `.app-header` | 50px, `--bg-secondary`, sombra neutra |
| `.tasa-input` | **Firma visual** — mono 13px, ámbar, fondo glow, borde accent |
| `.tasa-badge` | "USD BCV", mono uppercase |
| `.header-clock` | Mono, `--text-primary` |
| `.btn-logout-header` | Ghost pequeño, hover rojo |
| `.db-status-dot` | 8px círculo: verde/rojo/gris según estado |

### Botones

| Clase | Visual |
|-------|--------|
| `.btn` | Base: `--bg-tertiary`, borde `--border-primary`, 38px |
| `.btn-primary` | Ámbar sólido, `--text-on-accent`, hover `#d49200` ⚠️ hardcoded |
| `.btn-success` | Verde, texto `#fff` ⚠️ |
| `.btn-warning` | Ámbar warning, texto `#fff` ⚠️ |
| `.btn-danger` | Rojo, sombra danger |
| `.btn-ghost` | Transparente |
| `.btn-lg` | 48px |
| `.btn-xl` | 60px — usado en POS cobrar |
| `.btn-icon` | 32×32 |
| `.btn-block` | width 100% |
| `.btn-secondary` | En `pages.css` también |
| `.input-g` | Input estándar del sistema |

### Cards

| Clase | Visual |
|-------|--------|
| `.card` | `--bg-secondary`, gradiente highlight 1.5%, borde, radius md |
| `.card-title` | Display 14px uppercase |

### Tablas `.data-table`

| Elemento | Visual |
|----------|--------|
| `thead th` | Sticky, mono 10px uppercase, `--bg-tertiary` |
| `td.num` | Mono, right-align, 12.5px |
| `tr:hover` | `--bg-accent` |
| `tr.is-warn` | Fondo ámbar 6% |
| `tr.is-danger` | Fondo rojo 8% |

### Badges (components)

| Clase | Colores |
|-------|---------|
| `.badge` | Base neutro |
| `.badge--blue` | `#93c5fd` ⚠️ hardcoded |
| `.badge--green` | `#4ade80` ⚠️ |
| `.badge--yellow` | `#fcd34d` ⚠️ |
| `.badge--red` | `#f87171` ⚠️ |
| `.badge--purple` | `#c4b5fd` ⚠️ |
| `.badge--amber` | Usa tokens ámbar |

### Formularios

| Clase | Visual |
|-------|--------|
| `.form-label` | Mono 10px uppercase `--text-muted` |
| `.form-input/select/textarea` | `--bg-tertiary`, focus ring ámbar 3px |
| Inputs numéricos | Fuerza `--font-mono` |

### Toolbar y filtros

| Clase | Visual |
|-------|--------|
| `.toolbar` | Flex wrap |
| `.filter-chip` | Chip 30px, activo → fondo ámbar completo |

### Modales

| Clase | Visual |
|-------|--------|
| `.modal-overlay` | `rgba(0,0,0,0.75)` + `backdrop-filter: blur(4px)` |
| `.modal-box` | `--bg-secondary`, max 680px, `--shadow-lg` |
| `.modal-header h2` | Display 16px uppercase `--text-bright` |

### Toasts

| Clase | Visual |
|-------|--------|
| `.toast-host` | Fixed bottom-right, z-index 10000 |
| `.toast-info` | `--bg-accent` |
| `.toast-success` | Verde translúcido |
| `.toast-warning` | Ámbar translúcido |
| `.toast-danger` | Rojo translúcido |

### Number stepper

| Clase | Visual |
|-------|--------|
| `.nexus-num-wrap` | Borde, focus ring ámbar |
| `.nexus-num-btn` | Hover → ámbar |

### Marca Cashea

| Clase | Visual |
|-------|--------|
| `.nexus-cashea-icon` | Imagen WebP 1.15rem |
| `.nexus-metodo-pago--cashea` | Inline-flex con icono |
| `.nexus-cashea-label` | Texto junto al icono |

### Modo Solo BCV (visual, no tema)

```css
body.nexus-solo-bcv .nexus-usd-only { display: none !important; }
```

Administra `navbar.js` al cambiar modo monetario.

---

## 7. Base y utilidades (`base.css`)

- Reset universal `box-sizing: border-box`
- `html { font-size: 15px; overflow: hidden }`
- `min-width: 680px` en body
- Links: `--text-accent`
- Inputs number sin spinners nativos
- KPI cards con barra izquierda 3px de color semáforo
- Variantes KPI: `--blue`, `--green`, `--yellow`, `--red`, `--purple`, `--cyan`
- Media queries que modifican `--sidebar-width` y tamaños KPI

---

## 8. Animaciones (`animations.css`)

| Regla | Efecto |
|-------|--------|
| `.view-container.is-transitioning` | opacity 0, translateY(6px) |
| `.view-container.is-visible` | Fade + slide in |
| `@keyframes nexus-fade-in` | Opacity |
| `@keyframes nexus-slide-up` | Opacity + translateY |
| `@keyframes nexus-rate-pop` | Pulso de **borde** (no glow) en tasa |
| `.tasa-input.is-updated` | Aplica rate-pop 700ms |
| `@media (prefers-reduced-motion: reduce)` | Desactiva todo |

**Sin colores hardcodeados** — usa variables CSS.

---

## 9. Módulos de página (`pages.css`)

~2739 líneas. Secciones por módulo:

| Sección | Línea aprox. | Prefijos de clase principales |
|---------|--------------|-------------------------------|
| Patrones transversales | 7–209 | `.tabla-modulo`, `.badge-*`, `.form-*`, `.kpi-*` |
| Dashboard | 212–651 | `.dash-*`, `.dk-*` |
| Inventario | 652–924 | `.inv-*`, modales importar/ajuste |
| Ventas | 925–1312 | `.ventas-*`, `.dev-modal-*` |
| Clientes | 1313–1440 | `.cli-*`, `.perfil-*`, `.pago-*` |
| Cartera | 1441–1478 | `.cartera-*`, `.aging-*`, `.abono-*` |
| Caja | 1479–1765 | `.caja-*`, `.cierre-*`, `.conteo-*`, `.cuadre-*` |
| Compras | 1766–1783 | `.compras-*`, `.compra-*` |
| Proveedores | 1784–1841 | Tabla proveedores |
| Reportes | 1842–2164 | `.reportes-*`, master-detail |
| Configuración | 2165–2306 | `.cfg-*`, `.config-*`, `.lic-*`, `.bcv-*` |
| Usuarios | 2307–2351 | Roles, permisos, modales |
| Cashea | 2352–2593 | `.cashea-*`, KPIs, cuadre |
| Login | 2594–2622 | `.login-*` |
| Complementos cartera/compras/usuarios | 2624–2657 | |
| Identidad transversal | 2659–2739 | Unificación thead mono, tabs, badges |

### Dashboard — elementos visuales clave

- `.dash-topbar` — contexto operativo del día
- `.dash-tasa-pill` — pill de tasa (visual tipo badge)
- `.dash-caja-banner` — estados abierta/cerrada/sin caja (colores semáforo)
- `.dash-context-band` — banda de contexto financiero
- `.dash-kpi-card` — KPIs jerárquicos con `.dk-valor`, `.dk-label`
- `.dash-panel` — paneles de gráficas y listas
- `.dash-alerta-item` + `.dash-semaforo` — alertas stock con semáforo rojo/naranja/amarillo
- `.dash-comparativa--sube/baja/igual` — indicadores de tendencia

### Configuración — navegación visual

- `.cfg-nav` — sidebar vertical de secciones (patrón similar al sidebar principal)
- `.cfg-tab.activo` — subrayado ámbar
- Secciones: empresa, tasas, impresora, respaldo, licencia, modo moneda

### Caja — cierre visual

- `.cierre-resumen-sistema` — grid de totales sistema
- `.caja-val--success/warning` — colores semáforo en montos
- `.cuadre-linea--ok/desvio` — semáforo de cuadre
- `.hint-cashea-cierre-sistema` — hints Cashea

### Cashea — divergencias visuales ⚠️

Algunos bordes de stats usan colores Material Design hardcodeados:
- `#1976d2`, `#2e7d32`, `#e65100`

---

## 10. Punto de venta (`pos.css`)

~1900 líneas. UI de alto contraste para uso intensivo en mostrador.

### Layout principal

| Clase | Función |
|-------|---------|
| `.pos-page` | Contenedor raíz |
| `.pos-grid` | Grid 2 columnas: carrito izq, búsqueda der |
| `.pos-panel` | Panel con header |
| `.pos-panel-title` | Display uppercase |

### Búsqueda y resultados

| Clase | Visual |
|-------|--------|
| `.pos-search-input` | Input grande con icono |
| `.pos-result-item` | Tarjeta de producto clickeable |
| `.pos-result-price` | Mono, ámbar |
| `.pos-result-item.is-out` | Opacidad reducida (sin stock) |

### Carrito

| Clase | Visual |
|-------|--------|
| `.pos-cart-table` | Tabla compacta |
| `.pos-total-block` | Bloque total destacado |
| `.pos-total-primary` | Display, tamaño grande |
| `.pos-total-currency` | Mono para montos |
| `.pos-cobrar-row .btn-xl` | Botón cobrar 60px |

### Modal de cobro

| Clase | Visual |
|-------|--------|
| `.pos-cobro-modal-overlay` | Overlay fullscreen |
| `.pos-cobro-modal` | Modal grande, radius xl |
| `.cobro-banner--green/yellow/red` | Banners con **gradientes hardcodeados** ⚠️ |
| `.cobro-conv--bcv/usd` | Tags de conversión |
| `.cobro-keypad` | Teclado numérico |
| `.cobro-key` | Botones 48px+ |
| `.cobro-su-pago-input` | Input de pago mono grande |

### POS clásico (layout alternativo)

| Clase | Función |
|-------|---------|
| `.pos-classic-*` | Franja superior + lateral F1/F2/F5 |
| `.pos-marquee` | Ticker compacto de info |
| `.pos-aside-*` | Panel lateral estrecho |

### Responsive POS

Breakpoints en 1280px, 1100px, 860px — modal casi fullscreen, tabla compacta.

---

## 11. Páginas standalone (fuera del shell principal)

Estas páginas **NO cargan** la cadena CSS de `index.html`. Tienen `<style>` embebido con tokens duplicados.

### `splash.html` — ventana de arranque Electron

- Tamaño: 600×400, `frame: false`, `transparent: true`
- Tokens `:root` duplicados (subconjunto)
- **Violaciones de identidad:** `box-shadow` glow en logo, `filter: drop-shadow`, animación `logo-glow`
- Clases: `.splash-container`, `.splash-logo`, `.splash-title`, `.splash-progress-*`, `.error-container`
- `-webkit-app-region: drag` en body

### `setup.html` — instalación inicial

- Tamaño: 520×820
- Tokens completos + `--accent-success`
- Clases: `.card`, `.steps`, `.step-dot`, `.panel`, `.field`, `.cashea-toggle`, `.hwid-box`, `.code-input`, `.btn`
- 15 atributos `style=` inline para layout
- Misma paleta navy/ámbar

### `activation.html` — activación de licencia

- Tamaño: 520×680
- Similar a setup
- `.btn-activate:hover` → `#d49200` + glow ⚠️

### `login/login.html` — dentro del shell

- Usa `pages.css` (MÓDULO LOGIN) + `components.css`
- Clases: `.login-page`, `.login-brand`, `.login-field`, `.login-pass-wrap`
- 5 `style=` inline (sizing de botones)
- JS aplica `color: var(--accent-danger/success)` en mensajes

---

## 12. Plantillas de impresión / PDF

Independientes del tema de la app. **Siempre claras** (papel blanco).

### `ticket_venta.html`

- Ancho 72mm, tema térmico
- Fuente: Segoe UI (no Sora/DM Mono)
- Colores: `#111`, `#333`, `#999`, `#ccc`, `#444`
- Clases: `.ticket-brand`, `.ticket-muted`, `.ticket-lines`, `.ticket-totals`

### `nota_entrega.html`

- Formato A4
- **Tema azul corporativo** (`#2563eb`, `#1e3a8a`, `#93c5fd`) — NO ámbar navy
- Clases: `.doc-header`, `.doc-brand`, `.badge`, `.detalle`, `.firmas`

### `factura.html` / `reporte_inventario.html`

- Shell vacío (`<div id="...">`) — estilos aplicados por `pdfService.js` en runtime

### Backend `pdfService.js`

- Usa temas `plain` y `striped` de la librería de tablas PDF
- No comparte tokens CSS del frontend

---

## 13. Assets gráficos

| Archivo | Uso | Colores |
|---------|-----|---------|
| `frontend/assets/img/logo.svg` | Favicon, sidebar | `currentColor` (hereda ámbar) |
| `frontend/assets/img/logo-wordmark.svg` | Marca con texto | `currentColor`, Barlow Condensed |
| `frontend/assets/images/cashea.webp` | Icono Cashea en tablas/POS | Imagen raster (no vector) |
| `build-resources/icon.png` / `.ico` | Icono app Electron | Branding empaquetado |
| `araguaney.png` | (raíz proyecto) | Asset suelto |

**Nota:** `casheaBrand.js` referencia `assets/images/cashea.webp` — verificar que el archivo exista en build.

---

## 14. HTML generado por JavaScript

### `sidebar.js`

Genera estructura completa del sidebar con SVG icons inline (Heroicons-style, `stroke="currentColor"`).

### `navbar.js`

Genera header con:
- Bloque "Panel operativo"
- Inputs tasa BCV (y USD en multimoneda, clase `.nexus-usd-only`)
- Reloj, usuario, logout, estado BD
- **Inline styles:** `font-weight:600`, `textAlign`, `fontSize`, `color` en fecha

### `toast.js`

```html
<div id="nexus-toast-host" class="toast-host">
  <div class="toast toast-{tipo} is-in">mensaje</div>
</div>
```

### `modal.js`

Stub vacío — modales se definen en HTML de cada módulo.

### `currencyDisplay.js`

Sin HTML — solo formateo de montos.

### `numberStepper.js`

Envuelve inputs con `.nexus-num-wrap` + botones ±.

### `router.js`

Toggle clases:
- `layout-guest` en root
- `is-transitioning` / `is-visible` en view
- `is-active` en links sidebar

---

## 15. Colores hardcodeados en JavaScript

| Archivo | Línea | Color | Contexto |
|---------|-------|-------|----------|
| `dashboard/dashboard.js` | 125–130 | `#3d5068`, `#0e1a2e`, `rgba(240,165,0,0.6)`, `#22c55e`, `#f0a500`, `#ef4444` | Fallbacks de `chartTheme()` si CSS vars fallan |
| `dashboard/dashboard.js` | 385 | `rgba(16,185,129,0.12)` | Fill gráfico horas |
| `inventario/inventario.js` | 841, 844 | `rgba(239,68,68,*)`, `rgba(245,158,11,*)` | Filas alerta stock en tabla dinámica |
| `compras/compras.js` | 112 | `rgba(239,68,68,.4)` | Borde botón eliminar |
| `usuarios/usuarios.js` | 214 | `rgba(245,158,11,.15)` | Badge rol temporal |

**Buena práctica existente:** `chartTheme()` lee `getComputedStyle(document.documentElement)` — los gráficos **ya son theme-aware** si cambian las variables CSS.

---

## 16. Estilos inline en HTML

Total ~100 atributos `style=` en páginas del frontend.

| Archivo | Cantidad | Patrón dominante |
|---------|----------|------------------|
| `caja/caja.html` | 16 | `display:none`, widths |
| `setup.html` | 15 | Grid layout, spacing |
| `inventario/inventario.html` | 13 | Paneles ocultos |
| `proveedores/proveedores.html` | 11 | Modales |
| `usuarios/usuarios.html` | 9 | Modales permisos |
| `pos/pos.html` | 9 | Layout cobro |
| `configuracion/configuracion.html` | 8 | Secciones toggle |
| Resto | 1–5 cada uno | Mayormente `display:none` |

**Impacto en dual-theme:** bajo si usan `var(--*)` o solo layout; revisar los que hardcodean color.

---

## 17. Chart.js (dashboard)

Función `chartTheme()` en `dashboard/dashboard.js` lee variables CSS:

| Propiedad gráfico | Variable CSS |
|-------------------|--------------|
| Texto ejes | `--text-muted` |
| Grid | `--border-subtle` |
| Barras acento | `--accent-primary-glow` |
| Línea éxito | `--accent-success` |
| Línea primaria | `--accent-primary` |
| Peligro | `--accent-danger` |

**Al implementar tema claro:** si se actualizan los tokens en `:root` / `[data-theme]`, los gráficos se adaptan automáticamente. Eliminar o actualizar los fallbacks hex en JS.

---

## 18. Electron — ventanas y chrome del SO

| Ventana | Dimensiones | Visual |
|---------|-------------|--------|
| Splash | 600×400 | `frame: false`, `transparent: true`, `alwaysOnTop` |
| Setup | 520×820 | `autoHideMenuBar`, no resize |
| Activation | 520×680 | Igual setup |
| Main | 1280×800 min 1024×768 | `show: false` hasta ready, `fullscreenable` |

**No configurado:** `backgroundColor`, `titleBarStyle`, `vibrancy`

`app.setAppUserModelId('com.nexuscore.pos')` en Windows.

---

## 19. Responsive y breakpoints

| Breakpoint | Efectos |
|------------|---------|
| ≤1280px | Padding view reducido, header compacto, POS marquee |
| ≤1100px | Sidebar solo íconos (64px), labels ocultos, header sin reloj |
| ≤860px | Sidebar 52px, page-title menor, modales 98vw, tablas scroll horizontal |

Variables CSS modificadas en media queries:
- `--sidebar-width`: 210 → 64 → 52

---

## 20. Clases de body y estados globales

| Clase en `<body>` o contenedor | Origen | Efecto visual |
|-------------------------------|--------|---------------|
| *(ninguna de tema)* | — | Tema por defecto = dark |
| `.layout-guest` en `#layout-root` | `router.js` | Sin sidebar/navbar |
| `.nexus-solo-bcv` en `body` | `navbar.js` | Oculta `.nexus-usd-only` |
| `.view-container.is-transitioning` | `router.js` | Fade out al cambiar vista |
| `.view-container.is-visible` | `router.js` | Fade in |
| `.is-active` en sidebar links | `router.js` | Ítem activo ámbar |
| `.tasa-input.is-updated` | navbar (opcional) | Animación borde tasa |

---

## 21. Deuda técnica visual (bloqueadores para dual-theme)

### A. Colores hex hardcodeados en CSS (fuera de `variables.css`)

| Archivo | Cantidad | Ejemplos |
|---------|----------|----------|
| `components.css` | 9 | `#d49200`, `#fff`, `#93c5fd`, `#4ade80`, `#fcd34d`, `#f87171`, `#c4b5fd` |
| `pages.css` | 32 | `#64748b`, `#eab308`, `#ca8a04`, `#1976d2`, `#2e7d32`, `#e65100` |
| `pos.css` | 29 | `#059669`, `#d97706`, `#dc2626`, `#0f172a`, `#f1f5f9` |

**Acción:** convertir a tokens semánticos (`--badge-green-text`, `--banner-cobro-green-from`, etc.) con valores distintos por tema.

### B. `rgba()` hardcodeados en CSS

Presentes en badges, filas warn/danger, toasts, overlays, gradientes body. Muchos deben convertirse a tokens con alpha.

### C. Páginas standalone con tokens duplicados

`splash.html`, `setup.html`, `activation.html` no comparten `variables.css`. Al crear dual-theme hay que:
- Extraer a `variables.css` + `variables-light.css`, o
- Usar el mismo mecanismo `data-theme` en cada página

### D. Efectos neon en splash/activation

Contradicen reglas de identidad. Decidir si se mantienen solo en splash o se alinean.

### E. `nota_entrega.html` con tema azul

Independiente de Nexus navy/ámbar. Evaluar si unificar o dejar como documento impreso neutro.

### F. Inline styles

~100 instancias — migrar gradualmente a clases utilitarias.

### G. Overlay modal

`rgba(0,0,0,0.75)` fijo — en modo claro podría necesitar `--overlay-bg`.

### H. Gradiente highlight en cards

`rgba(255,255,255,0.015)` — en modo claro podría invertirse a sombra sutil oscura.

---

## 22. Plan recomendado para modo claro + oscuro

### Paso 1 — Estructura de tokens

```css
/* variables.css */
:root,
[data-theme="dark"] {
  /* tokens actuales */
}

[data-theme="light"] {
  /* tokens equivalentes para fondos claros, texto oscuro */
  /* MANTENER: --accent-primary: #f0a500 */
  /* AJUSTAR: --text-on-accent, fondos, bordes, sombras */
}
```

### Paso 2 — Activación

```js
// Al arranque (app.js o navbar.js)
const saved = localStorage.getItem('nexus_theme') || 'dark';
document.documentElement.setAttribute('data-theme', saved);
```

Toggle en Configuración → Apariencia (nueva sección).

### Paso 3 — Meta y Electron

- Actualizar `<meta name="theme-color">` dinámicamente
- Considerar `backgroundColor` en BrowserWindow para evitar flash blanco

### Paso 4 — Migrar hardcoded

Prioridad:
1. `components.css` badges y `.btn-primary:hover`
2. `pos.css` banners de cobro
3. `pages.css` cashea stats y semáforos
4. JS fallbacks en `dashboard.js`

### Paso 5 — Tokens nuevos sugeridos para light

| Token nuevo | Propósito |
|-------------|-----------|
| `--overlay-bg` | Fondo modal overlay |
| `--body-gradient-amber` | Gradiente radial ámbar |
| `--body-gradient-info` | Gradiente radial azul |
| `--card-highlight` | Brillo superior de cards |
| `--badge-{estado}-bg/text/border` | Badges semáforo |
| `--shadow-sm/md/lg` | Sombras más suaves en light |

### Paso 6 — Modo claro: valores orientativos (borrador)

| Token | Dark (actual) | Light (propuesta inicial) |
|-------|---------------|---------------------------|
| `--bg-primary` | `#05080f` | `#f4f6fa` |
| `--bg-secondary` | `#090d18` | `#ffffff` |
| `--bg-tertiary` | `#0d1424` | `#eef1f6` |
| `--text-primary` | `#edf2f7` | `#1a2332` |
| `--text-secondary` | `#7a8fa8` | `#5a6d85` |
| `--text-muted` | `#3d5068` | `#8fa3b8` |
| `--text-bright` | `#ffffff` | `#0d1520` |
| `--border-primary` | `#1a2540` | `#d0dae8` |
| `--text-on-accent` | `#05080f` | `#05080f` (mantener) |
| `--accent-primary` | `#f0a500` | `#f0a500` (mantener) |

### Paso 7 — Validación

Checklist de identidad (aplica a ambos modos):
- [ ] Acento ámbar `#f0a500` en botón primario y tasa BCV
- [ ] Números en DM Mono
- [ ] Headers tabla mono uppercase
- [ ] Sin efectos neon
- [ ] Sin cyan como acento principal
- [ ] Fondo con profundidad (no plano)
- [ ] Sidebar ítem activo con borde ámbar izquierdo

### Paso 8 — Alcance por capa

| Capa | Esfuerzo | Notas |
|------|----------|-------|
| `variables.css` | Alto | Core del cambio |
| `base.css` | Medio | Gradientes body |
| `components.css` | Medio | Limpiar hex |
| `pages.css` | Alto | Muchos rgba/hex |
| `pos.css` | Alto | Gradientes cobro |
| Standalone HTML | Medio | 3 archivos |
| Plantillas impresión | Ninguno | Ya son claras |
| Chart.js | Bajo | Ya lee CSS vars |

---

## Apéndice A — Mapa de módulos y archivos visuales

| Módulo | HTML | JS | CSS (pages.css sección) |
|--------|------|----|-------------------------|
| Dashboard | `dashboard.html` | `dashboard.js` | `[dashboard]` |
| POS | `pos.html` | `pos.js` | `pos.css` dedicado |
| Inventario | `inventario.html` | `inventario.js` | `[inventario]` |
| Ventas | `ventas.html` | `ventas.js` | `[ventas]` |
| Clientes | `clientes.html` | `clientes.js` | `[clientes]` |
| Cartera | `cartera.html` | `cartera.js` | `[cartera]` |
| Caja | `caja.html` | `caja.js` | `[caja]` |
| Compras | `compras.html` | `compras.js` | `[compras]` |
| Proveedores | `proveedores.html` | `proveedores.js` | `[proveedores]` |
| Reportes | `reportes.html` | `reportes.js` | `MÓDULO: REPORTES` |
| Configuración | `configuracion.html` | `configuracion.js` | `[configuracion]` |
| Usuarios | `usuarios.html` | `usuarios.js` | `[usuarios]` |
| Cashea | `cashea.html` | `cashea.js` | `[cashea]` |
| Login | `login/login.html` | (en app.js/router) | `MÓDULO: LOGIN` |

---

## Apéndice B — Clases utilitarias de color/texto

```css
.text-success, .text-warning, .text-danger, .text-info, .text-muted, .text-secondary
.bg-success-soft, .bg-warning-soft, .bg-danger-soft
```

Definidas en `pages.css` y parcialmente en `components.css`.

---

## Apéndice C — Convención de nombres de clases por módulo

| Prefijo | Módulo |
|---------|--------|
| `dash-`, `dk-` | Dashboard |
| `pos-`, `cobro-` | POS |
| `inv-` | Inventario |
| `ventas-`, `dev-modal-` | Ventas |
| `cli-`, `perfil-`, `pago-` | Clientes |
| `cartera-`, `aging-`, `abono-` | Cartera |
| `caja-`, `cierre-`, `conteo-`, `cuadre-` | Caja |
| `compras-`, `compra-` | Compras |
| `cfg-`, `config-`, `lic-`, `bcv-` | Configuración |
| `cashea-` | Cashea |
| `login-` | Login |
| `reportes-` | Reportes |

---

## Apéndice D — Archivos de reglas/skills relacionados

| Archivo | Contenido |
|---------|-----------|
| `.cursor/rules/IDENTIDAD-VISUAL-NEXUS-CORE.mdc` | Reglas de color, tipografía, neon |
| `.cursor/skills/nexus-sistema-disenio-css/SKILL.md` | Especificaciones CSS canónicas |
| `.cursor/skills/nexus-componente-nuevo/SKILL.md` | Estructura HTML obligatoria nuevos módulos |

---

*Documento generado para servir de mapa completo antes de implementar `data-theme="light"` / `data-theme="dark"` en Nexus Core.*
