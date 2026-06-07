#!/usr/bin/env node
'use strict';

/**
 * extend-license.js — Extiende la fecha de vencimiento de una licencia.
 *
 * Uso:
 *   NEXUS_ADMIN_API_KEY=... node scripts/extend-license.js NXCS-XXXX-XXXX-XXXX-XXXX --days 30
 */

const { parseArgs, apiCall, die } = require('./_client');

(async () => {
  const a = parseArgs();
  const key = a._[0];
  const days = Number(a.days);
  if (!key || !Number.isFinite(days) || days <= 0) {
    console.error('Uso: extend-license.js <LICENSE_KEY> --days <N>');
    process.exit(2);
  }
  try {
    const r = await apiCall('PUT', '/licenses/' + encodeURIComponent(key.toUpperCase()) + '/extend',
      { additionalDays: Math.floor(days) }, a);
    console.log('✓ Licencia extendida ' + Math.floor(days) + ' día(s).');
    console.log('  Nuevo vencimiento: ' + (r.license.expiresAt || 'al activar (' + r.license.durationDays + ' días)'));
  } catch (e) { die(e); }
})();
