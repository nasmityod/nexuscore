'use strict';

/**
 * POST /api/admin/codes/revoke
 */

const { kv }                                   = require('../../kv');
const { validateAdminAuth, sendError, sendOk } = require('../../validate');
const { getIp }                                = require('../../ratelimit');
const { createLogger, maskCode }               = require('../../logger');

const CODE_REGEX = /^NC-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/i;

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const log = createLogger(req, 'admin.codes.revoke');

  log.step('incoming');

  if (req.method !== 'POST') {
    log.warn('method_not_allowed', { got: req.method });
    log.timing('request_total', t0, { outcome: '405' });
    return sendError(res, 405, 'Método no permitido.');
  }

  try {
    validateAdminAuth(req, 'admin.codes.revoke');
    log.step('admin_auth_ok');
  } catch (e) {
    log.timing('request_total', t0, { outcome: String(e.status || 401) });
    return sendError(res, e.status || 401, e.message);
  }

  const body = req.body || {};
  const code = String(body.code || '').trim().toUpperCase();
  const motivo = String(body.motivo || 'Sin motivo especificado').slice(0, 200);

  if (!CODE_REGEX.test(code)) {
    log.warn('validation_fail', { field: 'code', codeProbe: maskCode(code) });
    log.timing('request_total', t0, { outcome: '400' });
    return sendError(res, 400, 'Formato de código inválido.');
  }

  log.step('params_ready', { codeMasked: maskCode(code), motivoLen: motivo.length });

  const kvKey = `code:${code}`;
  let entry;
  const tGet = Date.now();
  try {
    entry = await kv.get(kvKey);
    log.timing('kv_get', tGet, { found: !!entry });
  } catch (e) {
    log.error('kv_get_fail', { err: e && e.message ? e.message : String(e), codeMasked: maskCode(code) });
    log.timing('request_total', t0, { outcome: '503' });
    return sendError(res, 503, 'Error al acceder al almacenamiento.');
  }

  if (!entry) {
    log.warn('not_found', { codeMasked: maskCode(code) });
    log.timing('request_total', t0, { outcome: '404' });
    return sendError(res, 404, 'Código no encontrado.');
  }
  if (entry.revocado) {
    log.warn('already_revoked', { codeMasked: maskCode(code), empresa: entry.empresa });
    log.timing('request_total', t0, { outcome: '409' });
    return sendError(res, 409, 'El código ya estaba revocado.');
  }

  const updated = {
    ...entry,
    revocado: true,
    revocadoEn: new Date().toISOString(),
    revocadoPor: getIp(req),
    motivo,
  };

  const tCommit = Date.now();
  try {
    await kv.set(kvKey, updated);
    await kv.lpush('audit:revocations', JSON.stringify({
      code: code.slice(0, 5) + '…',
      empresa: entry.empresa,
      motivo,
      ip: getIp(req),
      ts: new Date().toISOString(),
    }));
    await kv.ltrim('audit:revocations', 0, 9999).catch(() => {});
    log.timing('kv_commit', tCommit, { codeMasked: maskCode(code) });
  } catch (kvErr) {
    log.error('kv_commit_fail', {
      err: kvErr && kvErr.message ? kvErr.message : String(kvErr),
      codeMasked: maskCode(code),
    });
    log.timing('request_total', t0, { outcome: '503' });
    return sendError(res, 503, 'No se pudo revocar el código. Intenta de nuevo.');
  }

  log.info('revoke_success', {
    codeMasked: maskCode(code),
    empresa: entry.empresa,
    motivoLen: motivo.length,
    adminIp: getIp(req),
  });
  log.timing('request_total', t0, { outcome: '200' });

  return sendOk(res, {
    code,
    empresa: entry.empresa,
    revocadoEn: updated.revocadoEn,
    message: `Código "${code}" revocado correctamente.`,
  });
};
