'use strict';

/**
 * Imprime SHA-256 (hex) del SPKI de la clave pública embebida en licenciaService.js
 * (o la env NEXUS_LICENSE_PUBLIC_KEY si está definida al ejecutar este script).
 *
 * Comparación:
 *   curl -s -H "Authorization: Bearer TU_ADMIN_KEY" \
 *     https://TU-PROYECTO.vercel.app/api/admin/diagnostics/key-fingerprint \
 *     | jq .publicSpkiSha256
 *
 * El valor debe ser IDÉNTICO al que imprime este script.
 */

const crypto = require('crypto');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const DEFAULT_PUB = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEALRroxTO1ghmGygJM0WMWY9zWk2XvQDdcZDBqbcb5qrM=
-----END PUBLIC KEY-----`;

function effectivePub() {
  const raw = process.env.NEXUS_LICENSE_PUBLIC_KEY;
  if (raw && String(raw).trim()) {
    return String(raw).trim().replace(/\\n/g, '\n');
  }
  return DEFAULT_PUB;
}

const pem = effectivePub();
const pub = crypto.createPublicKey(pem);
const der = pub.export({ type: 'spki', format: 'der' });
const fp = crypto.createHash('sha256').update(der).digest('hex');

console.log('');
console.log('Huella SPKI (SHA-256 hex) de la clave PÚBLICA local esperada:');
console.log(fp);
console.log('');
console.log('Si difiere de la que devuelve /api/admin/diagnostics/key-fingerprint en Vercel,');
console.log('entonces NEXUS_LICENSE_PRIVATE_KEY en Vercel NO es la pareja de esta pública.');
console.log('');
