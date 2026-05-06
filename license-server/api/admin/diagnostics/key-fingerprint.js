'use strict';

/**
 * GET /api/admin/diagnostics/key-fingerprint
 * Solo admin (Bearer NEXUS_ADMIN_API_KEY).
 * Devuelve SHA-256 del SPKI de la clave pública derivada de NEXUS_LICENSE_PRIVATE_KEY
 * en el servidor. Úsalo para comprobar que Vercel cargó el mismo PEM que tu pareja local:
 *
 *   node scripts/fingerprintLicenciaPublic.js
 *
 * Los dos hashes deben coincidir. Si no, la variable en Vercel no es la privada correcta.
 */

const { createPrivateKey, createPublicKey, createHash } = require('crypto');
const { validateAdminAuth, sendError, sendOk } = require('../../../lib/validate');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return sendError(res, 405, 'Método no permitido.');

  try { validateAdminAuth(req); }
  catch (e) { return sendError(res, e.status || 401, e.message); }

  const raw = process.env.NEXUS_LICENSE_PRIVATE_KEY;
  if (!raw || !String(raw).trim()) {
    return sendError(res, 500, 'NEXUS_LICENSE_PRIVATE_KEY no está definida en este deployment.');
  }

  try {
    const pem = String(raw).trim().replace(/\\n/g, '\n');
    const priv = createPrivateKey(pem);
    const pub = createPublicKey(priv);
    const der = pub.export({ type: 'spki', format: 'der' });
    const publicSpkiSha256 = createHash('sha256').update(der).digest('hex');

    return sendOk(res, {
      publicSpkiSha256,
      message:
        'Este hash debe coincidir con `node scripts/fingerprintLicenciaPublic.js` en tu repo.',
    });
  } catch (e) {
    console.error('[key-fingerprint]', e.message);
    return sendError(res, 500, 'PEM inválida o ilegible en el servidor.');
  }
};
