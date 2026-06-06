#!/usr/bin/env node
'use strict';

/**
 * Elimina por completo la base de datos de Nexus Core en PostgreSQL.
 * NO la recrea: el cluster queda como recién instalado (solo postgres, template0, template1).
 *
 * Al arrancar Nexus Core después, el asistente de primera ejecución crea la BD desde cero.
 *
 * Usa PG_* o DATABASE_URL del .env en la raíz del repo — igual que el backend.
 *
 * ⚠ DESTRUCTIVO. Cierra Nexus Core / el backend antes de ejecutar.
 *
 * Uso:
 *   node scripts/reset-database.js --confirm --full
 *     → PostgreSQL limpio + carpeta AppData de Nexus (prueba instalación nueva)
 *
 *   node scripts/reset-database.js --confirm --all-databases
 *   node scripts/reset-database.js --confirm --all-databases --local-state
 *
 * Opcional (solo desarrollo, recrea BD + migraciones sin pasar por el wizard):
 *   node scripts/reset-database.js --confirm --seed
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const os = require('os');
const path = require('path');

const { pgp, cn, closeDatabase } = require('../backend/config/database');

const FORBIDDEN_DATABASES = new Set(['postgres', 'template0', 'template1']);
const SYSTEM_DATABASES = new Set(['postgres', 'template0', 'template1']);

function assertSafeDbIdentifier(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(name))) {
    throw new Error(
      `reset-database: nombre de base de datos inválido (solo letras, números y _): ${String(name)}`
    );
  }
}

function parseArgs(argv) {
  const full = argv.includes('--full');
  return {
    confirm: argv.includes('--confirm') || argv.includes('-y'),
    seed: argv.includes('--seed'),
    allDatabases: full || argv.includes('--all-databases') || argv.includes('--all'),
    localState: full || argv.includes('--local-state')
  };
}

function printUsage() {
  console.log(`
Uso: node scripts/reset-database.js --confirm [opciones]

  --confirm, -y       Obligatorio. Confirma el borrado total.
  --full              Recomendado para prueba "instalación nueva":
                      --all-databases + --local-state (PostgreSQL + AppData Nexus).
  --all-databases     Elimina TODAS las bases de usuario del cluster.
  --local-state       Elimina %APPDATA%\\Nexus Core (config.env, respaldos locales).
  --seed              Tras eliminar, recrea PG_DATABASE y aplica migraciones.

En desarrollo (npm start), para ver el paso 1 del asistente (PostgreSQL):
  $env:NEXUS_FORCE_SETUP="1"; npm start

Variables leídas desde .env: PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD
`);
}

function getNexusUserDataBaseDir() {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return path.join(os.homedir(), '.config');
}

/** Carpetas userData posibles (Electron usa package.json "name" → nexus-core). */
function getNexusUserDataDirCandidates() {
  const base = getNexusUserDataBaseDir();
  const names = ['nexus-core', 'Nexus Core'];
  const seen = new Set();
  const dirs = [];
  for (const name of names) {
    const dir = path.join(base, name);
    if (!seen.has(dir)) {
      seen.add(dir);
      dirs.push(dir);
    }
  }
  return dirs;
}

function getProjectEnvPath() {
  return path.join(__dirname, '..', '.env');
}

function devEnvSkipsDbWizard() {
  const devEnv = getProjectEnvPath();
  if (!fs.existsSync(devEnv)) {
    return false;
  }
  const content = fs.readFileSync(devEnv, 'utf8');
  return (
    /^\s*PG_PASSWORD\s*=\s*\S+/m.test(content) || /^\s*DATABASE_URL\s*=\s*\S+/m.test(content)
  );
}

