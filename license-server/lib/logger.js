'use strict';

/**
 * Logs en una sola línea JSON → Vercel Runtime Logs los indexa y filtra bien.
 * No registrar secretos (Bearer completo, PEM, HMAC, tokens).
 */

const { randomBytes } = require('crypto');

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function uaSnippet(req) {
  const ua = req.headers['user-agent'];
  return ua ? String(ua).slice(0, 160) : null;
}

function pathOnly(req) {
  const u = req.url || '';
  const q = u.indexOf('?');
  return q >= 0 ? u.slice(0, q) : u;
}

function newRequestId() {
  return randomBytes(6).toString('hex');
}

function baseFields(req) {
  return {
    ts: new Date().toISOString(),
    service: 'nexus-license-server',
    ip: clientIp(req),
    ua: uaSnippet(req),
    path: pathOnly(req),
    method: req.method,
  };
}

function emit(level, payload) {
  const line = JSON.stringify({ level, ...payload });
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
}

/**
 * Logger por petición: mismo rid en todos los pasos del handler.
 */
function createLogger(req, scope) {
  const rid = newRequestId();
  const base = () => ({ ...baseFields(req), rid, scope });

  return {
    rid,
    info(msg, extra = {}) {
      emit('INFO', { ...base(), msg, ...extra });
    },
    warn(msg, extra = {}) {
      emit('WARN', { ...base(), msg, ...extra });
    },
    error(msg, extra = {}) {
      emit('ERROR', { ...base(), msg, ...extra });
    },
    /** Paso numerado para seguir el flujo en Vercel sin buscar en código */
    step(name, extra = {}) {
      emit('INFO', { ...base(), msg: 'step', step: name, ...extra });
    },
    /** Cierre con duración total o parcial */
    timing(label, startedAt, extra = {}) {
      emit('INFO', {
        ...base(),
        msg: 'timing',
        label,
        durationMs: Date.now() - startedAt,
        ...extra,
      });
    },
  };
}

function logAdminAuthRejected(req, scope, extra = {}) {
  const auth = String(req.headers.authorization || '');
  emit('WARN', {
    ...baseFields(req),
    rid: newRequestId(),
    scope,
    msg: 'admin_auth_rejected',
    hasBearer: /^Bearer\s+\S+/.test(auth),
    bearerLen: auth.startsWith('Bearer ') ? auth.slice(7).trim().length : 0,
    ...extra,
  });
}

function logServerMisconfig(scope, detail) {
  emit('ERROR', {
    ts: new Date().toISOString(),
    service: 'nexus-license-server',
    scope,
    rid: newRequestId(),
    msg: 'server_misconfigured',
    detail,
  });
}

/**
 * Rate limit (llamado desde ratelimit.js antes de lanzar 429).
 */
function logRateLimitHit(req, layer, detail = {}) {
  emit('WARN', {
    ...baseFields(req),
    rid: newRequestId(),
    scope: 'ratelimit',
    msg: 'rate_limit_hit',
    layer,
    ...detail,
  });
}

function maskCode(code) {
  const s = String(code || '').toUpperCase();
  if (s.length <= 12) return s ? `${s.slice(0, 4)}…` : '';
  return `${s.slice(0, 12)}…`;
}

module.exports = {
  createLogger,
  logAdminAuthRejected,
  logServerMisconfig,
  logRateLimitHit,
  clientIp,
  maskCode,
};
