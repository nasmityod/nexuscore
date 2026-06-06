'use strict';

/**
 * Sanitización de texto para insertar en HTML (evita XSS en innerHTML).
 * NEXUS-DUAL: misma semántica que escapeHtml en POS; centralizado para nuevas pantallas.
 */
(function () {
  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  window.NexusDomSafe = window.NexusDomSafe || {};
  window.NexusDomSafe.escapeHtml = escapeHtml;
})();
