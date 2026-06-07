'use strict';

/**
 * Cliente API para Cuentas por Pagar.
 * Todas las llamadas pasan por NexusAuth.authFetch (token incluido).
 */
window.CuentasPagarClient = (function () {
  function apiBase() {
    return String(window.NEXUS_API_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
  }

  function BASE() {
    return apiBase() + '/api/cuentas-pagar';
  }

  async function _fetch(url, opts = {}) {
    return window.NexusAuth.authFetch(url, opts);
  }

  async function resumen() {
    const r = await _fetch(`${BASE()}/resumen`);
    if (!r.ok) throw new Error('Error al cargar resumen CxP');
    return r.json();
  }

  async function listar({ estado, proveedor_id, page = 1, limit = 50 } = {}) {
    const p = new URLSearchParams({ page, limit });
    if (estado) p.set('estado', estado);
    if (proveedor_id) p.set('proveedor_id', proveedor_id);
    const r = await _fetch(`${BASE()}?${p}`);
    if (!r.ok) throw new Error('Error al listar cuentas por pagar');
    return r.json();
  }

  async function crear(payload) {
    const r = await _fetch(BASE(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al crear cuenta por pagar');
    return data;
  }

  async function pagar(cuentaId, payload) {
    const r = await _fetch(`${BASE()}/${cuentaId}/pagar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al registrar pago');
    return data;
  }

  async function historialPagos(cuentaId) {
    const r = await _fetch(`${BASE()}/${cuentaId}/pagos`);
    if (!r.ok) throw new Error('Error al cargar historial de pagos');
    return r.json();
  }

  async function anular(cuentaId, motivo) {
    const r = await _fetch(`${BASE()}/${cuentaId}/anular`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ motivo })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al anular cuenta');
    return data;
  }

  return { resumen, listar, crear, pagar, historialPagos, anular };
})();
