---
name: nexus-componente-nuevo
description: >
  Activar cuando el usuario pide agregar una pantalla nueva, un módulo nuevo,
  un componente de UI nuevo, una sección nueva en una página existente, o cuando
  hay que crear cualquier elemento visual que no existe todavía en el sistema.
  También activar si el usuario dice: "agrega una vista de", "crea la pantalla de",
  "necesito un componente para", "añade una sección", "implementa la UI de".
disable-model-invocation: false
---

# NEXUS-SKILL-06 · COMPONENTES Y PÁGINAS NUEVAS — ANTI-GENÉRICO

Coexistencia: esta skill trabaja en conjunto con nexus-implementacion-segura (Fase 5F-G)
y nexus-sistema-disenio-css. Respetar IDENTIDAD-VISUAL-NEXUS-CORE.mdc (alwaysApply).
PROHIBIDO estilo neon: text-shadow con blur, halos de color, acentos cyan eléctricos.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRINCIPIO: CADA COMPONENTE ES ESPECÍFICO DE NEXUS CORE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PROHIBIDO generar componentes "de tutorial" o "de ejemplo".
PROHIBIDO copiar patrones de UI de librerías externas (Shadcn, MUI, Bootstrap).
PROHIBIDO crear HTML que podría pertenecer a cualquier otro proyecto.

Cada elemento nuevo debe responder a preguntas específicas del dominio:
  ¿Qué necesita ver un cajero venezolano en esta pantalla?
  ¿Qué dato financiero es el más importante aquí?
  ¿Cómo se integra con el sistema BCV/USD/Bs?

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TEMPLATE CANÓNICO DE PÁGINA NUEVA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Todo frontend/pages/[modulo]/[modulo].html sigue esta estructura SIN excepciones.

```html
<!-- frontend/pages/[modulo]/[modulo].html -->
<div class="[modulo]-page">

  <!-- HEADER DE PÁGINA — siempre esta estructura exacta -->
  <div class="page-header">
    <div class="page-header-info">
      <h1 class="page-title">[NOMBRE EN MAYÚSCULAS]</h1>
      <p class="page-subtitle">[descripción operativa de 1 línea — qué hace este módulo]</p>
    </div>
    <div class="page-actions">
      <!-- Acciones primarias: máximo 3 botones -->
      <!-- Botón más importante: .btn.btn-primary -->
      <!-- Exportar/secundario: .btn.btn-secondary -->
    </div>
  </div>

  <!-- FILTROS (si aplica) — siempre antes del contenido principal -->
  <div class="[modulo]-filtros">
    <!-- inputs de búsqueda y filtros -->
  </div>

  <!-- CONTENIDO PRINCIPAL -->
  <!-- Si es una tabla: -->
  <div class="data-table-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <!-- th normales: font-mono, uppercase, color muted — ya definido en components.css -->
          <!-- th numéricos: añadir clase .num -->
        </tr>
      </thead>
      <tbody id="[modulo]-tbody">
        <!-- Filas renderizadas por JS con textContent -->
      </tbody>
    </table>
  </div>

  <!-- Si hay estado vacío -->
  <div class="empty-state" id="[modulo]-empty" style="display:none">
    <p class="empty-state-text">No hay [entidad] registrados.</p>
    <button class="btn btn-primary" id="[modulo]-btn-agregar-empty">
      + Agregar primer [entidad]
    </button>
  </div>

</div>
```

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TEMPLATE CANÓNICO DE MODAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

```html
<div class="modal-overlay" id="[modulo]-modal-[accion]" style="display:none">
  <div class="modal">

    <div class="modal-header">
      <h2>[TÍTULO ACCIÓN EN MAYÚSCULAS]</h2>
      <button class="btn btn-icon modal-close" data-modal="[modulo]-modal-[accion]">✕</button>
    </div>

    <div class="modal-body">
      <!-- Formulario o contenido -->

      <!-- Campos de monto — siempre con clase para fuente mono -->
      <div class="form-group">
        <label class="form-label">Monto USD</label>
        <input type="number" class="form-input input-mono" id="..." />
        <!-- input-mono aplica font-family: var(--font-mono) automáticamente -->
      </div>

    </div>

    <div class="modal-footer">
      <button class="btn btn-ghost" data-modal-close="[modulo]-modal-[accion]">Cancelar</button>
      <button class="btn btn-primary" id="[modulo]-btn-confirmar">Confirmar</button>
    </div>

  </div>
</div>
```

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CSS DE MÓDULO NUEVO — ESTRUCTURA EN pages.css
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Al agregar estilos de un módulo nuevo a pages.css:

