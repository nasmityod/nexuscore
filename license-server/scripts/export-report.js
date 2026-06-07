#!/usr/bin/env node
'use strict';

/**
 * export-report.js — Exporta todas las licencias a CSV.
 *
 * Uso:
 *   NEXUS_ADMIN_API_KEY=... node scripts/export-report.js [--out licencias.csv]
 *   (sin --out imprime el CSV por stdout, útil para pipes)
 */

const fs = require('fs');
const { parseArgs, apiCall, die } = require('./_client');

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

(async () => {
  const a = parseArgs();
  try {
    const r = await apiCall('GET', '/licenses', null, a);
    const header = ['key', 'type', 'status', 'customerName', 'customerEmail',
      'createdAt', 'activatedAt', 'expiresAt', 'daysRemaining',
      'activationCount', 'maxActivations', 'features', 'notes'];
    const lines = [header.join(',')];
    for (const l of r.licenses || []) {
      lines.push([
        l.key, l.type, (l.status === 'active' && l.expired ? 'expired' : l.status),
        l.customerName, l.customerEmail, l.createdAt, l.activatedAt, l.expiresAt,
        l.daysRemaining, l.activationCount, l.maxActivations,
        (l.features || []).join('|'), l.notes
      ].map(csvCell).join(','));
    }
    const csv = lines.join('\n') + '\n';
    if (a.out) {
      fs.writeFileSync(String(a.out), csv, 'utf8');
      console.error('✓ ' + (r.licenses || []).length + ' licencia(s) → ' + a.out);
    } else {
      process.stdout.write(csv);
    }
  } catch (e) { die(e); }
})();
