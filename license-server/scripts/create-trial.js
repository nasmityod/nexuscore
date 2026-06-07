#!/usr/bin/env node
'use strict';

/**
 * create-trial.js — Crea una licencia de prueba rápidamente.
 *
 * Uso:
 *   NEXUS_ADMIN_API_KEY=... node scripts/create-trial.js --name "Cliente Demo" --days 15 --max 1
 */

const { parseArgs, apiCall, die } = require('./_client');

(async () => {
  const a = parseArgs();
  try {
    const r = await apiCall('POST', '/licenses/trial', {
      customerName: a.name || a.customer || 'Prueba',
      trialDays: Number(a.days) || 15,
      maxActivations: Number(a.max) || 1
    }, a);
    const lic = r.license;
    console.log('✓ Prueba creada');
    console.log('  Key   : ' + lic.key);
    console.log('  Días  : ' + lic.durationDays);
    console.log('  Vence : al activar (' + lic.durationDays + ' días desde la activación)');
  } catch (e) { die(e); }
})();