```css
/* ════════════════════════════════════════════════
   MÓDULO: [NOMBRE EN MAYÚSCULAS]
   Archivo: pages/[modulo]/[modulo].html + [modulo].js
   ════════════════════════════════════════════════ */

/* Contenedor raíz del módulo */
.[modulo]-page {
  /* Normalmente no necesita estilos — el layout lo maneja base.css */
}

/* Filtros específicos del módulo */
.[modulo]-filtros {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}

/* Columnas o elementos con layout específico del módulo */
.[modulo]-[elemento] {
  /* Usar SOLO variables de variables.css */
  /* PROHIBIDO hardcodear colores, tamaños de fuente o sombras */
}
```

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PATRONES DE DATO FINANCIERO — USO OBLIGATORIO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Cada vez que un componente muestre datos numéricos financieros,
aplicar estos patrones sin excepción:

MONTO EN TABLA:
  <td class="num">[valor formateado con currencyDisplay.js]</td>
  → font-mono, text-align: right — ya definido en components.css para .num

TASA DE CAMBIO INLINE:
  <span class="rate-inline">563.2892</span>
  → font-family: var(--font-mono), color: var(--text-accent)

TOTAL DESTACADO (no en tabla, en card o modal):
  <div class="amount-display">
    <span class="amount-label">TOTAL BCV</span>
    <span class="amount-value">$ 1.250,00</span>
  </div>
  → amount-value: font-mono, tamaño > 18px, color: --text-bright

NÚMERO DE DOCUMENTO:
  <span class="doc-number">V-2026-00042</span>
  → font-family: var(--font-mono), font-size: var(--text-sm), letter-spacing: 0.04em

BADGE DE ESTADO (siempre .badge + modificador):
  <span class="badge badge-completada">PAGADO</span>
  <span class="badge badge-anulada">ANULADO</span>
  <span class="badge badge--yellow">PENDIENTE</span>
  → font-mono, uppercase, rectangular (border-radius: 2px), con borde

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ESTADOS VACÍOS — CÓMO HACERLOS SIN QUE PAREZCAN GENÉRICOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PROHIBIDO: ilustraciones SVG de "caja vacía", "cohete", "lupa" decorativas.
PROHIBIDO: texto genérico como "No hay datos disponibles" o "Empty state".

CORRECTO — específico al dominio:
  "Todavía no tienes productos registrados."
  "Ningún cliente coincide con ese RIF o nombre."
  "No hay ventas en este rango de fechas."
  "La caja está cerrada — abre tu turno para operar."

CORRECTO — estructura CSS:
```css
.empty-state {
  text-align: center;
  padding: 48px 24px;
  color: var(--text-muted);
}
.empty-state-text {
  font-family: var(--font-ui);
  font-size: var(--text-md);
  margin-bottom: 16px;
}
/* Sin iconos decorativos. Si hay ícono, que sea funcional (el de la acción). */
```

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LOADING STATES — SKELETON SIN LIBRERÍA EXTERNA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

No importar librerías de skeleton. Implementar con CSS nativo:

```css
@keyframes nexus-shimmer {
  0%   { background-position: -200% center; }
  100% { background-position: 200% center; }
}

.skeleton {
  background: linear-gradient(
    90deg,
    var(--bg-tertiary) 25%,
    var(--bg-accent) 50%,
    var(--bg-tertiary) 75%
  );
  background-size: 200% auto;
  animation: nexus-shimmer 1.4s linear infinite;
  border-radius: var(--radius-sm);
}

.skeleton-text  { height: 13px; margin-bottom: 8px; }
.skeleton-title { height: 20px; width: 40%; margin-bottom: 16px; }
.skeleton-row   { height: 38px; margin-bottom: 4px; }
```

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CHECKLIST ANTES DE ENTREGAR UN COMPONENTE NUEVO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  [ ] ¿Todo valor numérico tiene clase .num o fuente mono explícita?
  [ ] ¿Los badges usan .badge + modificador con border-radius: 2px?
  [ ] ¿El estado vacío tiene texto específico del dominio venezolano?
  [ ] ¿Los labels de formulario son font-mono uppercase pequeño?
  [ ] ¿Los botones de acción primaria son .btn-primary con ámbar?
  [ ] ¿El modal tiene .modal-header con h2 en font-display uppercase?
  [ ] ¿El CSS nuevo está en la sección correcta de pages.css con prefijo?
  [ ] ¿Ningún color está hardcodeado — todo usa var(--)?
  [ ] ¿Sin efectos neon (text-shadow colorido, halo box-shadow, cyan eléctrico)?
  [ ] ¿El componente nuevo se ve como parte de Nexus Core y no como
      un componente que podría haber salido de cualquier template?

Si el último punto genera duda → revisar qué elemento causa la sensación genérica
y ajustarlo con tipografía, espaciado o color hasta que encaje en la identidad.
