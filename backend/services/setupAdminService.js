'use strict';

const bcrypt = require('bcryptjs');

const { logger } = require('../config/logger');
const { registrarAuditoria } = require('../middleware/audit.middleware');
const ModoMonedaService = require('./modoMonedaService');

/** Debe coincidir con 004_seed_data.sql y migrations.js ADMIN_DEFAULT_PASSWORD_HASH */
const ADMIN_DEFAULT_PASSWORD_HASH =
  '$2a$10$YD93UDKrCaoufVSzuUh9/.RKBAYW3sTJObiKsplXK5O8gH2N/nN7a';

const CONFIG_SETUP_ADMIN = 'setup_admin_completado';

const USERNAME_RE = /^[a-z][a-z0-9_]{2,31}$/;

/**
 * @param {import('pg-promise').IDatabase} db
 * @returns {Promise<boolean>}
 */
async function isSetupAdminCompletado(db) {
  const row = await db.oneOrNone(
    `SELECT valor FROM configuracion WHERE clave = $1 LIMIT 1`,
    [CONFIG_SETUP_ADMIN]
  );
  return !!(row && String(row.valor).trim().toLowerCase() === 'true');
}

/**
 * @param {import('pg-promise').IDatabase} db
 * @returns {Promise<{ adminPendiente: boolean }>}
 */
async function obtenerEstadoSetupAdmin(db) {
  const completado = await isSetupAdminCompletado(db);
  return { adminPendiente: !completado };
}

/**
 * @param {unknown} body
 */
function validarPayloadAdminInicial(body) {
  const nombreCompleto = body && body.nombre_completo != null
    ? String(body.nombre_completo).trim()
    : '';
  const usernameRaw = body && body.username != null ? String(body.username).trim().toLowerCase() : '';
  const password = body && body.password != null ? String(body.password) : '';
  const passwordConfirm = body && body.password_confirm != null
    ? String(body.password_confirm)
    : (body && body.passwordConfirm != null ? String(body.passwordConfirm) : '');

  if (!nombreCompleto || nombreCompleto.length < 2) {
    throw new Error('El nombre completo es obligatorio (mínimo 2 caracteres).');
  }
  if (!usernameRaw || !USERNAME_RE.test(usernameRaw)) {
    throw new Error(
      'El usuario debe tener 3–32 caracteres: letras minúsculas, números o _ (debe empezar con letra).'
    );
  }
  if (!password || password.length < 8) {
    throw new Error('La contraseña debe tener al menos 8 caracteres.');
  }
  if (password !== passwordConfirm) {
    throw new Error('Las contraseñas no coinciden.');
  }

  return { nombreCompleto, username: usernameRaw, password };
}

/**
 * Personaliza la cuenta administrador semilla (admin/admin123) en la primera instalación.
 * @param {import('pg-promise').IDatabase} db
 * @param {{ nombreCompleto: string, username: string, password: string }} payload
 * @param {string|null} ipAddress
 */