async function removeLocalNexusState() {
  const candidates = getNexusUserDataDirCandidates();
  const removedDirs = [];
  const warnings = [];

  for (const userDataDir of candidates) {
    if (!fs.existsSync(userDataDir)) {
      continue;
    }

    const configEnv = path.join(userDataDir, 'config.env');
    if (fs.existsSync(configEnv)) {
      try {
        console.log(`  · Eliminando ${configEnv} …`);
        await fs.promises.unlink(configEnv);
        removedDirs.push(configEnv);
      } catch (err) {
        warnings.push(`No se pudo borrar config.env (${err.message}). Cierre Nexus Core e intente de nuevo.`);
      }
    }

    try {
      console.log(`  · Eliminando carpeta ${userDataDir} …`);
      await fs.promises.rm(userDataDir, { recursive: true, force: true });
      if (!removedDirs.includes(userDataDir)) {
        removedDirs.push(userDataDir);
      }
    } catch (err) {
      if (fs.existsSync(configEnv)) {
        warnings.push(`Carpeta bloqueada (${userDataDir}): ${err.message}`);
      } else if (fs.existsSync(userDataDir)) {
        warnings.push(`Quedaron archivos en ${userDataDir} (${err.message}). Cierre Nexus Core.`);
      }
    }
  }

  if (removedDirs.length === 0) {
    console.log(`  · AppData ya limpia (buscado en: ${candidates.join(' | ')})`);
  }

  return {
    removed: removedDirs.length > 0,
    userDataDirs: candidates,
    removedDirs,
    warnings
  };
}

function printFreshInstallInstructions({ localStateRequested, localStateResult }) {
  const devEnv = getProjectEnvPath();
  const skipsWizard = devEnvSkipsDbWizard();
  const userDataDirs = localStateResult?.userDataDirs || getNexusUserDataDirCandidates();

  console.log('');
  console.log('─── Resumen ───');
  console.log('  · PostgreSQL: bases de usuario eliminadas (datos, licencia en BD, usuarios, etc.)');
  if (localStateRequested) {
    if (localStateResult.removed) {
      console.log(`  · AppData: eliminada → ${localStateResult.removedDirs.join(', ')}`);
    } else {
      console.log(`  · AppData: ya estaba limpia (${userDataDirs.join(' | ')})`);
    }
  } else {
    console.log('  · AppData: no se tocó (añada --local-state o --full)');
  }
  console.log(`  · .env del proyecto (solo dev): no se modifica (${devEnv})`);

  console.log('');
  console.log('─── Programa INSTALADO (.exe) ───');
  console.log('  La config real está en AppData, NO en el .env del repo:');
  console.log(`    ${userDataDirs[0]}\\config.env`);
  console.log('  Tras --full, abra el acceso directo del instalador (no npm start).');
  console.log('  Debe aparecer el paso 1 · Base de datos.');

  if (localStateResult.warnings && localStateResult.warnings.length > 0) {
    console.log('');
    console.log('  Advertencias:');
    for (const w of localStateResult.warnings) {
      console.log(`    · ${w}`);
    }
  }

  console.log('');
  console.log('─── Solo si prueba con npm start (desarrollo) ───');
  if (skipsWizard) {
    console.log(`  ${devEnv} tiene PG_PASSWORD → el paso 1 se omite en dev.`);
    console.log('  Fuerce el wizard:  $env:NEXUS_FORCE_SETUP="1"; npm start');
  } else {
    console.log('  npm start  (o NEXUS_FORCE_SETUP=1 para repetir el wizard)');
  }
}

async function listUserDatabases(adminDb) {
  const rows = await adminDb.any(
    `SELECT datname
     FROM pg_database
     WHERE datistemplate = false
       AND datname <> ALL($1::text[])
     ORDER BY datname`,
    [[...SYSTEM_DATABASES]]
  );
  return rows.map((r) => r.datname);
}

async function dropDatabase(adminDb, dbName) {
  assertSafeDbIdentifier(dbName);
  if (FORBIDDEN_DATABASES.has(dbName)) {
    throw new Error(`reset-database: prohibido eliminar la base del sistema "${dbName}"`);
  }

  const exists = await adminDb.oneOrNone(
    `SELECT 1 AS ok FROM pg_database WHERE datname = $1`,
    [dbName]
  );
  if (!exists) {
    console.log(`  · "${dbName}" no existe; omitida.`);
    return false;
  }

  console.log(`  · Cerrando conexiones a "${dbName}"…`);
  await terminateConnections(adminDb, dbName);
  console.log(`  · Eliminando "${dbName}"…`);
  await adminDb.none('DROP DATABASE $1:name', [dbName]);
  return true;
}

async function terminateConnections(adminDb, dbName) {
  // pg_terminate_backend devuelve filas; none() falla con "No return data was expected".
  await adminDb.any(
    `SELECT pg_terminate_backend(pid)
     FROM pg_stat_activity
     WHERE datname = $1
       AND pid <> pg_backend_pid()`,
    [dbName]
  );
}

