'use strict';

/**
 * GET /api/admin/diagnostics/key-fingerprint
 */

const { createPrivateKey, createPublicKey, createHash } = require('crypto');
const { validateAdminAuth, sendError, sendOk } = require('../../validate');
const { createLogger } = require('../../logger');

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const log = createLogger(req, 'admin.diagnostics.key-fingerprint');

  log.step('incoming');

  if (req.method !== 'GET') {
    log.warn('method_not_allowed', { got: req.method });
    log.timing('request_total', t0, { outcome: '405' });
    return sendError(res, 405, 'Método no permitido.');
  }

  try {
    validateAdminAuth(req, 'admin.diagnostics.key-fingerprint');
    log.step('admin_auth_ok');
  } catch (e) {
    log.timing('request_total', t0, { outcome: String(e.status || 401) });
    return sendError(res, e.status || 401, e.message);
  }

  const raw = process.env.NEXUS_LICENSE_PRIVATE_KEY;
  if (!raw || !String(raw).trim()) {
    log.warn('missing_private_key_env');
    log.timing('request_total', t0, { outcome: '500' });
    return sendError(res, 500, 'NEXUS_LICENSE_PRIVATE_KEY no está definida en este deployment.');
  }

  const tDer = Date.now();
  try {
    const pem = String(raw).trim().replace(/\\n/g, '\n');
    const priv = createPrivateKey(pem);
    const pub = createPublicKey(priv);
    const der = pub.export({ type: 'spki', format: 'der' });
    const publicSpkiSha256 = createHash('sha256').update(der).digest('hex');

    log.timing('derive_public_spki', tDer, { derBytes: der.length });
    log.info('fingerprint_ok', {
      publicSpkiSha256Prefix: publicSpkiSha256.slice(0, 16),
      fullLenHex: publicSpkiSha256.length,
    });
    log.timing('request_total', t0, { outcome: '200' });

    return sendOk(res, {
      publicSpkiSha256,
      message:
        'Este hash debe coincidir con `node scripts/fingerprintLicenciaPublic.js` en tu repo.',
    });
  } catch (e) {
    log.error('pem_parse_fail', { err: e && e.message ? e.message : String(e) });
    log.timing('request_total', t0, { outcome: '500' });
    return sendError(res, 500, 'PEM inválida o ilegible en el servidor.');
  }
};
