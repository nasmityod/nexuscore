'use strict';

/**
 * lib/panel/upstream.js — Proxy hacia los endpoints /api/admin/* del mismo license-server.
 *
 * Integrado en un solo despliegue: si LICENSE_SERVER_URL no está definida, usa VERCEL_URL
 * (mismo proyecto) o localhost en desarrollo. La NEXUS_ADMIN_API_KEY nunca sale al navegador.
 */

function upstreamBase() {
  const explicit = process.env.LICENSE_SERVER_URL || process.env.NEXUS_LICENSE_SERVER_URL;
  if (explicit) return String(explicit).replace(/\/+$/, '');

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
    const err = new Error((json && json.error) || ('El servidor de licencias respondió ' + res.status + '.'));
    err.status = res.status;
    throw err;
  }
  return json || {};
}

module.exports = { callUpstream, upstreamBase };
