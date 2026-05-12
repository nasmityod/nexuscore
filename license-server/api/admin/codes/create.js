'use strict';

/**
 * POST /api/admin/codes/create
 * Endpoint privado — solo para el distribuidor.
 * Requiere header: Authorization: Bearer {NEXUS_ADMIN_API_KEY}
 *
 * Body JSON:
 *   empresa      string  (obligatorio)  Nombre del cliente/empresa
 *   edition      string  (opcional)     "basico" | "profesional" | "enterprise"
 *   expiraEn     string  (opcional)     ISO 8601, fecha de expiración de la LICENCIA
 *   expiraCodigo string  (opcional)     ISO 8601, fecha límite para CANJEAR el código
 *   esTrial      boolean (opcional)     Si true: período de prueba desde activación (horas = NEXUS_TRIAL_HOURS en Vercel, default 24; ignora expiraEn del KV al firmar)
 *   cantidad     number  (opcional)     Cuántos códigos generar en lote (max 50)
 *
 * Retorna:
 *   { ok: true, codes: ["NC-XXXXX-XXXXX-XXXXX", ...] }
 */

const { kv }                                   = require('../../../lib/kv');
const { generarCodigo, computeCodeHmac }       = require('../../../lib/crypto');
const { validateAdminAuth, sendError, sendOk } = require('../../../lib/validate');
const { createLogger }                         = require('../../../lib/logger');

const EDITIONS_VALIDAS = ['basico', 'profesional', 'enterprise'];

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const log = createLogger(req, 'admin.codes.create');

  log.step('incoming');

  if (req.method !== 'POST') {
    log.warn('method_not_allowed', { got: req.method });
    log.timing('request_total', t0, { outcome: '405' });
    return sendError(res, 405, 'Método no permitido.');
  }

  try {
    validateAdminAuth(req, 'admin.codes.create');
    log.step('admin_auth_ok');
  }
  catch (e) {
    log.timing('request_total', t0, { outcome: String(e.status || 401) });
    return sendError(res, e.status || 401, e.message);
  }

  // ── Validación del body ────────────────────────────────────────────────
  const body = req.body || {};

  const empresa = String(body.empresa || '').trim().slice(0, 100);
  if (!empresa) {
    log.warn('validation_fail', { field: 'empresa' });
    log.timing('request_total', t0, { outcome: '400' });
    return sendError(res, 400, 'El campo "empresa" es obligatorio.');
  }

  const edition = EDITIONS_VALIDAS.includes(body.edition) ? body.edition : 'profesional';

  let expiraEn;
  let expiraCodigo;
  try {
    expiraEn = body.expiraEn ? validarFechaIso(body.expiraEn) : null;
    expiraCodigo = body.expiraCodigo ? validarFechaIso(body.expiraCodigo) : null;
  } catch (fe) {
    log.warn('validation_fail', { field: 'date', reason: fe.message });
    log.timing('request_total', t0, { outcome: '400' });
    return sendError(res, fe.status || 400, fe.message);
  }

  const cantidad = Math.min(Math.max(parseInt(body.cantidad) || 1, 1), 50);

  const esTrial = body.esTrial === true || body.esTrial === 'true';

  log.step('params_ready', {
    empresaLen: empresa.length,
    edition,
    cantidad,
    hasExpiraEn: !!expiraEn,
    hasExpiraCodigo: !!expiraCodigo,
    esTrial,
  });

  // ── Generación de códigos ──────────────────────────────────────────────
  const codesGenerados = [];
  const pipeline = [];

  for (let i = 0; i < cantidad; i++) {
    const code = generarCodigo();
    const hmac = computeCodeHmac(code);

    const entry = {
      empresa,
      edition,
      expiraEn:          expiraEn || null,
      expiraCodigo:      expiraCodigo || null,
      esTrial,
      /** Redundante: algunos almacenes/clones serializan mal booleanos; activate también lee esto. */
      tipoLicencia:      esTrial ? 'trial' : 'full',
      hmac,                         // firma del código — verifica integridad en KV
      activatedHwidHash: null,
      activatedAt:       null,
      activatedIp:       null,
      revocado:          false,
      creadoEn:          new Date().toISOString(),
    };

    // TTL en KV: si tiene fecha de expiración de canje, expira automáticamente
    const ttlOpts = expiraCodigo
      ? { ex: Math.max(1, Math.floor((new Date(expiraCodigo) - Date.now()) / 1000)) }
      : {};

    pipeline.push(kv.set(`code:${code}`, entry, ttlOpts));
    codesGenerados.push(code);
  }

  const tKv = Date.now();
  try {
    await Promise.all(pipeline);
    log.timing('kv_set_batch', tKv, { keysWritten: cantidad });
  } catch (kvErr) {
    log.error('kv_set_batch_fail', {
      err: kvErr && kvErr.message ? kvErr.message : String(kvErr),
      cantidad,
    });
    log.timing('request_total', t0, { outcome: '503' });
    return sendError(res, 503, 'No se pudieron guardar los códigos. Intenta de nuevo.');
  }

  // Log de auditoría
  await kv.lpush('audit:created', JSON.stringify({
    empresa, edition, cantidad,
    codes: codesGenerados.map(c => c.slice(0, 5) + '…'),
    ts:    new Date().toISOString(),
  })).catch((err) => {
    log.warn('audit_push_failed', { err: err && err.message ? err.message : String(err) });
  });
  await kv.ltrim('audit:created', 0, 9999).catch(() => {});

  log.info('codes_created', {
    empresa,
    edition,
    cantidad,
    codePrefixes: codesGenerados.map((c) => c.slice(0, 8)),
  });
  log.timing('request_total', t0, { outcome: '200' });

  return sendOk(res, {
    codes: codesGenerados,
    empresa,
    edition,
    expiraEn:      expiraEn     || null,
    expiraCodigo:  expiraCodigo || null,
    esTrial,
    tipoLicencia:  esTrial ? 'trial' : 'full',
    message:       `${cantidad} código(s) generado(s) para "${empresa}".`,
  });
};

function validarFechaIso(val) {
  const d = new Date(val);
  if (isNaN(d.getTime())) throw Object.assign(new Error(`Fecha inválida: "${val}"`), { status: 400 });
  if (d < new Date()) throw Object.assign(new Error(`La fecha "${val}" ya pasó.`), { status: 400 });
  return d.toISOString();
}
