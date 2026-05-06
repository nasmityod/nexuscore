'use strict';

/**
 * ══════════════════════════════════════════════════════════════════
 *  NEXUS-CORE · Generador de par de claves Ed25519
 *  Ejecutar UNA SOLA VEZ:  node scripts/generarClaves.js
 * ══════════════════════════════════════════════════════════════════
 *
 *  - CLAVE PRIVADA → copia al archivo .env de tu servidor Vercel
 *                    como  NEXUS_LICENSE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
 *                    NUNCA subas esta clave a git ni la entregues al cliente.
 *
 *  - CLAVE PÚBLICA → pega el valor exacto en licenciaService.js
 *                    (constante PUBLIC_KEY_PEM). Solo con ella el cliente
 *                    puede VERIFICAR firmas, no puede crearlas.
 */

const { generateKeyPairSync } = require('crypto');

const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
});

const sep = '═'.repeat(64);

console.log('\n' + sep);
console.log('  CLAVE PRIVADA  —  Solo para tu servidor Vercel (.env)');
console.log(sep);
console.log(privateKey);

console.log(sep);
console.log('  CLAVE PÚBLICA  —  Pega en licenciaService.js (PUBLIC_KEY_PEM)');
console.log(sep);
console.log(publicKey);

console.log(sep);
console.log('  INSTRUCCIONES');
console.log(sep);
console.log('  1. Guarda la CLAVE PRIVADA en un lugar seguro (solo tuyo).');
console.log('  2. En Vercel, crea la variable de entorno:');
console.log('       NEXUS_LICENSE_PRIVATE_KEY = (el bloque PEM completo)');
console.log('  3. También crea en Vercel:');
console.log('       NEXUS_ADMIN_API_KEY = (un string largo y aleatorio, solo tuyo)');
console.log('  4. Copia la CLAVE PÚBLICA y pégala en');
console.log('       backend/services/licenciaService.js  →  PUBLIC_KEY_PEM');
console.log('  5. NUNCA ejecutes este script de nuevo; si lo pierdes deberás');
console.log('     re-emitir todas las licencias existentes.');
console.log(sep + '\n');
