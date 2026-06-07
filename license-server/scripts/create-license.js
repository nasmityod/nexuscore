#!/usr/bin/env node
'use strict';

/**
 * create-license.js — Crea una licencia desde la terminal.
 *
 * Uso:
 *   NEXUS_ADMIN_API_KEY=... node scripts/create-license.js \
 *     --type subscription --name "Bodega La Esquina" --email cliente@correo.com \
 *     --days 365 --max 2 --features "pos,reportes" --notes "Pago anual"
 *
 *   --type      subscription | permanent | trial   (default: subscription)
 *   --days      duración en días (suscripción/prueba). Permanente lo ignora.
 *   --max       máximo de activaciones (default 1)
 *   --features  lista separada por comas (opcional)
 *   --url       URL del servidor (opcional; default env o producción)
 */

const { parseArgs, apiCall, die } = require('./_client');

(async () => {
  const a = parseArgs();
  const type = String(a.type || 'subscription');
  const payload = {
    type,
    customerName: a.name || a.customer || '',
    customerEmail: a.email || '',
    maxActivations: Number(a.max) || 1,
    features: a.features ? String(a.features).split(',').map(s => s.trim()).filter(Boolean) : [],
    notes: a.notes || ''
  };
  const days = a.days != null ? Number(a.days) : null;
  if (type === 'trial') payload.trialDays = days || 15;
  else if (type === 'subscription') payload.durationDays = days || 365;

  try {
    const r = await apiCall('POST', '/licenses/create', payload, a);
    const lic = r.license;
    console.log('✓ Licencia creada');
    console.log('  Key      : ' + lic.key);
    console.log('  Tipo     : ' + lic.type);
    console.log('  Cliente  : ' + (lic.customerName || '—'));
    console.log('  Vence    : ' + (lic.type === 'permanent' ? 'permanente' : (lic.expiresAt || 'al activar (' + lic.durationDays + ' días)')));
    console.log('  Máx activ: ' + lic.maxActivations);
  } catch (e) { die(e); }
})();
