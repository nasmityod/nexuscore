'use strict';

/**
 * api.js — Cliente HTTP del panel hacia su propio BFF (/api/*).
 *
 * La autenticación viaja en la cookie de sesión HttpOnly (credentials: 'same-origin'):
 * el navegador NUNCA maneja la clave admin del servidor de licencias. Si una llamada
 * devuelve 401, se emite el evento 'nx:unauthorized' para que la app vuelva al login.
 */

const Api = (() => {
  async function request(method, path, body) {
    let res;
    try {
      res = await fetch('/api' + path, {
        method,
        credentials: 'same-origin',
        headers: body != null ? { 'Content-Type': 'application/json' } : undefined,
        body: body != null ? JSON.stringify(body) : undefined
      });
    } catch (_e) {
      throw new Error('Sin conexión con el panel. Verifica tu red.');
    }

    let data = null;
    try { data = await res.json(); } catch (_e) { /* sin cuerpo */ }

    if (res.status === 401 && path !== '/auth/session' && path !== '/auth/login') {
      window.dispatchEvent(new CustomEvent('nx:unauthorized'));
    }
    if (!res.ok) {
      const msg = (data && data.error) || ('Error ' + res.status);
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data || {};
  }

  const qs = (params) => {
    const u = new URLSearchParams();
    Object.entries(params || {}).forEach(([k, v]) => { if (v) u.set(k, v); });
    const s = u.toString();
    return s ? '?' + s : '';
  };

  return {
    // ── Auth ──
    session: () => request('GET', '/auth/session'),
    login: (password) => request('POST', '/auth/login', { password }),
    logout: () => request('POST', '/auth/logout'),

    // ── Estado ──
    health: () => request('GET', '/health'),
    stats: () => request('GET', '/stats'),

    // ── Licencias ──
    listLicenses: (filters) => request('GET', '/licenses' + qs(filters)),
    getLicense: (key) => request('GET', '/licenses/' + encodeURIComponent(key)),
    createLicense: (payload) => request('POST', '/licenses/create', payload),
    createTrial: (payload) => request('POST', '/licenses/trial', payload),
    setStatus: (key, status, reason) =>
      request('PUT', '/licenses/' + encodeURIComponent(key) + '/status', { status, reason }),
    extend: (key, additionalDays) =>
      request('PUT', '/licenses/' + encodeURIComponent(key) + '/extend', { additionalDays }),
    revokeActivation: (key, hwid) =>
      request('DELETE', '/licenses/' + encodeURIComponent(key) + '/activations/' + encodeURIComponent(hwid))
  };
})();
