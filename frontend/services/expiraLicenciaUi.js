'use strict';

/**
 * Texto legible para “Expira” en pantalla de licencia (zona horaria del equipo).
 * El backend suele enviar ISO en UTC; aquí se muestra en calendario local.
 *
 * @param {string|null|undefined} raw ISO 8601, "Perpetua", etc.
 * @returns {string}
 */
window.formatExpiraLicenciaUi = function formatExpiraLicenciaUi(raw) {
  if (raw == null || raw === '') return 'Sin fecha límite (perpetua)';
  var s = String(raw).trim();
  if (/^perpetua$/i.test(s)) return 'Sin fecha límite (perpetua)';
  var d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  try {
    return new Intl.DateTimeFormat('es', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    }).format(d);
  } catch (_e) {
    return d.toLocaleString('es');
  }
};
