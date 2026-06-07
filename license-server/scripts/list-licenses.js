#!/usr/bin/env node
'use strict';

/**
 * list-licenses.js — Lista todas las licencias con su estado actual.
 *
 * Uso:
 *   NEXUS_ADMIN_API_KEY=... node scripts/list-licenses.js [--status active] [--type trial] [--q texto]
 */

const { parseArgs, apiCall, die } = require('./_client');

function pad(s, n) { s = String(s == null ? '' : s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }

(async () => {
  const a = parseArgs();
  const qs = [];
  if (a.status) qs.push('status=' + encodeURIComponent(a.status));
  if (a.type) qs.push('type=' + encodeURIComponent(a.type));
  if (a.q) qs.push('q=' + encodeURIComponent(a.q));
  const path = '/licenses' + (qs.length ? '?' + qs.join('&') : '');

  try {
    const r = await apiCall('GET', path, null, a);
    const s = r.stats || {};
    console.log(`Total ${s.total || 0} · activas ${s.active || 0} · vencidas ${s.expired || 0} · suspendidas ${s.suspended || 0} · revocadas ${s.revoked || 0} · pruebas ${s.trials || 0}`);
    console.log('─'.repeat(96));
    console.log(pad('LICENSE KEY', 26) + pad('CLIENTE', 24) + pad('TIPO', 14) + pad('ESTADO', 12) + pad('VENCE', 13) + 'ACT');
    console.log('─'.repeat(96));
    for (const l of r.licenses || []) {
      const estado = l.status === 'active' && l.expired ? 'vencida' : l.status;
      const vence = l.type === 'permanent' ? '∞' : (l.expiresAt ? String(l.expiresAt).slice(0, 10) : '—');
      console.log(
        pad(l.key, 26) + pad(l.customerName || '—', 24) + pad(l.type, 14) +
        pad(estado, 12) + pad(vence, 13) + `${l.activationCount || 0}/${l.maxActivations || 1}`
      );
    }
    if (!r.licenses || !r.licenses.length) console.log('(sin resultados)');
  } catch (e) { die(e); }
})();
