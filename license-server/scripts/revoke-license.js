#!/usr/bin/env node
'use strict';

/**
 * revoke-license.js — Revoca una licencia (rechazo inmediato en el próximo verify del cliente).
 *
 * Uso:
 *   NEXUS_ADMIN_API_KEY=... node scripts/revoke-license.js NXCS-XXXX-XXXX-XXXX-XXXX --reason "Reembolso"
 */

const { parseArgs, apiCall, die } = require('./_client');

(async () => {
  const a = parseArgs();
  const key = a._[0];
  if (!key) { console.error('Uso: revoke-license.js <LICENSE_KEY> [--reason "..."]'); process.exit(2); }
  try {
    await apiCall('PUT', '/licenses/' + encodeURIComponent(key.toUpperCase()) + '/status',
      { status: 'revoked', reason: a.reason || '' }, a);
    console.log('✓ Licencia revocada: ' + key.toUpperCase());
  } catch (e) { die(e); }
})();
