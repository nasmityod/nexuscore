'use strict';

/**
 * lib/upstream.js — Cliente hacia el servidor de licencias (license-server en Vercel).
 *
 * DISEÑO:
 *   - Centraliza la URL base y la autenticación Bearer. La NEXUS_ADMIN_API_KEY se lee de
 *     process.env y se inyecta sólo en el servidor; jamás se devuelve al navegador.
 *   - Normaliza errores de red (502) y errores remotos (propaga status + mensaje del upstream).
 *   - Usa fetch global (Node >= 20 en Vercel).
 */

const DEFAULT_UPSTREAM = 'https://nexuscore-iota.vercel.app';

function upstreamBase() {
  return String(
    process.env.LICENSE_SERVER_URL ||
    process.env.NEXUS_LICENSE_SERVER_URL ||
    DEFAULT_UPSTREAM
  ).replace(/\/+$/, '');
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

/**
 * Llama a un endpoint del license-server con autenticación admin.
 * @param {string} method  GET | POST | PUT | DELETE
 * @param {string} path    p. ej. '/api/admin/licenses'
 * @param {object} [body]
 * @param {boolean} [auth=true]  añade Authorization Bearer (admin endpoints)
 * @returns {Promise<object>} JSON del upstream
 */
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
  try { json = await res.json(); } catch (_e) { /* respuesta sin cuerpo JSON */ }

  if (!res.ok) {
    const err = new Error((json && json.error) || ('El servidor de licencias respondió ' + res.status + '.'));
    err.status = res.status;
    throw err;
  }
  return json || {};
}

module.exports = { callUpstream, upstreamBase };
