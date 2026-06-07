#!/usr/bin/env node
'use strict';

/**
 * suspend-license.js — Suspende (pausa) una licencia. Reversible con --reactivar.
 *
 * Uso:
 *   NEXUS_ADMIN_API_KEY=... node scripts/suspend-license.js NXCS-XXXX-XXXX-XXXX-XXXX --reason "Pago pendiente"
 *   NEXUS_ADMIN_API_KEY=... node scripts/suspend-license.js NXCS-... --reactivar
 */

const { parseArgs, apiCall, die } = require('./_client');

(async () => {
  const a = parseArgs();
  const key = a._[0];
  if (!key) { console.error('Uso: suspend-license.js <LICENSE_KEY> [--reason "..."] [--reactivar]'); process.exit(2); }
  const status = a.reactivar ? 'active' : 'suspended';
  try {
    await apiCall('PUT', '/licenses/' + encodeURIComponent(key.toUpperCase()) + '/status',
      { status, reason: a.reason || '' }, a);
    console.log(`✓ Licencia ${status === 'active' ? 'reactivada' : 'suspendida'}: ${key.toUpperCase()}`);
  } catch (e) { die(e); }
})();
