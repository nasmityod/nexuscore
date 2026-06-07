'use strict';

/**
 * _client.js — Cliente HTTP compartido por los scripts CLI de administración.
 *
 * Autenticación: NEXUS_ADMIN_API_KEY (env) → header Authorization: Bearer.
 * URL base del servidor desplegado: NEXUS_LICENSE_ADMIN_URL o NEXUS_LICENSE_SERVER_URL
 * (o argumento --url). Por defecto el deploy de producción.
 *
 * Requiere Node >= 20 (fetch global). No depende de Redis ni de la clave privada: opera
 * sobre la API admin, igual que el panel web, de modo que un mismo binario sirve para
 * cualquier despliegue.
 */

const DEFAULT_URL = 'https://nexuscore-iota.vercel.app';

function baseUrl(args = {}) {
  return String(
    args.url ||
    process.env.NEXUS_LICENSE_ADMIN_URL ||
    process.env.NEXUS_LICENSE_SERVER_URL ||
    DEFAULT_URL
  ).replace(/\/+$/, '');
}

function adminKey() {
  const k = process.env.NEXUS_ADMIN_API_KEY;
  if (!k) {
    console.error('ERROR: define NEXUS_ADMIN_API_KEY en el entorno antes de ejecutar este script.');
    process.exit(2);
  }
  return k;
}

/**
 * Parser minimalista de argumentos: --flag valor, --bool, y posicionales.
 * @returns {{ _: string[], [k:string]: string|boolean }}
 */
function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function apiCall(method, path, body, args = {}) {
  const url = baseUrl(args) + path;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': 'Bearer ' + adminKey(),
      'Content-Type': 'application/json'
    },
    body: body != null ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (_e) {}
  if (!res.ok) {
    const msg = (json && json.error) || ('HTTP ' + res.status);
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

function die(err) {
  console.error('✗ ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
}

module.exports = { baseUrl, adminKey, parseArgs, apiCall, die, DEFAULT_URL };
