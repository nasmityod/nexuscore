'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LOG_PREFIX = '[nexus-setup]';

const CONFIG_FILENAME = 'config.env';

/**
 * @param {import('electron').App} app
 * @returns {string}
 */
function getUserConfigEnvPath(app) {
  return path.join(app.getPath('userData'), CONFIG_FILENAME);
}

/**
 * @param {string} name
 */
function assertSafeDbIdentifier(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(name))) {
    throw new Error(`Nombre de base de datos inválido (solo letras, números y _): ${String(name)}`);
  }
}

/**
 * @param {string} val
 * @returns {string}
 */
function escapeEnvValue(val) {
  const s = String(val ?? '');
  if (/^[A-Za-z0-9_./:-]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/**
 * Carga variables: .env del proyecto (dev) y config.env en userData (prioridad).
 * @param {import('electron').App} app
 */
function loadNexusEnv(app) {
  const dotenv = require('dotenv');
  const projectEnv = path.join(__dirname, '..', '.env');
  dotenv.config({ path: projectEnv });

  const userEnv = getUserConfigEnvPath(app);
  if (fs.existsSync(userEnv)) {
    dotenv.config({ path: userEnv, override: true });
    console.log(`${LOG_PREFIX} Configuración cargada desde ${userEnv}`);
  }

  if (app.isPackaged && !process.env.NODE_ENV) {
    process.env.NODE_ENV = 'production';
  }
}

/**
 * @param {import('electron').App} app
 * @returns {boolean}
 */
function needsFirstRunSetup(app) {
  const force = String(process.env.NEXUS_FORCE_SETUP || '').trim().toLowerCase();
  if (force === '1' || force === 'true') {
    return true;
  }

  if (fs.existsSync(getUserConfigEnvPath(app))) {
    return false;
  }

  if (!app.isPackaged) {
    const devEnv = path.join(__dirname, '..', '.env');
    if (fs.existsSync(devEnv)) {
      const content = fs.readFileSync(devEnv, 'utf8');
      if (/^\s*PG_PASSWORD\s*=\s*\S+/m.test(content) || /^\s*DATABASE_URL\s*=\s*\S+/m.test(content)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * @param {unknown} raw
 * @returns {{ pgHost: string, pgPort: number, pgDatabase: string, pgUser: string, pgPassword: string }}
 */
function normalizeSetupPayload(raw) {
  const pgHost = String(raw && raw.pgHost != null ? raw.pgHost : '127.0.0.1').trim() || '127.0.0.1';
  const pgPortRaw = Number.parseInt(String(raw && raw.pgPort != null ? raw.pgPort : '5432'), 10);
  const pgPort = Number.isFinite(pgPortRaw) && pgPortRaw > 0 && pgPortRaw <= 65535 ? pgPortRaw : 5432;
  const pgDatabase = String(raw && raw.pgDatabase != null ? raw.pgDatabase : 'nexuscore').trim() || 'nexuscore';
  const pgUser = String(raw && raw.pgUser != null ? raw.pgUser : 'postgres').trim() || 'postgres';
  const pgPassword = String(raw && raw.pgPassword != null ? raw.pgPassword : '');

  assertSafeDbIdentifier(pgDatabase);

  if (!pgUser) {
    throw new Error('El usuario de PostgreSQL es obligatorio.');
  }

  return { pgHost, pgPort, pgDatabase, pgUser, pgPassword };
}

/**
 * @param {Error & { code?: string }} err
 * @returns {string}
 */
function friendlyPgError(err) {
  const code = err && err.code ? String(err.code) : '';
  const msg = err && err.message ? String(err.message) : 'Error de conexión';

  if (code === 'ECONNREFUSED') {
    return 'PostgreSQL no responde en ese host/puerto. Verifica que el servicio esté iniciado (Servicios de Windows).';
  }
  if (code === '28P01') {
    return 'Contraseña incorrecta para el usuario indicado.';
  }
  if (code === 'ENOTFOUND' || code === 'ETIMEDOUT' || code === 'EHOSTUNREACH') {
    return 'No se puede alcanzar el servidor PostgreSQL en ese host/puerto.';
  }
  if (code === '57P03') {
    return 'PostgreSQL está arrancando; espera unos segundos e intenta de nuevo.';
  }

  return msg.split('\n')[0];
}

/**
 * @param {{ pgHost: string, pgPort: number, pgDatabase: string, pgUser: string, pgPassword: string }} cfg
 * @returns {Promise<{ ok: boolean, message: string, databaseWillBeCreated?: boolean }>}
 */
async function testPostgresConnection(cfg) {
  if (cfg.pgPassword == null || String(cfg.pgPassword) === '') {
    return { ok: false, message: 'Ingresa la contraseña del usuario PostgreSQL.' };
  }

  const pgp = require('pg-promise')({ noWarnings: true });
  const adminDb = pgp({
    host: cfg.pgHost,
    port: cfg.pgPort,
    database: 'postgres',
    user: cfg.pgUser,
    password: cfg.pgPassword,
    connectionTimeoutMillis: 10000,
    ssl: false
  });

  try {
    await adminDb.one('SELECT 1 AS ok');

    const exists = await adminDb.oneOrNone(
      'SELECT 1 AS ok FROM pg_database WHERE datname = $1',
      [cfg.pgDatabase]
    );

    if (exists) {
      return {
        ok: true,
        message: `Conexión exitosa. La base «${cfg.pgDatabase}» ya existe y se usará.`
      };
    }

    return {
      ok: true,
      message: `Conexión exitosa. Nexus creará la base «${cfg.pgDatabase}» al iniciar.`,
      databaseWillBeCreated: true
    };
  } catch (err) {
    return { ok: false, message: friendlyPgError(err) };
  } finally {
    await adminDb.$pool.end();
  }
}

/**
 * @returns {string}
 */
function generateJwtSecret() {
  return crypto.randomBytes(48).toString('hex');
}

/**
 * @param {import('electron').App} app
 * @param {{ pgHost: string, pgPort: number, pgDatabase: string, pgUser: string, pgPassword: string }} cfg
 * @returns {Promise<{ ok: boolean, path: string }>}
 */
async function saveUserConfigEnv(app, cfg) {
  const jwtSecret = generateJwtSecret();
  const nodeEnv = app.isPackaged ? 'production' : (process.env.NODE_ENV || 'development');

  const lines = [
    '# Nexus Core — configuración local (generado por el asistente de instalación)',
    '# No compartas este archivo; contiene credenciales sensibles.',
    '',
    `PG_HOST=${escapeEnvValue(cfg.pgHost)}`,
    `PG_PORT=${cfg.pgPort}`,
    `PG_DATABASE=${escapeEnvValue(cfg.pgDatabase)}`,
    `PG_USER=${escapeEnvValue(cfg.pgUser)}`,
    `PG_PASSWORD=${escapeEnvValue(cfg.pgPassword)}`,
    '',
    `JWT_SECRET=${jwtSecret}`,
    'JWT_EXPIRES_IN=12h',
    '',
    `NODE_ENV=${nodeEnv}`,
    'PORT=3000',
    '',
    'NEXUS_SETUP_COMPLETE=1'
  ];

  const target = getUserConfigEnvPath(app);
  const tmp = `${target}.tmp`;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(tmp, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.promises.rename(tmp, target);

  console.log(`${LOG_PREFIX} Configuración guardada en ${target}`);

  return { ok: true, path: target };
}

/**
 * @param {import('electron').App} app
 * @returns {{ pgHost: string, pgPort: number, pgDatabase: string, pgUser: string }}
 */
function getSetupDefaults(app) {
  loadNexusEnv(app);
  return {
    pgHost: process.env.PG_HOST || '127.0.0.1',
    pgPort: Number(process.env.PG_PORT || 5432),
    pgDatabase: process.env.PG_DATABASE || 'nexuscore',
    pgUser: process.env.PG_USER || 'postgres'
  };
}

/**
 * Aplica al proceso las variables recién guardadas (sin reiniciar Electron).
 * @param {import('electron').App} app
 */
function applySavedConfigToProcess(app) {
  loadNexusEnv(app);
}

module.exports = {
  getUserConfigEnvPath,
  loadNexusEnv,
  needsFirstRunSetup,
  normalizeSetupPayload,
  testPostgresConnection,
  saveUserConfigEnv,
  getSetupDefaults,
  applySavedConfigToProcess,
  friendlyPgError
};
