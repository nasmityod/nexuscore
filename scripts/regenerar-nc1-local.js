'use strict';
/**
 * Emite un token NC1 firmado con NEXUS_LICENSE_PRIVATE_KEY (no va en el repo;
 * misma variable que en Vercel) y lo persiste vía licenciaService (PostgreSQL).
 *
 * Uso:
 *   set NEXUS_LICENSE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
 *   node scripts/regenerar-nc1-local.js [HWID_OPCIONAL]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { db } = require('../backend/config/database');
const licenciaService = require('../backend/services/licenciaService');
const { hashHwid, firmarToken } = require('../license-server/lib/crypto');

const HWID_DEFAULT = '3143695F70647DE3F2E02BA5';

async function main() {
  const pem = process.env.NEXUS_LICENSE_PRIVATE_KEY;
  if (!pem || !String(pem).trim()) {
    console.error(
      'Falta NEXUS_LICENSE_PRIVATE_KEY en el entorno (.env). Es la pareja de la clave pública del backend.'
    );
    process.exit(1);
  }

  const HWID = String(process.argv[2] || HWID_DEFAULT).trim().toUpperCase();
  const row = await db.oneOrNone(`SELECT valor FROM configuracion WHERE clave = 'licencia_empresa'`);
  const empresa = row?.valor || 'NexusCore';

  const hwidHash = hashHwid(HWID);
  const token = firmarToken({
    hwidHash,
    empresa,
    edition: 'profesional',
    expiraEn: null
  });

  const info = await licenciaService.activarLicencia(db, token, HWID);
  console.log(JSON.stringify({ ok: true, hwid: HWID, empresa: info.empresa || empresa, edition: info.edition }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
