'use strict';
/**
 * Emite un token NC1 firmado con NEXUS_LICENSE_PRIVATE_KEY (no va en el repo;
 * misma variable que en Vercel) y lo persiste vía licenciaService (PostgreSQL).
 *
 * Uso:
 *   set NEXUS_LICENSE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
 *   node scripts/regenerar-nc1-local.js [HWID_OPCIONAL]
 *   node scripts/regenerar-nc1-local.js [HWID] <minutos>   — licencia temporal (ej. 1 = expira en 1 min)
 *   node scripts/regenerar-nc1-local.js <minutos>          — HWID por defecto + caducidad en N minutos
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { db } = require('../backend/config/database');
const licenciaService = require('../backend/services/licenciaService');
const { hashHwid, firmarToken } = require('../license-server/lib/crypto');

const HWID_DEFAULT = '3143695F70647DE3F2E02BA5';

function parseArgs() {
  const args = process.argv.slice(2);
  let hwid = HWID_DEFAULT;
  let expireMin = null;

  if (args.length === 1 && /^\d+(\.\d+)?$/.test(args[0])) {
    expireMin = Number(args[0]);
  } else if (args.length >= 2 && /^\d+(\.\d+)?$/.test(args[1])) {
    hwid = String(args[0]).trim().toUpperCase();
    expireMin = Number(args[1]);
  } else if (args.length >= 1) {
    hwid = String(args[0]).trim().toUpperCase();
  }

  return { hwid, expireMin };
}

async function main() {
  const pem = process.env.NEXUS_LICENSE_PRIVATE_KEY;
  if (!pem || !String(pem).trim()) {
    console.error(
      'Falta NEXUS_LICENSE_PRIVATE_KEY en el entorno (.env). Es la pareja de la clave pública del backend.'
    );
    process.exit(1);
  }

  const { hwid: HWID, expireMin } = parseArgs();
  const row = await db.oneOrNone(`SELECT valor FROM configuracion WHERE clave = 'licencia_empresa'`);
  const empresa = row?.valor || 'NexusCore';

  const expiraEn =
    expireMin != null && expireMin > 0
      ? new Date(Date.now() + expireMin * 60 * 1000).toISOString()
      : null;

  const hwidHash = hashHwid(HWID);
  const token = firmarToken({
    hwidHash,
    empresa,
    edition: 'profesional',
    expiraEn,
    esTrial: false,
  });

  const info = await licenciaService.activarLicencia(db, token, HWID);
  console.log(
    JSON.stringify(
      {
        ok: true,
        hwid: HWID,
        empresa: info.empresa || empresa,
        edition: info.edition,
        expira: info.expira,
        expiraEnIso: expiraEn,
        caducaEnMinutos: expireMin,
      },
      null,
      2
    )
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
