---
name: nexus-sistema-disenio-css
description: >
  Activar al modificar cualquier archivo CSS en frontend/assets/css/, al crear
  componentes UI nuevos, al agregar páginas/módulos en frontend/pages/, o al
  trabajar en la apariencia del dashboard, sidebar, navbar, tablas, formularios,
  modales, badges o el POS. También activar si el usuario menciona palabras como
  "diseño", "visual", "estilo", "se ve", "apariencia", "color", "fuente" o "layout".
disable-model-invocation: false
---

# NEXUS-SKILL-05 · SISTEMA DE DISEÑO CSS — SALA DE CONTROL FINANCIERO

Coexistencia con reglas del repo: esta skill opera SOLO sobre la capa de presentación
(frontend/assets/css/*). No toca lógica JS, rutas Express, ni BD.
Respetar IDENTIDAD-VISUAL-NEXUS-CORE.mdc que tiene alwaysApply: true.

REGLA NEON (heredada de la rule, reforzar siempre):
  JAMÁS text-shadow con blur de color, box-shadow tipo halo (0 0 Npx rgba color),
  filter drop-shadow colorido, ni acentos cyan/teal eléctricos.
  Acento = color sólido ámbar + fondos tintados planos. Sin resplandor.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONCEPTO VISUAL — LEER ANTES DE TOCAR UN PIXEL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Nexus Core es un instrumento de trabajo financiero venezolano.
No es una app SaaS. No es un dashboard de startup. No es un template.

Concepto: SALA DE CONTROL FINANCIERO.
  - Un cajero lo usa 8 horas frente al mostrador.
  - Muestra tasas BCV en tiempo real, bolívares, dólares, Cashea.
  - Cada número importa. Cada cifra tiene consecuencias económicas reales.

La UI debe comunicar: precisión, confiabilidad, densidad de información sin caos.
Referencias de tono (inspirar, NO copiar): Bloomberg Terminal, Refinitiv Eikon.
Lo opuesto a: Notion, Linear, Vercel Dashboard, cualquier clone de Shadcn.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ARQUITECTURA CSS — MAPA COMPLETO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Orden de carga en index.html (INMUTABLE — no reordenar, no agregar entre medias):

  1. variables.css   → Design tokens. El único lugar donde viven colores y fuentes.
  2. base.css        → Reset universal, layout root, scrollbars, body.
  3. components.css  → Componentes transversales: sidebar, navbar, botones,
                       tablas .data-table, formularios, modales, badges, toasts.
  4. pages.css       → Estilos POR MÓDULO. Cada sección claramente delimitada.
  5. animations.css  → Keyframes y clases de animación reutilizables. Solo aquí.
  6. pos.css         → UI exclusiva del Punto de Venta. No mezclar con otros módulos.

PROTOCOLO AL ESCRIBIR CSS NUEVO:
  PASO 1: ¿El valor ya existe como variable en variables.css? → usar la variable.
  PASO 2: ¿El componente es transversal (aparece en 2+ módulos)? → components.css.
  PASO 3: ¿El estilo es de un módulo específico? → sección correcta de pages.css.
  PASO 4: ¿Es solo para el POS? → pos.css.
  PASO 5: ¿Es una animación/keyframe? → animations.css.
  PROHIBIDO: estilos inline en HTML, <style> tags en páginas de módulo.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DESIGN TOKENS v3.0 — VALORES CANÓNICOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FONDOS (de más oscuro a más elevado):
  --bg-primary:    #05080f   ← base de la app, el más oscuro
  --bg-secondary:  #090d18   ← sidebar, cards, header
  --bg-tertiary:   #0d1424   ← inputs, hover suave, thead
  --bg-accent:     #111d32   ← filas hover, ítem activo sidebar
  --bg-elevated:   #162035   ← modales, dropdowns, tooltips
  --bg-glass:      rgba(9,13,24,0.85)

ACENTO — EL COLOR DE NEXUS CORE:
  --accent-primary:     #f0a500   ← ámbar financiero. ÚNICO acento principal.
  --accent-primary-dim: #c47f00   ← hover del botón primario
  --accent-primary-glow:rgba(240,165,0,0.12)  ← solo tinte de fondo plano; NO usar con text-shadow
  --accent-primary-bg:  rgba(240,165,0,0.07)
  --text-on-accent:     #05080f   ← texto sobre botón primario
  --text-accent:        #f0a500

ACENTO SECUNDARIO (solo para datos informativos, BCV info):
  --accent-info:    #3b82f6   ← azul puro, NO como acento visual principal
  --accent-info-dim:rgba(59,130,246,0.15)

ESTADOS:
  --accent-success: #22c55e   ← ventas completadas, stock OK
  --accent-warning: #f59e0b   ← stock bajo, alertas
  --accent-danger:  #ef4444   ← anulaciones, errores

BORDES:
  --border-primary: #1a2540
  --border-subtle:  #0e1a2e
  --border-accent:  rgba(240,165,0,0.25)
  --border-muted:   rgba(255,255,255,0.04)

TEXTO:
  --text-primary:   #edf2f7
  --text-secondary: #7a8fa8
  --text-muted:     #3d5068
  --text-bright:    #ffffff

TIPOGRAFÍA:
  --font-ui:      'Sora', system-ui, sans-serif
  --font-primary: 'Sora', system-ui, sans-serif
  --font-display: 'Barlow Condensed', sans-serif
  --font-mono:    'DM Mono', 'JetBrains Mono', 'Fira Code', monospace

ESCALA TIPOGRÁFICA:
  --text-xs:   11px   ← badges, metadatos, pie de ticket
  --text-sm:   12px   ← labels secundarios
  --text-base: 13.5px ← cuerpo general
  --text-md:   15px   ← subtítulos
  --text-lg:   17px   ← títulos de sección
  --text-xl:   20px   ← page-title
  --text-2xl:  26px   ← KPIs secundarios
  --text-3xl:  36px   ← KPI principal del dashboard

DIMENSIONES:
  --sidebar-width:  210px
  --header-height:  50px
  --radius-sm:      3px
  --radius-md:      6px
  --radius-lg:      10px    ← máximo permitido en contenedores
  --height-btn:     38px
  --height-input:   38px

SOMBRAS:
  --shadow-sm:     0 1px 3px rgba(0,0,0,0.4)
  --shadow-md:     0 4px 16px rgba(0,0,0,0.5)
  --shadow-lg:     0 8px 32px rgba(0,0,0,0.6)
  --shadow-accent: 0 2px 10px rgba(240,165,0,0.22), 0 1px 3px rgba(0,0,0,0.45)
                   ← profundidad sutil; PROHIBIDO 0 0 Npx (halo neon)
  --shadow-inset:  inset 0 1px 0 rgba(255,255,255,0.03)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMPONENTES — ESPECIFICACIONES EXACTAS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## SIDEBAR

Identidad visual: fondo --bg-secondary con gradiente ámbar sutil en top 200px.
Border-right: 1px solid --border-primary.

Marca (.sidebar-brand, .app-name):
  font-family: var(--font-display)
  font-weight: 800
  font-size: 18px
  letter-spacing: 0.08em
  text-transform: uppercase
  color: var(--text-bright)

Sub-marca (ERP · POS):
  font-family: var(--font-mono)
  font-size: 10px
  letter-spacing: 0.2em
  color: var(--accent-primary)

Section headers del sidebar:
  font-family: var(--font-mono)
  font-size: 9.5px
  letter-spacing: 0.18em
  text-transform: uppercase
  color: var(--text-muted)
  padding: 16px 16px 4px

Ítem normal:
  font-family: var(--font-ui)
  font-size: 12.5px
  font-weight: 400
  color: var(--text-secondary)
  border-left: 2px solid transparent

Ítem hover:
  color: var(--text-primary)
  background: var(--bg-accent)
  border-left-color: rgba(240,165,0,0.4)

Ítem ACTIVO (firma visual):
  color: var(--accent-primary)
  background: var(--accent-primary-bg)
  border-left: 2px solid var(--accent-primary)
  font-weight: 500

## NAVBAR / HEADER

background: var(--bg-secondary)
border-bottom: 1px solid var(--border-primary)
box-shadow: 0 1px 0 var(--border-subtle), 0 2px 8px rgba(0,0,0,0.3)

DISPLAY TASA BCV — el elemento más único de Nexus Core:
  font-family: var(--font-mono)
  font-size: 13px
  font-weight: 500
  color: var(--accent-primary)
  background: var(--accent-primary-bg)
  border: 1px solid var(--border-accent)
  border-radius: var(--radius-sm)
  padding: 4px 10px
  PROHIBIDO: text-shadow, box-shadow con halo de color (estilo neon)

## BOTONES

.btn base:
  font-family: var(--font-ui)
  font-size: 12.5px
  font-weight: 500
  letter-spacing: 0.02em
  border-radius: var(--radius-sm)  ← 3px, no más
  height: var(--height-btn)

.btn-primary:
  background: var(--accent-primary)
  color: var(--text-on-accent)
  box-shadow: var(--shadow-sm)
  font-weight: 600
  hover → background: #d49200, translateY(-1px)
  active → translateY(0)
  PROHIBIDO: box-shadow tipo 0 0 Npx rgba (halo neon)

.btn-success: background #22c55e, color white
.btn-danger:  background var(--accent-danger), color white
.btn-warning: background var(--accent-warning), color var(--text-on-accent)
.btn-ghost:   background transparent, border 1px solid var(--border-primary)

## TABLAS .data-table

thead th:
  font-family: var(--font-mono)
  font-size: 10px
  font-weight: 500
  letter-spacing: 0.14em
  text-transform: uppercase
  color: var(--text-muted)
  background: var(--bg-tertiary)
  border-bottom: 1px solid var(--border-primary)
  position: sticky; top: 0

tbody tr:
  border-bottom: 1px solid var(--border-subtle)
  transition: background 120ms ease

tbody tr:hover:
  background: var(--bg-accent)

td.num (columnas numéricas — OBLIGATORIO):
  font-family: var(--font-mono)
  font-size: 12.5px
  text-align: right
  color: var(--text-primary)

.is-warn: background rgba(245,158,11,0.06)
.is-danger: background rgba(239,68,68,0.08)

## BADGES

Todos los badges:
  font-family: var(--font-mono)
  font-size: 10px
  letter-spacing: 0.08em
  text-transform: uppercase
  border-radius: 2px  ← rectangulares, NO pills/rounded
  padding: 2px 7px
  border: 1px solid (color semitransparente del badge)

.badge-completada: bg rgba(34,197,94,0.12), color #4ade80, border rgba(34,197,94,0.2)
.badge-anulada:    bg rgba(239,68,68,0.12), color #f87171, border rgba(239,68,68,0.2)
.badge--blue:      bg rgba(59,130,246,0.12), color #93c5fd, border rgba(59,130,246,0.2)
.badge--yellow:    bg rgba(245,158,11,0.12), color #fcd34d, border rgba(245,158,11,0.2)
.badge--purple:    bg rgba(168,85,247,0.12), color #c4b5fd, border rgba(168,85,247,0.2)

## INPUTS / FORMULARIOS

.form-input, .form-select, .input-g:
  background: var(--bg-tertiary)
  border: 1px solid var(--border-primary)
  border-radius: var(--radius-sm)
  color: var(--text-primary)
  font-family: var(--font-ui)
  font-size: var(--text-base)
  height: var(--height-input)

:focus:
  border-color: var(--accent-primary)
  box-shadow: 0 0 0 3px var(--accent-primary-bg)
  outline: none

.form-label:
  font-family: var(--font-mono)
  font-size: 10px
  letter-spacing: 0.14em
  text-transform: uppercase
  color: var(--text-muted)

Inputs numéricos (montos, cantidades, tasas):
  font-family: var(--font-mono)
  letter-spacing: 0.02em

## CARDS / PANELS

background: var(--bg-secondary)
border: 1px solid var(--border-primary)
border-radius: var(--radius-md)  ← 6px máximo en cards normales
box-shadow: var(--shadow-sm)
background-image: linear-gradient(180deg, rgba(255,255,255,0.015) 0%, transparent 60px)

## MODALES

background: var(--bg-elevated)
border: 1px solid var(--border-primary)
border-radius: var(--radius-lg)  ← 10px permitido en modales
box-shadow: var(--shadow-lg)

.modal-header:
  border-bottom: 1px solid var(--border-subtle)
  padding: 16px 20px

.modal-header h2:
  font-family: var(--font-display)
  font-size: 16px
  font-weight: 700
  letter-spacing: 0.04em
  text-transform: uppercase

## PAGE HEADERS (.page-header)

.page-title:
  font-family: var(--font-display)
  font-size: var(--text-xl)  ← 20px
  font-weight: 700
  letter-spacing: 0.04em
  text-transform: uppercase
  color: var(--text-bright)

.page-subtitle:
  font-family: var(--font-ui)
  font-size: 12px
  color: var(--text-muted)
  letter-spacing: 0.01em

## DASHBOARD KPI CARDS

Card principal (ventas de hoy):
  border-left: 3px solid var(--accent-primary)
  padding: 20px 24px

KPI label:
  font-family: var(--font-mono)
  font-size: 9.5px
  letter-spacing: 0.2em
  text-transform: uppercase
  color: var(--text-muted)

KPI valor PRINCIPAL (debe verse desde 1 metro de distancia):
  font-family: var(--font-mono)
  font-size: 36px
  font-weight: 400
  color: var(--text-bright)
  line-height: 1
  letter-spacing: -0.01em

KPI valores secundarios:
  font-family: var(--font-mono)
  font-size: 22px
  color: var(--text-primary)

KPI sub-etiqueta:
  font-family: var(--font-mono)
  font-size: 11.5px
  color: var(--text-muted)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FONDO DE LA APP — PROFUNDIDAD OBLIGATORIA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

El fondo NUNCA es un color sólido plano. Siempre lleva gradientes radiales:

body {
  background-color: var(--bg-primary);
  background-image:
    radial-gradient(ellipse 80% 50% at 15% -10%, rgba(240,165,0,0.04) 0%, transparent 70%),
    radial-gradient(ellipse 60% 40% at 85% 110%, rgba(59,130,246,0.03) 0%, transparent 70%);
  background-attachment: fixed;
}

Estos gradientes son sutiles e invisibles a primera vista. Crean profundidad
perceptible sin ser decorativos. NO aumentar su opacidad.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROTOCOLO PARA AGREGAR UN MÓDULO/PÁGINA NUEVO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Al crear frontend/pages/[nuevo-modulo]/:

HTML — estructura canónica obligatoria:
  <div class="page-header">
    <div>
      <h1 class="page-title">[NOMBRE MÓDULO]</h1>
      <p class="page-subtitle">[descripción operativa breve]</p>
    </div>
    <div class="page-actions">
      <!-- botones de acción principal aquí -->
    </div>
  </div>
  <div class="page-content">
    <!-- contenido del módulo -->
  </div>

Tablas en el módulo: siempre .data-table-wrap > table.data-table
Columnas numéricas: clase .num en <td> Y <th> correspondiente
Botón primario: .btn.btn-primary en .page-actions
Notificaciones: toast.js — NUNCA alert() ni confirm()

CSS del módulo nuevo:
  - Sección delimitada en pages.css: /* ── MÓDULO: [nombre] ── */
  - Prefijo de clase: .[modulo]-[elemento] (ej: .compras-filtros)
  - Solo usar variables de variables.css, nunca valores hardcodeados

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CHART.JS — CONFIGURACIÓN VISUAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Los gráficos del dashboard usan Chart.js 3.9.1. Configuración de identidad:

Dataset de línea principal:
  borderColor: '#f0a500'         ← acento primario
  backgroundColor: 'rgba(240,165,0,0.08)'
  borderWidth: 1.5
  pointRadius: 0                 ← sin puntos, línea limpia
  tension: 0.3

Dataset de línea secundaria (ayer/comparación):
  borderColor: 'rgba(255,255,255,0.15)'
  backgroundColor: 'transparent'
  borderWidth: 1
  borderDash: [4, 4]
  pointRadius: 0

Grid del gráfico:
  color: 'rgba(255,255,255,0.04)'   ← casi invisible

Ejes:
  color: '#3d5068'                   ← --text-muted
  font: { family: 'DM Mono', size: 10 }

Plugins.legend:
  labels.color: '#7a8fa8'            ← --text-secondary
  labels.font.family: 'DM Mono'
  labels.font.size: 11

Tooltip:
  backgroundColor: '#162035'         ← --bg-elevated
  borderColor: '#1a2540'               ← --border-primary
  borderWidth: 1
  titleColor: '#edf2f7'
  bodyColor: '#7a8fa8'
  titleFont: { family: 'DM Mono', size: 11 }
  bodyFont: { family: 'DM Mono', size: 11 }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SCROLLBARS — IDENTIDAD PROPIA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

::-webkit-scrollbar       { width: 5px; height: 5px; }
::-webkit-scrollbar-track { background: var(--bg-primary); }
::-webkit-scrollbar-thumb { background: var(--border-primary); border-radius: 10px; }
::-webkit-scrollbar-thumb:hover { background: var(--accent-primary); }