async function crearAdminInicial(db, payload, ipAddress = null) {
  if (await isSetupAdminCompletado(db)) {
    const err = new Error('La cuenta de administrador ya fue configurada.');
    err.status = 409;
    throw err;
  }

  const { nombreCompleto, username, password } = payload;

  return db.tx(async (t) => {
    const completadoTx = await t.oneOrNone(
      `SELECT valor FROM configuracion WHERE clave = $1 LIMIT 1`,
      [CONFIG_SETUP_ADMIN]
    );
    if (completadoTx && String(completadoTx.valor).trim().toLowerCase() === 'true') {
      const err = new Error('La cuenta de administrador ya fue configurada.');
      err.status = 409;
      throw err;
    }

    const rolAdmin = await t.oneOrNone(`SELECT id FROM roles WHERE LOWER(TRIM(nombre)) = 'admin' LIMIT 1`);
    if (!rolAdmin) {
      throw new Error('setupAdminService.crearAdminInicial: rol admin no encontrado en la base de datos.');
    }

    const semillaAdmin = await t.oneOrNone(
      `SELECT id, username, password_hash, nombre_completo, rol_id
       FROM usuarios
       WHERE LOWER(TRIM(username)) = 'admin'
       LIMIT 1
       FOR UPDATE`
    );

    if (!semillaAdmin) {
      throw new Error(
        'setupAdminService.crearAdminInicial: no existe el usuario semilla admin; reinicia la aplicación e intenta de nuevo.'
      );
    }

    if (semillaAdmin.password_hash !== ADMIN_DEFAULT_PASSWORD_HASH) {
      await t.none(
        `INSERT INTO configuracion (clave, valor, categoria, descripcion)
         VALUES ($1, 'true', 'sistema', $2)
         ON CONFLICT (clave) DO UPDATE SET valor = 'true', actualizado_en = NOW()`,
        [CONFIG_SETUP_ADMIN, 'Administrador ya personalizado (detectado al crear admin inicial)']
      );
      const err = new Error('La cuenta de administrador ya fue configurada.');
      err.status = 409;
      throw err;
    }

    const otroUsuario = await t.oneOrNone(
      `SELECT id FROM usuarios WHERE LOWER(TRIM(username)) = $1 AND id <> $2 LIMIT 1`,
      [username, semillaAdmin.id]
    );
    if (otroUsuario) {
      const err = new Error(`El usuario «${username}» ya existe. Elige otro nombre.`);
      err.status = 409;
      throw err;
    }

    const hash = await bcrypt.hash(password, 10);

    const actualizado = await t.one(
      `UPDATE usuarios
       SET username = $1,
           password_hash = $2,
           nombre_completo = $3,
           rol_id = $4,
           activo = TRUE
       WHERE id = $5
       RETURNING id, username, nombre_completo, activo`,
      [username, hash, nombreCompleto, rolAdmin.id, semillaAdmin.id]
    );

    await t.none(
      `INSERT INTO configuracion (clave, valor, categoria, descripcion)
       VALUES ($1, 'true', 'sistema', $2)
       ON CONFLICT (clave) DO UPDATE SET valor = 'true', actualizado_en = NOW()`,
      [CONFIG_SETUP_ADMIN, 'Wizard inicial: administrador personalizado']
    );

    await registrarAuditoria(t, {
      usuario_id: actualizado.id,
      accion: 'SETUP_ADMIN_INICIAL',
      tabla_afectada: 'usuarios',
      registro_id: actualizado.id,
      datos_anteriores: {
        username: semillaAdmin.username,
        nombre_completo: semillaAdmin.nombre_completo
      },
      datos_nuevos: {
        username: actualizado.username,
        nombre_completo: actualizado.nombre_completo
      },
      ip_address: ipAddress
    });

    logger.info('Setup inicial: cuenta administrador personalizada', {
      usuario_id: actualizado.id,
      username: actualizado.username
    });

    return actualizado;
  });
}

const CLAVES_EMPRESA_PERMITIDAS = new Set([
  'empresa_nombre', 'empresa_rif', 'empresa_telefono',
  'empresa_email', 'empresa_direccion'
]);

const CONFIG_SETUP_EMPRESA = 'setup_empresa_completado';

/**
 * Guarda datos iniciales de la empresa y el modo Cashea durante el wizard de instalación.
 * No requiere JWT: se llama antes del primer inicio de sesión.
 * @param {import('pg-promise').IDatabase} db
 * @param {{ empresa_nombre: string, empresa_rif?: string, empresa_telefono?: string,
 *           empresa_email?: string, empresa_direccion?: string, cashea_modo_express?: boolean }} payload
 */
