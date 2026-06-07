'use strict';

/**
 * lib/panel/upstream.js — Proxy hacia /api/admin/* del mismo license-server.
 *
 * Mismo despliegue: preferir dominio de producción estable (VERCEL_PROJECT_PRODUCTION_URL
 * o LICENSE_SERVER_URL). VERCEL_URL apunta al hostname único del deploy y suele tener
 * Deployment Protection → 401 en llamadas server-to-server.
 */

function upstreamBase() {
  const explicit = process.env.LICENSE_SERVER_URL || process.env.NEXUS_LICENSE_SERVER_URL;
  if (explicit) return String(explicit).replace(/\/+$/, '');

  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (production) {
    return 'https://' + String(production).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }

  if (process.env.VERCEL_URL) {
    return 'https://' + String(process.env.VERCEL_URL).replace(/\/+$/, '');
  }

  return 'http://localhost:3000';
}

function adminKey() {
  const k = process.env.NEXUS_ADMIN_API_KEY;
  if (!k) {
    const e = new Error('Servidor mal configurado.');
    e.status = 500;
    e.misconfig = 'NEXUS_ADMIN_API_KEY';
    throw e;
  }
  return k;
}

async function callUpstream(method, path, body, auth = true) {
  const url = upstreamBase() + path;
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = 'Bearer ' + adminKey();

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined
    });
  } catch (_e) {
    const err = new Error('No se pudo conectar con el servidor de licencias.');
    err.status = 502;
    throw err;
  }

  let json = null;
  try { json = await res.json(); } catch (_e) {}

  if (!res.ok) {
    const upstreamMsg = (json && json.error) || ('El servidor de licencias respondió ' + res.status + '.');
    const err = new Error(upstreamMsg);
    // 401 del upstream (admin o Deployment Protection) no es sesión del panel.
    err.status = res.status === 401 || res.status === 403 ? 502 : res.status;
    err.upstreamStatus = res.status;
    throw err;
  }
  return json || {};
}

module.exports = { callUpstream, upstreamBase };