async function purgeApplicationDatabase(adminDb, targetDb, allDatabases) {
  const toDrop = allDatabases
    ? await listUserDatabases(adminDb)
    : [targetDb];

  if (toDrop.length === 0) {
    console.log('No hay bases de usuario que eliminar.');
    return [];
  }

  console.log(
    allDatabases
      ? `Eliminando ${toDrop.length} base(s) de usuario: ${toDrop.join(', ')}`
      : `Eliminando base configurada en PG_DATABASE: ${targetDb}`
  );
  console.log('');

  const removed = [];
  for (const name of toDrop) {
    const dropped = await dropDatabase(adminDb, name);
    if (dropped) {
      removed.push(name);
    }
  }
  return removed;
}

async function verifyPostgresClean(adminDb, expectEmpty) {
  const rows = await adminDb.any(
    `SELECT datname
     FROM pg_database
     WHERE datistemplate = false
     ORDER BY datname`
  );
  const userDbs = rows.map((r) => r.datname);
  const unexpected = userDbs.filter((name) => !SYSTEM_DATABASES.has(name));

  console.log('');
  console.log('Estado del cluster PostgreSQL:');
  for (const name of userDbs) {
    const tag = SYSTEM_DATABASES.has(name) ? '(sistema)' : '(usuario)';
    console.log(`  · ${name} ${tag}`);
  }

  if (unexpected.length > 0) {
    console.log('');
    console.log(`Quedan bases de usuario: ${unexpected.join(', ')}`);
    if (expectEmpty) {
      throw new Error('reset-database: aún quedan bases de usuario tras la purga');
    }
    console.log('Use --all-databases para eliminarlas y dejar PostgreSQL 100 % limpio.');
  } else {
    console.log('');
    console.log('PostgreSQL limpio: solo bases del sistema (instalación recién hecha).');
  }
}

async function seedDatabase(targetDb) {
  const {
    runBootstrapMigrations,
    runSchemaUpgrades,
    runPatch007HistorialTasas,
    runPatch008CajaMultimoneda,
    runPatch009RolesPermMatrix,
    runPatch010TasasEditAdminOnly,
    runPatch011HistorialTasasTrigger,
    runPatch012CasheaIntegration,
    runPatch013SearchPerformance,
    runPatch014IvaDefaultZero,
    runPatch015VentasTotalBsDescMax,
    runPatch016CreditoSequence,
    runPatch017Devoluciones,
    runPatch018CarteraMissingColumns,
    runPatch019StockConstraints,
    runPatch020SesionesHuerfanas,
    runPatch021IdempotencyVentas,
    runPatch022AnulacionCreditoReversa,
    runPatch023RolesPermDashboardMerge,
    runPatch024FixIdempotencyIndex,
    runPatch025UsuarioPermisosOverride,
    runPatch026QueryPerformanceIndexes,
    runPatch027CasheaNivelesConfigExpress,
    runPatch028MonedaCostoProducto,
    runPatch029VentasTotalRefUsdBcv,
    runPatch030VentasTasaBcvAplicada,
    runPatch031IdempotenciaIndiceReconciliar,
    runPatch032VentasCasheaPctInicialNumeric,
    runPatch033CasheaTarifasComisionOficial,
    runPatch034TasaBcvFeriadosVe2026,
    runPatch035NomenclaturaTasaUsdSinParalela,
    runPatch036SetupAdminLegacy,
    runPatch037TotalBsBcvModoMoneda,
    ensureSemillaAdminSiFalta
  } = require('../backend/config/migrations');

  const adminCn = { ...cn, database: 'postgres' };
  const adminDb = pgp(adminCn);

  try {
    console.log('');
    console.log(`[seed] Creando base "${targetDb}" y aplicando migraciones…`);
    await adminDb.none('CREATE DATABASE $1:name', [targetDb]);
  } finally {
    await adminDb.$pool.end();
  }

  const freshDb = pgp(cn);
  try {
    await runBootstrapMigrations(freshDb);

    const patches = [
      runSchemaUpgrades,
      runPatch007HistorialTasas,
      runPatch008CajaMultimoneda,
      runPatch009RolesPermMatrix,
      runPatch010TasasEditAdminOnly,
      runPatch011HistorialTasasTrigger,
      runPatch012CasheaIntegration,
      runPatch013SearchPerformance,
      runPatch014IvaDefaultZero,
      runPatch015VentasTotalBsDescMax,
      runPatch016CreditoSequence,
      runPatch017Devoluciones,
      runPatch018CarteraMissingColumns,
      runPatch019StockConstraints,
      runPatch020SesionesHuerfanas,
      runPatch021IdempotencyVentas,
      runPatch022AnulacionCreditoReversa,
      runPatch023RolesPermDashboardMerge,
      runPatch024FixIdempotencyIndex,
      runPatch025UsuarioPermisosOverride,
      runPatch026QueryPerformanceIndexes,
      runPatch027CasheaNivelesConfigExpress,
      runPatch028MonedaCostoProducto,
      runPatch029VentasTotalRefUsdBcv,
      runPatch030VentasTasaBcvAplicada,
      runPatch031IdempotenciaIndiceReconciliar,
      runPatch032VentasCasheaPctInicialNumeric,
      runPatch033CasheaTarifasComisionOficial,
      runPatch034TasaBcvFeriadosVe2026,
      runPatch035NomenclaturaTasaUsdSinParalela,
      runPatch036SetupAdminLegacy,
      runPatch037TotalBsBcvModoMoneda
    ];

    for (const fn of patches) {
      await fn(freshDb);
    }

    await ensureSemillaAdminSiFalta(freshDb);
    console.log('[seed] Listo. Login: admin / admin123');
  } finally {
    await freshDb.$pool.end();
  }
}