async function guardarEmpresaInicial(db, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};

  const nombre = String(p.empresa_nombre ?? '').trim();
  if (!nombre || nombre.length < 2) {
    throw new Error('El nombre de la empresa es obligatorio (mínimo 2 caracteres).');
  }

  const camposEmpresa = {};
  camposEmpresa.empresa_nombre = nombre;
  if (p.empresa_rif != null && String(p.empresa_rif).trim()) {
    camposEmpresa.empresa_rif = String(p.empresa_rif).trim().slice(0, 30);
  }
  if (p.empresa_telefono != null && String(p.empresa_telefono).trim()) {
    camposEmpresa.empresa_telefono = String(p.empresa_telefono).trim().slice(0, 30);
  }
  if (p.empresa_email != null && String(p.empresa_email).trim()) {
    camposEmpresa.empresa_email = String(p.empresa_email).trim().slice(0, 120);
  }
  if (p.empresa_direccion != null && String(p.empresa_direccion).trim()) {
    camposEmpresa.empresa_direccion = String(p.empresa_direccion).trim().slice(0, 200);
  }

  const modoExpress = p.cashea_modo_express === true || String(p.cashea_modo_express).toLowerCase() === 'true';

  await db.tx(async (t) => {
    for (const [clave, valor] of Object.entries(camposEmpresa)) {
      if (!CLAVES_EMPRESA_PERMITIDAS.has(clave)) continue;
      await t.none(
        `INSERT INTO configuracion (clave, valor, categoria, descripcion)
         VALUES ($1, $2, 'empresa', $3)
         ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
        [clave, valor, `Configurado en wizard inicial · ${clave}`]
      );
    }

    await t.none(
      `UPDATE cashea_config
       SET modo_express_activo = $1, updated_at = NOW()
       WHERE id = (SELECT id FROM cashea_config ORDER BY id ASC LIMIT 1)`,
      [modoExpress]
    );

    await t.none(
      `INSERT INTO configuracion (clave, valor, categoria, descripcion)
       VALUES ($1, 'true', 'sistema', 'Wizard inicial: empresa y Cashea configurados')
       ON CONFLICT (clave) DO UPDATE SET valor = 'true', actualizado_en = NOW()`,
      [CONFIG_SETUP_EMPRESA]
    );
  });

  logger.info('Setup inicial: empresa y modo Cashea configurados', {
    empresa_nombre: nombre,
    cashea_modo_express: modoExpress
  });

  return { empresa_nombre: nombre, cashea_modo_express: modoExpress };
}

/**
 * Guarda el modo monetario elegido en el wizard de instalación (sin JWT).
 * En `solo_bcv` unifica de inmediato tasa_usd = tasa_bcv vigente.
 * @param {import('pg-promise').IDatabase} db
 * @param {string} modo 'multimoneda' | 'solo_bcv'
 */
async function guardarModoMonedaInicial(db, modo) {
  const m = String(modo ?? '').trim().toLowerCase();
  if (!ModoMonedaService.MODOS_VALIDOS.has(m)) {
    throw new Error('modo_moneda_operacion debe ser multimoneda o solo_bcv');
  }

  await db.tx(async (t) => {
    await t.none(
      `INSERT INTO configuracion (clave, valor, categoria, descripcion)
       VALUES ($1, $2, 'moneda', 'Modo operativo elegido en el wizard inicial')
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
      [ModoMonedaService.CLAVE_MODO, m]
    );

    if (m === 'solo_bcv') {
      // No existe dólar calle: la tasa USD arranca igualada a la BCV vigente.
      const row = await t.oneOrNone(
        `SELECT valor FROM configuracion WHERE clave = 'tasa_bcv' LIMIT 1`
      );
      if (row && row.valor != null && String(row.valor).trim() !== '') {
        await t.none(
          `INSERT INTO configuracion (clave, valor, categoria)
           VALUES ('tasa_usd', $1, 'moneda')
           ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
          [String(row.valor)]
        );
      }
    }
  });

  logger.info('Setup inicial: modo monetario configurado', { modo_moneda_operacion: m });
  return { modo_moneda_operacion: m };
}

module.exports = {
  ADMIN_DEFAULT_PASSWORD_HASH,
  CONFIG_SETUP_ADMIN,
  CONFIG_SETUP_EMPRESA,
  isSetupAdminCompletado,
  obtenerEstadoSetupAdmin,
  validarPayloadAdminInicial,
  crearAdminInicial,
  guardarEmpresaInicial,
  guardarModoMonedaInicial
};
