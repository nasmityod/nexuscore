'use strict';

/**
 * lib/ratelimit.js — Rate limiting con ventana deslizante usando Vercel KV
 *
 * ESTRATEGIA DE DEFENSA (tres capas independientes):
 *
 *  1. Por IP — máximo 6 intentos por ventana de 10 minutos.
 *     Frena fuerza bruta desde una misma IP.
 *     Clave KV: rl:ip:{ip}  TTL: 600s
 *
 *  2. Por IP diario — máximo 20 intentos por día.
 *     Frena intentos distribuidos o lentos desde una IP.
 *     Clave KV: rl:ipd:{ip}:{YYYY-MM-DD}  TTL: 86400s
 *
 *  3. Por código — máximo 4 intentos fallidos consecutivos.
 *     Frena ataques dirigidos a un código específico.
 *     Clave KV: rl:code:{code}  TTL: 3600s (se resetea si hay éxito)
 *
 * Se usan operaciones atómicas (INCR + EXPIRE) para evitar race conditions.
 * Todas las claves tienen TTL → se limpian solas, sin mantenimiento manual.
 */

const WINDOW_MINUTES    = 10;
const MAX_PER_WINDOW    = 6;
const MAX_PER_DAY       = 20;
const MAX_CODE_FAILURES = 4;

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function getIp(req) {
  // Vercel pone la IP real en x-forwarded-for
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Verifica los límites de tasa. Lanza un Error con .status = 429 si se excede.
 * Incrementa los contadores ANTES de procesar la solicitud (fail-open: se
 * descuenta el intento aunque después falle por otra razón).
 */
async function checkAndIncrement(kv, req, code) {
  const ip = getIp(req);

  // ── Capa 1: ventana de 10 minutos por IP ──────────────────────────────
  const ipKey   = `rl:ip:${ip}`;
  const ipCount = await kv.incr(ipKey);
  if (ipCount === 1) await kv.expire(ipKey, WINDOW_MINUTES * 60);

  if (ipCount > MAX_PER_WINDOW) {
    const ttl = await kv.ttl(ipKey);
    const err = new Error(
      `Demasiados intentos. Espera ${Math.ceil((ttl || 60) / 60)} minuto(s) antes de intentar de nuevo.`
    );
    err.status = 429;
    throw err;
  }

  // ── Capa 2: diario por IP ──────────────────────────────────────────────
  const ipdKey   = `rl:ipd:${ip}:${todayKey()}`;
  const ipdCount = await kv.incr(ipdKey);
  if (ipdCount === 1) await kv.expire(ipdKey, 86400);

  if (ipdCount > MAX_PER_DAY) {
    const err = new Error('Límite diario de intentos alcanzado. Intenta mañana.');
    err.status = 429;
    throw err;
  }

  // ── Capa 3: intentos fallidos por código ───────────────────────────────
  if (code) {
    const codeKey   = `rl:code:${String(code).toUpperCase()}`;
    const codeCount = await kv.get(codeKey);
    if (Number(codeCount) >= MAX_CODE_FAILURES) {
      const err = new Error(
        'Código bloqueado temporalmente por demasiados intentos fallidos. Espera 1 hora.'
      );
      err.status = 429;
      throw err;
    }
  }
}

/**
 * Registra un intento fallido para un código (incrementa su contador).
 */
async function recordCodeFailure(kv, code) {
  if (!code) return;
  const codeKey = `rl:code:${String(code).toUpperCase()}`;
  const count   = await kv.incr(codeKey);
  if (count === 1) await kv.expire(codeKey, 3600);
}

/**
 * Limpia el contador de fallos de un código tras activación exitosa.
 */
async function clearCodeFailures(kv, code) {
  if (!code) return;
  await kv.del(`rl:code:${String(code).toUpperCase()}`);
}

module.exports = { checkAndIncrement, recordCodeFailure, clearCodeFailures, getIp };