async function main() {
  const { confirm, seed, allDatabases, localState } = parseArgs(process.argv.slice(2));

  if (!confirm) {
    printUsage();
    console.error('\nError: debe pasar --confirm para ejecutar el borrado total.');
    process.exit(1);
  }

  const targetDb = cn.database;
  assertSafeDbIdentifier(targetDb);
  if (FORBIDDEN_DATABASES.has(targetDb)) {
    throw new Error(
      `reset-database: PG_DATABASE="${targetDb}" es una base del sistema. Defina PG_DATABASE=nexuscore en .env`
    );
  }

  let modeLabel = 'solo PG_DATABASE (sin recrear)';
  if (allDatabases && localState && seed) {
    modeLabel = 'PostgreSQL + AppData + recrear migraciones';
  } else if (allDatabases && localState) {
    modeLabel = 'PostgreSQL + AppData (--full)';
  } else if (allDatabases && seed) {
    modeLabel = 'todas las bases de usuario + recrear PG_DATABASE (--seed)';
  } else if (allDatabases) {
    modeLabel = 'todas las bases de usuario (sin recrear)';
  } else if (localState) {
    modeLabel = 'solo PG_DATABASE + AppData local';
  } else if (seed) {
    modeLabel = 'solo PG_DATABASE + recrear migraciones (--seed)';
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  PURGA TOTAL — POSTGRESQL COMO RECIÉN INSTALADO');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Host:     ${cn.host}:${cn.port}`);
  console.log(`  Usuario:  ${cn.user}`);
  console.log(`  PG_DATABASE: ${targetDb}`);
  console.log(`  Modo:     ${modeLabel}`);
  console.log('');
  console.log('  Las bases seleccionadas desaparecerán por completo. No se puede deshacer.');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  const adminCn = { ...cn, database: 'postgres' };
  const adminDb = pgp(adminCn);

  let removed = [];
  try {
    removed = await purgeApplicationDatabase(adminDb, targetDb, allDatabases);
    await verifyPostgresClean(adminDb, allDatabases);
  } finally {
    await adminDb.$pool.end();
  }

  if (seed) {
    await seedDatabase(targetDb);
    console.log('');
    console.log(`Base "${targetDb}" recreada con migraciones (--seed).`);
    printFreshInstallInstructions({
      localStateRequested: localState,
      localStateResult: { removed: false, userDataDirs: getNexusUserDataDirCandidates(), removedDirs: [] }
    });
    return;
  }

  let localStateResult = { removed: false, userDataDirs: getNexusUserDataDirCandidates(), removedDirs: [] };
  if (localState) {
    console.log('');
    console.log('Eliminando estado local de Nexus Core (AppData)…');
    localStateResult = await removeLocalNexusState();
  }

  console.log('');
  if (removed.length > 0) {
    console.log(`Bases eliminadas: ${removed.join(', ')}`);
  } else {
    console.log('PostgreSQL: sin bases de usuario que eliminar.');
  }

  printFreshInstallInstructions({ localStateRequested: localState, localStateResult });
}

main()
  .catch(async (err) => {
    console.error('');
    console.error('reset-database falló:', err.message || err);
    if (err.stack) {
      console.error(err.stack);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await closeDatabase();
    } catch (_e) {}
  });
