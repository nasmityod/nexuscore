'use strict';

/**
 * Marca Cashea: icono + etiqueta reutilizable en tablas, listas y textos UI.
 * Imagen: frontend/assets/images/cashea.webp (misma que POS cobro).
 */
(function () {
  var ICON_SRC = 'assets/images/cashea.webp';

  function isCasheaMetodo(key) {
    return String(key || '').trim().toLowerCase() === 'cashea';
  }

  function isCasheaText(text) {
    return /\bcashea\b/i.test(String(text == null ? '' : text));
  }

  function iconHtml(width, height) {
    var w = width != null ? width : 18;
    var h = height != null ? height : w;
    return (
      '<img class="nexus-cashea-icon" src="' +
      ICON_SRC +
      '" alt="" width="' +
      w +
      '" height="' +
      h +
      '" loading="lazy" decoding="async" aria-hidden="true" />'
    );
  }

  /** Etiqueta visible con icono (HTML seguro para innerHTML). */
  function labelHtml(label, width, height) {
    var txt = label != null && String(label).trim() !== '' ? String(label) : 'Cashea';
    return (
      '<span class="nexus-metodo-pago nexus-metodo-pago--cashea">' +
      iconHtml(width, height) +
      '<span class="nexus-cashea-label">' +
      txt +
      '</span></span>'
    );
  }

  /**
   * Celda de método de pago: icono si es Cashea; texto plano escapado si no.
   * @param {string} metodoKey
   * @param {string} plainLabel — ya formateado (ej. «Cashea · $ BCV»)
   * @param {function} esc — escapeHtml del módulo llamador
   */
  function metodoCellHtml(metodoKey, plainLabel, esc) {
    var escapeFn =
      typeof esc === 'function'
        ? esc
        : function (s) {
            return String(s == null ? '' : s);
          };
    if (isCasheaMetodo(metodoKey)) {
      return labelHtml(plainLabel || 'Cashea', 20, 20);
    }
    return escapeFn(plainLabel || metodoKey || '—');
  }

  /** Inserta método en <td> sin innerHTML (lista ventas). */
  function appendMetodoToCell(td, metodoKey, plainLabel) {
    if (!td) return;
    while (td.firstChild) td.removeChild(td.firstChild);
    if (isCasheaMetodo(metodoKey)) {
      var wrap = document.createElement('span');
      wrap.className = 'nexus-metodo-pago nexus-metodo-pago--cashea';
      var img = document.createElement('img');
      img.className = 'nexus-cashea-icon';
      img.src = ICON_SRC;
      img.width = 20;
      img.height = 20;
      img.alt = '';
      img.decoding = 'async';
      var span = document.createElement('span');
      span.className = 'nexus-cashea-label';
      span.textContent = plainLabel || 'Cashea';
      wrap.appendChild(img);
      wrap.appendChild(document.createTextNode(' '));
      wrap.appendChild(span);
      td.appendChild(wrap);
      return;
    }
    td.textContent = plainLabel || metodoKey || '—';
  }

  /**
   * Sustituye la palabra «Cashea» por icono+texto en cadenas para innerHTML.
   * El resto del texto se escapa con `esc`.
   */
  function enrichTextHtml(text, esc, iconSize) {
    var escapeFn =
      typeof esc === 'function'
        ? esc
        : function (s) {
            return String(s == null ? '' : s);
          };
    var s = String(text == null ? '' : text);
    if (!isCasheaText(s)) return escapeFn(s);
    var parts = s.split(/(\bCashea\b)/gi);
    var out = '';
    for (var i = 0; i < parts.length; i += 1) {
      if (/^cashea$/i.test(parts[i])) {
        out += labelHtml('Cashea', iconSize, iconSize);
      } else if (parts[i]) {
        out += escapeFn(parts[i]);
      }
    }
    return out;
  }

  function defaultEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Aplica icono en nodos con data-cashea-enrich-text="texto completo". */
  function enrichRoot(root) {
    if (!root || !root.querySelectorAll) return;
    var nodes = root.querySelectorAll('[data-cashea-enrich-text]');
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      var t = el.getAttribute('data-cashea-enrich-text') || el.textContent || '';
      el.innerHTML = enrichTextHtml(t, defaultEsc, 16);
    }
  }

  window.NexusCasheaBrand = {
    ICON_SRC: ICON_SRC,
    isCasheaMetodo: isCasheaMetodo,
    isCasheaText: isCasheaText,
    iconHtml: iconHtml,
    labelHtml: labelHtml,
    metodoCellHtml: metodoCellHtml,
    appendMetodoToCell: appendMetodoToCell,
    enrichTextHtml: enrichTextHtml,
    enrichRoot: enrichRoot
  };
})();
