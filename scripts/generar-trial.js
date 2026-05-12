#!/usr/bin/env node
'use strict';

/**
 * Genera un código NC-… de prueba vía API admin del servidor de licencias.
 * La duración al activar la define el servidor (variable NEXUS_TRIAL_HOURS, por defecto 24 h).
 *
 * Uso:
 *   node scripts/generar-trial.js "Nombre del cliente"
 *
 * Requiere en .env (raíz del repo):
 *   NEXUS_LICENSE_ADMIN_URL  → ej. https://tu-app.vercel.app
 *   NEXUS_ADMIN_API_KEY      → Bearer para POST /api/admin/codes/create
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const empresa = process.argv[2] || 'Cliente demo';

async function main() {
  const base = process.env.NEXUS_LICENSE_ADMIN_URL || process.env.NEXUS_LICENSE_SERVER_URL;
  const key = process.env.NEXUS_ADMIN_API_KEY;
  if (!base || !String(base).trim()) {
    console.error(
      'Falta la URL del servidor de licencias en .env (raíz del repo).\n' +
        'Añade una de estas líneas (sin barra final):\n' +
        '  NEXUS_LICENSE_ADMIN_URL=https://TU-PROYECTO.vercel.app\n' +
        '  o la misma URL que uses en la app:\n' +
        '  NEXUS_LICENSE_SERVER_URL=https://TU-PROYECTO.vercel.app\n' +
        '\n(Es la base pública de Vercel, la misma que configuraste para activar la app.)'
    );
    process.exit(1);
  }
  if (!key || !String(key).trim()) {
    console.error(
      'Falta NEXUS_ADMIN_API_KEY en .env.\n' +
        'Debe ser el mismo valor que definiste en Vercel como clave admin del license-server\n' +
        '(Authorization: Bearer … para /api/admin/codes/create).'
    );
    process.exit(1);
  }

  const url = String(base).replace(/\/$/, '') + '/api/admin/codes/create';
  const body = {
    empresa,
    edition: 'profesional',
    esTrial: true,
    cantidad: 1,
  };

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key.trim() },
    body: JSON.stringify(body),
  });

  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('Error API:', r.status, d);
    process.exit(1);
  }

  const code = d.codes && d.codes[0];
  console.log('');
  console.log(
    'Código de prueba (la duración en horas la define el servidor al activar; por defecto 24 h — NEXUS_TRIAL_HOURS en Vercel):'
  );
  console.log(code);
  console.log('');
  console.log('Empresa en KV:', d.empresa || empresa);
  console.log('esTrial:', d.esTrial !== undefined ? d.esTrial : true);
  if (d.tipoLicencia) console.log('tipoLicencia (KV):', d.tipoLicencia);
  console.log('');

  const wa =
    'Hola, tu código de prueba Nexus-Core es:\n' +
    code +
    '\n\n' +
    'Instala la app, ábrela e introduce el código en la pantalla de activación. ' +
    'La duración de la prueba la fija el servidor al activar (por defecto 24 horas desde ese momento en ese equipo).';
  console.log('--- Mensaje WhatsApp (copiar) ---');
  console.log(wa);
  console.log('');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
