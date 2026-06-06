'use strict';

/**
 * POST /api/license/generate
 *
 * Endpoint PRIVADO — solo lo llamas TÚ desde Postman, curl o tu panel.
 * Firma un payload Ed25519 con la clave privada que vive en Vercel.
 *
 * Autenticación: header  Authorization: Bearer <NEXUS_ADMIN_API_KEY>
 */

const { createPrivateKey, sign } = require('crypto');

const { validateAdminAuth, sendError, sendOk } = require('../../lib/validate');
const { createLogger, logServerMisconfig } = require('../../lib/logger');
const { hashHwid } = require('../../lib/crypto');

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const log = createLogger(req, 'license.generate');

  log.step('incoming');

  if (req.method !== 'POST') {
    log.warn('method_not_allowed', { got: req.method });
    log.timing('request_total', t0, { outcome: '405' });
    return sendError(res, 405, 'Método no permitido.');
  }

  try {
    validateAdminAuth(req, 'license.generate');
    log.step('admin_auth_ok');
  } catch (e) {
    log.timing('request_total', t0, { outcome: String(e.status || 401) });
    return sendError(res, e.status || 401, e.message);
  }

  const privatePem = process.env.NEXUS_LICENSE_PRIVATE_KEY;
  if (!privatePem || !String(privatePem).trim()) {
    logServerMisconfig('license.generate', 'missing_NEXUS_LICENSE_PRIVATE_KEY');
    log.timing('request_total', t0, { outcome: '500' });
    return sendError(res, 500, 'Servidor mal configurado.');
  }

  const { hwid, empresa, edition, expiraEn } = req.body || {};

  if (!hwid || !String(hwid).trim()) {
    log.warn('validation_fail', { field: 'hwid' });
    log.timing('request_total', t0, { outcome: '400' });
    return sendError(res, 400, 'El campo "hwid" es obligatorio.');
  }
  if (!empresa || !String(empresa).trim()) {
    log.warn('validation_fail', { field: 'empresa' });
    log.timing('request_total', t0, { outcome: '400' });
    return sendError(res, 400, 'El campo "empresa" es obligatorio.');
  }

  if (expiraEn) {
    const d = new Date(expiraEn);
    if (Number.isNaN(d.getTime())) {
      log.warn('validation_fail', { field: 'expiraEn', reason: 'invalid_date' });
      log.timing('request_total', t0, { outcome: '400' });
      return sendError(res, 400, 'expiraEn debe ser YYYY-MM-DD o null.');
    }
    if (d < new Date()) {
      log.warn('validation_fail', { field: 'expiraEn', reason: 'past' });
      log.timing('request_total', t0, { outcome: '400' });
      return sendError(res, 400, 'La fecha de expiración ya pasó.');
    }
  }

  const hwidTrim = hwid.trim();
  const empresaTrim = empresa.trim();
  const editionVal = edition || 'profesional';

  log.step('params_ready', {
    hwidLen: hwidTrim.length,
    empresaLen: empresaTrim.length,
    edition: editionVal,
    expiraMode: expiraEn ? 'dated' : 'perpetual',
  });

  const tSign = Date.now();
  try {
    const payload = {
      h: hashHwid(hwidTrim),
      e: empresaTrim,
      ed: editionVal,
      ex: expiraEn || null,
      iat: Math.floor(Date.now() / 1000),
    };

    const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)));

    const privKey = createPrivateKey(privatePem.replace(/\\n/g, '\n'));
    const signature = sign(null, Buffer.from(payloadB64), privKey);
    const sigB64 = b64url(signature);

    const licenseKey = `NC1.${payloadB64}.${sigB64}`;

    log.timing('sign_license', tSign, {
      payloadChars: payloadB64.length,
      sigChars: sigB64.length,
      licenseKeyChars: licenseKey.length,
    });

    log.info('license_generated', {
      empresa: payload.e,
      edition: payload.ed,
      expira: payload.ex || 'perpetua',
      hwidProbe: `${hwidTrim.slice(0, 8)}…`,
      iat: payload.iat,
    });
    log.timing('request_total', t0, { outcome: '200' });

    return sendOk(res, {
      licenseKey,
      info: {
        empresa: payload.e,
        edition: payload.ed,
        expira: payload.ex || 'Perpetua',
        emitida: new Date(payload.iat * 1000).toISOString(),
      },
    });
  } catch (err) {
    log.error('sign_failed', {
      err: err && err.message ? err.message : String(err),
    });
    log.timing('request_total', t0, { outcome: '500' });
    return sendError(res, 500, 'Error interno al generar la licencia.');
  }
};
