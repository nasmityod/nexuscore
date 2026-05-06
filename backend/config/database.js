'use strict';

const path = require('path');

const { logger } = require('./logger');

const dbName = process.env.PG_DATABASE || 'nexuscore';
const defaultConnection = {
  host: process.env.PG_HOST || '127.0.0.1',
  port: Number(process.env.PG_PORT || 5432),
  database: dbName,
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 10000),
  ssl:
    process.env.PG_SSL === 'true'
      ? { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== 'false' }
      : false
};

const parseDatabaseUrl = (url) => {
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: Number(u.port || 5432),
      database: (u.pathname || '/postgres').replace(/^\//, '') || 'postgres',
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      max: defaultConnection.max,
      idleTimeoutMillis: defaultConnection.idleTimeoutMillis,
      connectionTimeoutMillis: defaultConnection.connectionTimeoutMillis,
      ssl: defaultConnection.ssl
    };
  } catch (e) {
    logger.warn('DATABASE_URL inválida; se usa configuración por variables PG_*');
    return null;
  }
};

const initOptions = {
  noWarnings: process.env.NODE_ENV === 'production'
};

const pgp = require('pg-promise')(initOptions);

const cn =
  process.env.DATABASE_URL && process.env.DATABASE_URL.length > 0
    ? parseDatabaseUrl(process.env.DATABASE_URL) || defaultConnection
    : defaultConnection;

const db = pgp(cn);

// Captura errores del pool para evitar que el proceso Node crashee
// y para loguear la causa real (ej: Postgres de sistema detenido).
db.$pool.on('error', function (err) {
  logger.error('[DB Pool] Conexion perdida o error inesperado', {
    message: err.message,
    code: err.code
  });
});

/** Validación ligera antes de usar $1:name en CREATE DATABASE. */
function assertSafeDbIdentifier(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(name))) {
    throw new Error(`Nombre de base de datos inválido (solo letras, números y _): ${String(name)}`);
  }
}

/**
 * Conecta al catálogo `postgres`, comprueba si existe PG_DATABASE (`nexuscore` por defecto)
 * y la crea antes de usar el pool de la aplicación.
 */
async function bootstrapEnsureApplicationDatabase() {
  const targetDb = cn.database;
  if (targetDb === 'postgres') {
    return;
  }
  assertSafeDbIdentifier(targetDb);

  const adminCn = { ...cn, database: 'postgres' };
  const adminDb = pgp(adminCn);

  try {
    const exists = await adminDb.oneOrNone(
      `SELECT 1 AS ok FROM pg_database WHERE datname = $1`,
      [targetDb]
    );
    if (exists) {
      return;
    }
    logger.info('Creando base de datos de aplicación', { database: targetDb });
    await adminDb.none('CREATE DATABASE $1:name', [targetDb]);
  } finally {
    await adminDb.$pool.end();
  }
}

/**
 * Comprueba conexión y versión de PostgreSQL (útil al arrancar el backend / Electron).
 */
async function initDatabase() {
  await bootstrapEnsureApplicationDatabase();

  const row = await db.one(
    'SELECT version() AS version, current_database() AS database, current_user AS user'
  );
  logger.info('PostgreSQL conectado', {
    database: row.database,
    user: row.user,
    version: String(row.version).split(',')[0]
  });
  return row;
}

/**
 * Intenta conectar a PostgreSQL hasta `maxAttempts` veces con backoff lineal.
 * Útil cuando el servicio de Windows tarda en arrancar tras un reinicio
 * o cuando el antivirus está bloqueando el puerto temporalmente.
 *
 * @param {number} maxAttempts  Intentos totales (>= 1). Default: 5.
 * @param {number} baseDelayMs  Espera entre intentos (lineal). Default: 3000.
 * @param {function} onAttempt  Callback opcional con (attempt, maxAttempts, lastError)
 *                              para que el splash muestre estado al usuario.
 */
async function initDatabaseWithRetry(maxAttempts = 5, baseDelayMs = 3000, onAttempt) {
  let lastErr = null;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      if (typeof onAttempt === 'function') {
        try { onAttempt(i, maxAttempts, lastErr); } catch (_e) {}
      }
      return await initDatabase();
    } catch (err) {
      lastErr = err;
      logger.warn('Intento de conexión a BD fallido', {
        attempt: i,
        maxAttempts,
        code: err.code,
        message: err.message
      });
      if (i === maxAttempts) throw err;
      // Backoff lineal: 3s, 6s, 9s, 12s, ...
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * i));
    }
  }
  throw lastErr;
}

function closeDatabase() {
  return pgp.end();
}

/**
 * Detecta la ruta de migraciones:
 * - Desarrollo: database/migrations relativo al proyecto
 * - Empaquetado: intenta process.resourcesPath/migrations primero, luego fallback
 */
function getMigrationsDirectory() {
  const electron = tryRequireElectron();
  
  if (electron && electron.app && electron.app.isPackaged) {
    const candidates = [
      path.join(process.resourcesPath, 'migrations'),
      path.join(process.resourcesPath, 'database', 'migrations'),
      path.join(path.dirname(process.execPath), 'resources', 'migrations'),
      path.join(path.dirname(process.execPath), 'resources', 'database', 'migrations')
    ];

    for (const candidate of candidates) {
      if (require('fs').existsSync(candidate)) {
        logger.info('Directorio de migraciones (empaquetado)', { path: candidate });
        return candidate;
      }
    }

    throw new Error(
      `No se encontraron migraciones en el paquete. Rutas probadas:\n${candidates.join('\n')}`
    );
  }

  const devPath = path.join(__dirname, '..', '..', 'database', 'migrations');
  return devPath;
}

function tryRequireElectron() {
  try {
    return require('electron');
  } catch {
    return null;
  }
}

module.exports = {
  pgp,
  db,
  cn,
  dbName,
  bootstrapEnsureApplicationDatabase,
  initDatabase,
  initDatabaseWithRetry,
  closeDatabase,
  migrationsDir: getMigrationsDirectory()
};
