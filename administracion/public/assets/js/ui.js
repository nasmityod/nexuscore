'use strict';

/**
 * ui.js — Utilidades de presentación: escape, formato de fechas/montos, badges,
 * toasts y gestión de modales. Sin dependencias externas.
 */

const UI = (() => {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('es-VE', { year: 'numeric', month: 'short', day: '2-digit' });
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('es-VE', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function relDays(n) {
    if (n == null) return '';
    if (n < 0) return `vencida hace ${Math.abs(n)} día(s)`;
    if (n === 0) return 'vence hoy';
    if (n === 1) return 'vence mañana';
    return `${n} día(s) restantes`;
  }

  const TYPE_LABEL = { subscription: 'Suscripción', permanent: 'Permanente', trial: 'Prueba' };
  const TYPE_CLASS = { subscription: 'neutral', permanent: 'purple', trial: 'blue' };
  const STATUS_LABEL = { active: 'Activa', suspended: 'Suspendida', revoked: 'Revocada' };

  function badge(cls, text) { return `<span class="badge ${cls}">${esc(text)}</span>`; }

  function typeBadge(type) {
    return badge(TYPE_CLASS[type] || 'neutral', TYPE_LABEL[type] || type || '—');
  }

  /** Estado efectivo: una licencia 'active' pero vencida se muestra "Vencida". */
  function statusBadge(lic) {
    if (lic.status === 'active' && lic.expired) return badge('red', 'Vencida');
    if (lic.status === 'active') {
      // resalta "por vencer" (<= 15 días) en amarillo
      if (lic.type !== 'permanent' && typeof lic.daysRemaining === 'number' && lic.daysRemaining <= 15 && lic.daysRemaining >= 0) {
        return badge('yellow', 'Por vencer');
      }
      return badge('green', 'Activa');
    }
    if (lic.status === 'suspended') return badge('yellow', 'Suspendida');
    if (lic.status === 'revoked') return badge('red', 'Revocada');
    return badge('neutral', lic.status || '—');
  }

  function expiryText(lic) {
    if (lic.type === 'permanent') return '∞ permanente';
    if (!lic.activatedAt) return 'al activar';
    return fmtDate(lic.expiresAt);
  }

  // ── Toast ──
  function toast(msg, kind = 'ok') {
    const root = document.getElementById('toastRoot');
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 200ms ease';
      setTimeout(() => el.remove(), 220);
    }, 3400);
  }

  // ── Modal ──
  function openModal(html) {
    const root = document.getElementById('modalRoot');
    root.innerHTML = `<div class="overlay" data-overlay>${html}</div>`;
    const overlay = root.querySelector('[data-overlay]');
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', escClose);
  }
  function escClose(e) { if (e.key === 'Escape') closeModal(); }
  function closeModal() {
    document.getElementById('modalRoot').innerHTML = '';
    document.removeEventListener('keydown', escClose);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copiado al portapapeles.');
    } catch (_e) {
      toast('No se pudo copiar.', 'err');
    }
  }

  function spinner(text) {
    return `<div class="loading"><div class="spinner"></div>${esc(text || 'Cargando…')}</div>`;
  }

  return {
    esc, fmtDate, fmtDateTime, relDays, badge, typeBadge, statusBadge, expiryText,
    toast, openModal, closeModal, copy, spinner,
    TYPE_LABEL, STATUS_LABEL
  };
})();
