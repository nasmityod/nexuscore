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

/**
 * Banner de expiración / estado de licencia (Fase 4.4.6).
 *
 * Comportamiento:
 *   - Prueba (trial): banner visible siempre con «Prueba: X día(s) restantes».
 *   - Suscripción: banner cuando faltan ≤ UMBRAL días (default 15).
 *   - Permanente: sin banner de vencimiento (salvo suspensión).
 *   - Color progresivo según días restantes: verde → amarillo → naranja → rojo (sin neón).
 *   - Estados bloqueantes (suspendida/revocada/vencida/gracia excedida): overlay que impide
 *     usar el sistema hasta reactivar.
 *
 * Se auto-monta solo en la ventana principal (detecta window.NexusComponents) y consulta el
 * estado local vía window.nexusLicense.getStatus() (IPC, sin red). Reevalúa cada hora y al
 * volver el foco a la ventana.
 */
(function () {
  var UMBRAL_DEFAULT = 15;
  var STYLE_ID = 'nexus-lic-banner-style';
  var BANNER_ID = 'nexus-lic-banner';
  var OVERLAY_ID = 'nexus-lic-overlay';

  var BLOQUEANTES = {
    suspended:      'Licencia suspendida. Contacta a tu proveedor para reactivarla.',
    revoked:        'Esta licencia fue revocada. Contacta a tu proveedor.',
    expired:        'Tu licencia venció. Renueva con tu proveedor para continuar.',
    grace_exceeded: 'No se ha podido verificar la licencia. Conéctate a internet para revalidar.',
    tampered:       'El archivo de licencia no es válido. Reactiva el sistema.',
    foreign:        'La licencia pertenece a otro equipo. Reactiva en este equipo.',
    none:           'Sin licencia activa. Activa Nexus Core para continuar.'
  };

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      '#' + BANNER_ID + '{position:sticky;top:0;z-index:900;font-family:var(--font-ui,sans-serif);' +
      'font-size:12.5px;padding:7px 16px;display:flex;align-items:center;justify-content:center;gap:10px;' +
      'border-bottom:1px solid var(--border-primary,#1a2540);text-align:center;}' +
      '#' + BANNER_ID + ' .nlb-days{font-family:var(--font-mono,monospace);font-weight:600;}' +
      '#' + BANNER_ID + '.nlb-info{background:rgba(59,130,246,.10);color:#93c5fd;border-bottom-color:rgba(59,130,246,.25);}' +
      '#' + BANNER_ID + '.nlb-ok{background:rgba(34,197,94,.10);color:#4ade80;border-bottom-color:rgba(34,197,94,.25);}' +
      '#' + BANNER_ID + '.nlb-warn{background:rgba(245,158,11,.12);color:#fcd34d;border-bottom-color:rgba(245,158,11,.3);}' +
      '#' + BANNER_ID + '.nlb-orange{background:rgba(234,88,12,.14);color:#fdba74;border-bottom-color:rgba(234,88,12,.35);}' +
      '#' + BANNER_ID + '.nlb-danger{background:rgba(239,68,68,.14);color:#fca5a5;border-bottom-color:rgba(239,68,68,.4);}' +
      '#' + OVERLAY_ID + '{position:fixed;inset:0;z-index:99999;background:rgba(5,8,15,.92);' +
      'display:flex;align-items:center;justify-content:center;padding:24px;font-family:var(--font-ui,sans-serif);}' +
      '#' + OVERLAY_ID + ' .nlo-card{max-width:440px;background:var(--bg-secondary,#090d18);border:1px solid var(--border-primary,#1a2540);' +
      'border-top:3px solid #ef4444;border-radius:10px;padding:28px 26px;text-align:center;}' +
      '#' + OVERLAY_ID + ' h2{font-family:var(--font-display,sans-serif);text-transform:uppercase;letter-spacing:.05em;' +
      'color:#fca5a5;font-size:18px;margin:0 0 10px;}' +
      '#' + OVERLAY_ID + ' p{color:var(--text-secondary,#7a8fa8);font-size:13.5px;line-height:1.6;margin:0;}';
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  function removeEl(id) { var e = document.getElementById(id); if (e) e.remove(); }

  function colorClass(dias, isTrial) {
    if (dias == null) return 'nlb-info';
    if (dias <= 1) return 'nlb-danger';
    if (dias <= 3) return 'nlb-orange';
    if (dias <= 7) return 'nlb-warn';
    return isTrial ? 'nlb-info' : 'nlb-ok';
  }

  function renderBanner(text, cls) {
    ensureStyle();
    removeEl(BANNER_ID);
    var bar = document.createElement('div');
    bar.id = BANNER_ID;
    bar.className = cls;
    bar.innerHTML = text;
    // Insertar al principio del layout principal si existe; si no, al inicio del body.
    var host = document.querySelector('.layout-main') || document.querySelector('main') || document.body;
    host.insertBefore(bar, host.firstChild);
  }

  function renderOverlay(reason) {
    ensureStyle();
    removeEl(OVERLAY_ID);
    var ov = document.createElement('div');
    ov.id = OVERLAY_ID;
    var card = document.createElement('div');
    card.className = 'nlo-card';
    var h = document.createElement('h2');
    h.textContent = 'Licencia no activa';
    var p = document.createElement('p');
    p.textContent = reason;
    card.appendChild(h); card.appendChild(p);
    ov.appendChild(card);
    document.body.appendChild(ov);
  }

  function apply(status) {
    if (!status) return;
    removeEl(OVERLAY_ID);
    removeEl(BANNER_ID);

    if (!status.ok) {
      var msg = BLOQUEANTES[status.state] || status.reason || 'Licencia no activa.';
      renderOverlay(msg);
      return;
    }

    var info = status.info || {};
    if (info.isPermanent) return; // permanente activa: sin banner
    var dias = info.daysRemaining;
    var umbral = UMBRAL_DEFAULT;

    if (info.isTrial) {
      var dTxt = dias != null ? '<span class="nlb-days">' + dias + '</span> día(s) restantes' : 'vigente';
      renderBanner('Versión de prueba — ' + dTxt + '. Activa la licencia completa con tu proveedor.', colorClass(dias, true));
      return;
    }
    if (dias != null && dias <= umbral) {
      renderBanner('Tu licencia vence en <span class="nlb-days">' + dias + '</span> día(s). Renueva para evitar interrupciones.', colorClass(dias, false));
    }
  }

  function check() {
    if (!window.nexusLicense || typeof window.nexusLicense.getStatus !== 'function') return;
    Promise.resolve(window.nexusLicense.getStatus()).then(apply).catch(function () {});
  }

  function autoMount() {
    // Solo en la ventana principal (NexusComponents lo define components/navbar.js).
    if (!window.NexusComponents) return;
    check();
    setInterval(check, 60 * 60 * 1000); // cada hora
    window.addEventListener('focus', check);
  }

  window.mountLicenseBanner = check;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMount);
  } else {
    autoMount();
  }
})();
