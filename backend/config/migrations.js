'use strict';

const fs = require('fs');
const path = require('path');

const { migrationsDir } = require('./database');
const { logger } = require('./logger');

/** Tabla marcador del esquema base (primera tabla creada en 001). */
const MARKER_TABLE = 'configuracion';

function migrationNumericPrefix(filename) {
  const m = filename.match(/^(\d{3})_/);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * Todos los `database/migrations/*.sql`, orden numérico por prefijo 001_, 002_, ...
 */
function listAllMigrationSqlPaths() {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`No existe directorio de migraciones: ${migrationsDir}`);
  }
  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql') && !name.startsWith('.'));

  const paths = files.map((name) => path.join(migrationsDir, name));

  paths.sort((a, b) => {
    const da = migrationNumericPrefix(path.basename(a));
    const db = migrationNumericPrefix(path.basename(b));
    if (da !== db) return da - db;
    return path.basename(a).localeCompare(path.basename(b));
  });

  return paths;
}

async function markerTableExists(db) {
  const row = await db.oneOrNone(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = $1
     ) AS exists`,
    [MARKER_TABLE]
  );
  return Boolean(row?.exists);
}

/**
 * Tras aplicar SQL: admin + tasas mínimas (BCV + USD mercado).
 */
async function verifyBootstrapSeed(db) {
  const admin = await db.oneOrNone(
    `SELECT id FROM usuarios WHERE username = 'admin' AND activo IS NOT FALSE LIMIT 1`
  );
  if (!admin) {
    throw new Error(
      'Semilla inicial incompleta: falta usuario "admin". Revise database/migrations/004_seed_data.sql.'
    );
  }

  const tasasRows = await db.any(
    `SELECT clave FROM configuracion
     WHERE clave IN ('tasa_bcv', 'tasa_usd')`
  );
  const set = new Set(tasasRows.map((r) => r.clave));
  if (!set.has('tasa_bcv')) {
    throw new Error(
      'Semilla inicial incompleta: falta "tasa_bcv" en configuracion (esperado en 001_initial_schema.sql).'
    );
  }
  if (!set.has('tasa_usd')) {
    throw new Error(
      'Semilla inicial incompleta: falta "tasa_usd" en configuracion.'
    );
  }
}

/**
 * Si la BD no tiene el esquema base (sin tabla configuracion), aplica todos los
 * `database/migrations/*.sql` en orden y valida usuario admin y tasas iniciales.
 *
 * IMPORTANTE: Todo el bootstrap corre en UNA SOLA transacción. Si cualquier
 * archivo SQL falla, se hace ROLLBACK completo y la BD vuelve a su estado vacío,
 * permitiendo reintentar la instalación sin dejar la BD en estado parcial.
 *
 * Los parches post-bootstrap (006, 007, ...) sí van en transacciones individuales
 * porque son idempotentes y se aplican uno a uno conforme la app evoluciona.
 */
async function runBootstrapMigrations(db) {
  const exists = await markerTableExists(db);
  if (exists) {
    logger.debug('Esquema Nexus-Core ya presente; omitiendo migraciones bootstrap');
    return { ran: false, files: [] };
  }

  const todo = listAllMigrationSqlPaths();
  if (!todo.length) {
    throw new Error(`Base de datos vacía pero no hay archivos .sql en ${migrationsDir}`);
  }

  logger.info('Base de datos vacía: ejecutando bootstrap atómico (una sola transacción)', {
    count: todo.length
  });

  // ── ATOMIC BOOTSTRAP ──
  // Todos los archivos en una única tx. Si uno falla, ROLLBACK → BD vuelve vacía.
  // Esto evita el escenario de "BD a medias" tras una migración fallida.
  await db.tx({ tag: 'bootstrap_atomico' }, async (t) => {
    for (const filePath of todo) {
      const name = path.basename(filePath);
      const sql = fs.readFileSync(filePath, 'utf8');
      logger.info('Aplicando migración', { file: name });
      await t.result(sql);
    }
  });

  await verifyBootstrapSeed(db);

  logger.info('Migraciones bootstrap completadas', { files: todo.map((p) => path.basename(p)) });
  return { ran: true, files: todo.map((p) => path.basename(p)) };
}

const SCHEMA_PATCH_CLAVE     = 'schema_patch_006_productos_costo';
const SCHEMA_PATCH_007_CLAVE = 'schema_patch_007_historial_tasas';
const SCHEMA_PATCH_008_CLAVE = 'schema_patch_008_caja_multimoneda';
const SCHEMA_PATCH_009_CLAVE = 'schema_patch_009_roles_perm_matrix';
const SCHEMA_PATCH_010_CLAVE = 'schema_patch_010_tasas_edit_admin_only';
const SCHEMA_PATCH_011_CLAVE = 'schema_patch_011_fix_historial_tasas_trigger';
const SCHEMA_PATCH_012_CLAVE = 'schema_patch_012_cashea_integration';
const SCHEMA_PATCH_013_CLAVE = 'schema_patch_013_search_performance';
const SCHEMA_PATCH_014_CLAVE = 'schema_patch_014_iva_default_zero';
const SCHEMA_PATCH_015_CLAVE = 'schema_patch_015_ventas_total_bs_desc_max';
const SCHEMA_PATCH_016_CLAVE = 'schema_patch_016_credito_sequence_cuentas_cobrar';
const SCHEMA_PATCH_017_CLAVE = 'schema_patch_017_devoluciones';
const SCHEMA_PATCH_018_CLAVE = 'schema_patch_018_cartera_missing_columns';
const SCHEMA_PATCH_019_CLAVE = 'schema_patch_019_stock_constraints';
const SCHEMA_PATCH_020_CLAVE = 'schema_patch_020_sesiones_huerfanas';
const SCHEMA_PATCH_021_CLAVE = 'schema_patch_021_idempotency_ventas';
const SCHEMA_PATCH_022_CLAVE = 'schema_patch_022_anulacion_credito_reversa';
const SCHEMA_PATCH_023_CLAVE = 'schema_patch_023_roles_perm_dashboard_merge';
const SCHEMA_PATCH_024_CLAVE = 'schema_patch_024_fix_idempotency_index';
const SCHEMA_PATCH_025_CLAVE = 'schema_patch_025_usuario_permisos_override';
const SCHEMA_PATCH_026_CLAVE = 'schema_patch_026_query_performance_indexes';
const SCHEMA_PATCH_027_CLAVE = 'schema_patch_027_cashea_niveles_config_express';
const SCHEMA_PATCH_028_CLAVE = 'schema_patch_028_moneda_costo_producto';
const SCHEMA_PATCH_029_CLAVE = 'schema_patch_029_ventas_total_ref_usd_bcv';
const SCHEMA_PATCH_030_CLAVE = 'schema_patch_030_ventas_tasa_bcv_aplicada';
const SCHEMA_PATCH_031_CLAVE = 'schema_patch_031_idempotencia_ventas_indice_reconciliar';
const SCHEMA_PATCH_032_CLAVE = 'schema_patch_032_ventas_cashea_pct_inicial_numeric';
const SCHEMA_PATCH_033_CLAVE = 'schema_patch_033_cashea_tarifas_comision_oficial';
const SCHEMA_PATCH_034_CLAVE = 'schema_patch_034_tasa_bcv_feriados_ve_2026';
const SCHEMA_PATCH_035_CLAVE = 'schema_patch_035_nomenclatura_tasa_usd_sin_paralela';
const SCHEMA_PATCH_036_CLAVE = 'schema_patch_036_setup_admin_legacy';
const SCHEMA_PATCH_037_CLAVE = 'schema_patch_037_total_bs_bcv_modo_moneda';
const SCHEMA_PATCH_038_CLAVE = 'schema_patch_038_cashea_pct_inicial_semilla_60';

/**
 * Parches SQL idempotentes post-bootstrap (BD ya inicializada).
 * Marca aplicación en configuracion para no repetir trabajo innecesario.
 */
async function runSchemaUpgrades(db) {
  const hasProductos = await db.oneOrNone(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'productos'
     ) AS ex`
  );
  if (!hasProductos || !hasProductos.ex) {
    return { ran: false };
  }

  const applied = await db.oneOrNone(
    `SELECT 1 FROM configuracion WHERE clave = $1 LIMIT 1`,
    [SCHEMA_PATCH_CLAVE]
  );
  if (applied) {
    logger.debug('Parche de esquema 006 ya aplicado');
    return { ran: false, already: true };
  }

  const upgradePath = path.join(migrationsDir, '006_simplify_productos_costo.sql');
  if (!fs.existsSync(upgradePath)) {
    logger.warn('Falta archivo de parche', { path: upgradePath });
    return { ran: false };
  }

  const sql = fs.readFileSync(upgradePath, 'utf8');
  logger.info('Aplicando parche de esquema', { file: path.basename(upgradePath) });

  await db.tx(async (t) => {
    await t.result(sql);
    await t.none(
      `INSERT INTO configuracion (clave, valor, categoria, descripcion)
       VALUES ($1, 'applied', 'sistema', 'Parche 006: productos solo costo_usd')
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
      [SCHEMA_PATCH_CLAVE]
    );
  });

  return { ran: true };
}

/**
 * Parche 007: historial de tasas de cambio + trigger automático.
 */
async function runPatch007HistorialTasas(db) {
  const hasCfg = await db.oneOrNone(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='configuracion') AS ex`
  );
  if (!hasCfg || !hasCfg.ex) return { ran: false };

  const applied = await db.oneOrNone(
    `SELECT 1 FROM configuracion WHERE clave = $1 LIMIT 1`,
    [SCHEMA_PATCH_007_CLAVE]
  );
  if (applied) {
    logger.debug('Parche 007 historial_tasas ya aplicado');
    return { ran: false, already: true };
  }

  const upgradePath = path.join(migrationsDir, '007_historial_tasas.sql');
  if (!fs.existsSync(upgradePath)) {
    logger.warn('Falta archivo de parche 007', { path: upgradePath });
    return { ran: false };
  }

  const sql = fs.readFileSync(upgradePath, 'utf8');
  logger.info('Aplicando parche 007: historial_tasas', { file: '007_historial_tasas.sql' });

  await db.tx(async (t) => {
    await t.result(sql);
    await t.none(
      `INSERT INTO configuracion (clave, valor, categoria, descripcion)
       VALUES ($1, 'applied', 'sistema', 'Parche 007: historial_tasas + trigger')
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
      [SCHEMA_PATCH_007_CLAVE]
    );
  });

  return { ran: true };
}

/**
 * Parche 008: Módulo D — columnas para control de caja multimoneda.
 * Agrega monto_inicial_usd/bs, tasa_bcv/usd_apertura, conteos físicos
 * y columnas de diferencia a sesiones_caja.
 */
async function runPatch008CajaMultimoneda(db) {
  const hasCfg = await db.oneOrNone(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='configuracion') AS ex`
  );
  if (!hasCfg || !hasCfg.ex) return { ran: false };

  const applied = await db.oneOrNone(
    `SELECT 1 FROM configuracion WHERE clave = $1 LIMIT 1`,
    [SCHEMA_PATCH_008_CLAVE]
  );
  if (applied) {
    logger.debug('Parche 008 caja_multimoneda ya aplicado');
    return { ran: false, already: true };
  }

  const upgradePath = path.join(migrationsDir, '008_caja_schema_upgrade.sql');
  if (!fs.existsSync(upgradePath)) {
    logger.warn('Falta archivo de parche 008', { path: upgradePath });
    return { ran: false };
  }

  const sql = fs.readFileSync(upgradePath, 'utf8');
  logger.info('Aplicando parche 008: caja multimoneda (Módulo D)', { file: '008_caja_schema_upgrade.sql' });

  await db.tx(async (t) => {
    await t.result(sql);
    await t.none(
      `INSERT INTO configuracion (clave, valor, categoria, descripcion)
       VALUES ($1, 'applied', 'sistema', 'Parche 008: Módulo D — caja multimoneda conteos físicos')
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
      [SCHEMA_PATCH_008_CLAVE]
    );
  });

  return { ran: true };
}

/**
 * Parche 009: rol vendedor + matriz JSON permisos por rol (API + JWT).
 */
async function runPatch009RolesPermMatrix(db) {
  const hasCfg = await db.oneOrNone(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='configuracion') AS ex`
  );
  if (!hasCfg || !hasCfg.ex) return { ran: false };

  const applied = await db.oneOrNone(
    `SELECT 1 FROM configuracion WHERE clave = $1 LIMIT 1`,
    [SCHEMA_PATCH_009_CLAVE]
  );
  if (applied) {
    logger.debug('Parche 009 roles_perm_matrix ya aplicado');
    return { ran: false, already: true };
  }

  const upgradePath = path.join(migrationsDir, '009_roles_perm_matrix.sql');
  if (!fs.existsSync(upgradePath)) {
    logger.warn('Falta archivo de parche 009', { path: upgradePath });
    return { ran: false };
  }

  const sql = fs.readFileSync(upgradePath, 'utf8');
  logger.info('Aplicando parche 009: roles y permisos (vendedor)', {
    file: '009_roles_perm_matrix.sql'
  });

  await db.tx(async (t) => {
    await t.result(sql);
    await t.none(
      `INSERT INTO configuracion (clave, valor, categoria, descripcion)
       VALUES ($1, 'applied', 'sistema', 'Parche 009: matriz permisos + rol vendedor')
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
      [SCHEMA_PATCH_009_CLAVE]
    );
  });

  return { ran: true };
}

/**
 * Parche 010: tasas_edit=false en todos los roles salvo admin (solo admin modifica tasas en servidor).
 */
async function runPatch010TasasEditAdminOnly(db) {
  const hasCfg = await db.oneOrNone(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='configuracion') AS ex`
  );
  if (!hasCfg || !hasCfg.ex) return { ran: false };

  const applied = await db.oneOrNone(
    `SELECT 1 FROM configuracion WHERE clave = $1 LIMIT 1`,
    [SCHEMA_PATCH_010_CLAVE]
  );
  if (applied) {
    logger.debug('Parche 010 tasas_edit_admin_only ya aplicado');
    return { ran: false, already: true };
  }

  const upgradePath = path.join(migrationsDir, '010_tasas_edit_admin_only.sql');
  if (!fs.existsSync(upgradePath)) {
    logger.warn('Falta archivo de parche 010', { path: upgradePath });
    return { ran: false };
  }

  const sql = fs.readFileSync(upgradePath, 'utf8');
  logger.info('Aplicando parche 010: tasas solo administrador', {
    file: '010_tasas_edit_admin_only.sql'
  });

  await db.tx(async (t) => {
    await t.result(sql);
    await t.none(
      `INSERT INTO configuracion (clave, valor, categoria, descripcion)
       VALUES ($1, 'applied', 'sistema', 'Parche 010: permiso tasas_edit solo admin')
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
      [SCHEMA_PATCH_010_CLAVE]
    );
  });

  return { ran: true };
}

/**
 * Parche 011: trigger historial_tasas compatible con PostgreSQL 11–13 (EXECUTE PROCEDURE).
 * Corrige instalaciones donde el 007 usó EXECUTE FUNCTION (solo PG 14+).
 */
async function runPatch011HistorialTasasTrigger(db) {
  const hasCfg = await db.oneOrNone(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='configuracion') AS ex`
  );
  if (!hasCfg || !hasCfg.ex) return { ran: false };

  const applied = await db.oneOrNone(
    `SELECT 1 FROM configuracion WHERE clave = $1 LIMIT 1`,
    [SCHEMA_PATCH_011_CLAVE]
  );
  if (applied) {
    logger.debug('Parche 011 fix trigger historial_tasas ya aplicado');
    return { ran: false, already: true };
  }

  const hasHistorial = await db.oneOrNone(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='historial_tasas') AS ex`
  );
  if (!hasHistorial || !hasHistorial.ex) {
    logger.debug('Parche 011 omitido: no existe historial_tasas (parche 007 pendiente)');
    return { ran: false };
  }

  const upgradePath = path.join(migrationsDir, '011_fix_trigger_historial_tasas_pg.sql');
  if (!fs.existsSync(upgradePath)) {
    logger.warn('Falta archivo de parche 011', { path: upgradePath });
    return { ran: false };
  }

  const sql = fs.readFileSync(upgradePath, 'utf8');
  logger.info('Aplicando parche 011: trigger historial_tasas (PG 11–13 compatible)', {
    file: '011_fix_trigger_historial_tasas_pg.sql'
  });

  await db.tx(async (t) => {
    await t.result(sql);
    await t.none(
      `INSERT INTO configuracion (clave, valor, categoria, descripcion)
       VALUES ($1, 'applied', 'sistema', 'Parche 011: EXECUTE PROCEDURE en trigger historial_tasas')
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
      [SCHEMA_PATCH_011_CLAVE]
    );
  });

  return { ran: true };
}

/**
 * Parche 012: integración Cashea (config, ventas_cashea, liquidaciones).
 */
async function runPatch012CasheaIntegration(db) {
  const hasCfg = await db.oneOrNone(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='configuracion') AS ex`
  );
  if (!hasCfg || !hasCfg.ex) return { ran: false };

  const applied = await db.oneOrNone(
    `SELECT 1 FROM configuracion WHERE clave = $1 LIMIT 1`,
    [SCHEMA_PATCH_012_CLAVE]
  );
  if (applied) {
    logger.debug('Parche 012 Cashea ya aplicado');
    return { ran: false, already: true };
  }

  const upgradePath = path.join(migrationsDir, '012_cashea_integration.sql');
  if (!fs.existsSync(upgradePath)) {
    logger.warn('Falta archivo de parche 012', { path: upgradePath });
    return { ran: false };
  }

  const sql = fs.readFileSync(upgradePath, 'utf8');
  logger.info('Aplicando parche 012: Cashea integration', {
    file: '012_cashea_integration.sql'
  });

  await db.tx(async (t) => {
    await t.result(sql);
    await t.none(
      `INSERT INTO configuracion (clave, valor, categoria, descripcion)
       VALUES ($1, 'applied', 'sistema', 'Parche 012: tablas y permisos Cashea')
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
      [SCHEMA_PATCH_012_CLAVE]
    );
  });

  return { ran: true };
}

/**
 * Parche 013: indices trigram para busqueda rapida de productos en POS.
 */
async function runPatch013SearchPerformance(db) {
  const hasCfg = await db.oneOrNone(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='configuracion') AS ex`
  );
  if (!hasCfg || !hasCfg.ex) return { ran: false };

  const applied = await db.oneOrNone(
    `SELECT 1 FROM configuracion WHERE clave = $1 LIMIT 1`,
    [SCHEMA_PATCH_013_CLAVE]
  );
  if (applied) {
    logger.debug('Parche 013 search_performance ya aplicado');
    return { ran: false, already: true };
  }

  const upgradePath = path.join(migrationsDir, '013_search_performance.sql');
  if (!fs.existsSync(upgradePath)) {
    logger.warn('Falta archivo de parche 013', { path: upgradePath });
    return { ran: false };
  }

  const sql = fs.readFileSync(upgradePath, 'utf8');
  logger.info('Aplicando parche 013: search performance', {
    file: '013_search_performance.sql'
  });

  await db.tx(async (t) => {
    await t.result(sql);
    await t.none(
      `INSERT INTO configuracion (clave, valor, categoria, descripcion)
       VALUES ($1, 'applied', 'sistema', 'Parche 013: indices trigram para busqueda POS')
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
      [SCHEMA_PATCH_013_CLAVE]
    );
  });

  return { ran: true };
}

/**
 * Parche 014: IVA ventas DEFAULT 0 y configuracion.impuesto_iva en 0.
 */
async function runPatch014IvaDefaultZero(db) {
  const hasCfg = await db.oneOrNone(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='configuracion') AS ex`
  );
  if (!hasCfg || !hasCfg.ex) return { ran: false };

  const applied = await db.oneOrNone(
    `SELECT 1 FROM configuracion WHERE clave = $1 LIMIT 1`,
    [SCHEMA_PATCH_014_CLAVE]
  );
  if (applied) {
    logger.debug('Parche 014 iva_default_zero ya aplicado');
    return { ran: false, already: true };
  }

  const upgradePath = path.join(migrationsDir, '014_ventas_iva_default_zero.sql');
  if (!fs.existsSync(upgradePath)) {
    logger.warn('Falta archivo de parche 014', { path: upgradePath });
    return { ran: false };
  }

  const sql = fs.readFileSync(upgradePath, 'utf8');
  logger.info('Aplicando parche 014: IVA por defecto 0%', {
    file: '014_ventas_iva_default_zero.sql'
  });

  await db.tx(async (t) => {
    await t.result(sql);
    await t.none(
      `INSERT INTO configuracion (clave, valor, categoria, descripcion)
       VALUES ($1, 'applied', 'sistema', 'Parche 014: ventas.iva_porcentaje DEFAULT 0, impuesto_iva=0')
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
      [SCHEMA_PATCH_014_CLAVE]
    );
  });

  return { ran: true };
}

/**
 * Parche 015: total_bs_cliente en ventas (huella forense) + venta_descuento_max_pct en configuracion.
 */
async function runPatch015VentasTotalBsDescMax(db) {
  const hasCfg = await db.oneOrNone(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='configuracion') AS ex`
  );
  if (!hasCfg || !hasCfg.ex) return { ran: false };

  const applied = await db.oneOrNone(
    `SELECT 1 FROM configuracion WHERE clave = $1 LIMIT 1`,
    [SCHEMA_PATCH_015_CLAVE]
  );
  if (applied) {
    logger.debug('Parche 015 ya aplicado');
    return { ran: false, already: true };
  }

  const upgradePath = path.join(migrationsDir, '015_ventas_total_bs_cliente_desc_max.sql');
  if (!fs.existsSync(upgradePath)) {
    logger.warn('Falta archivo de parche 015', { path: upgradePath });
    return { ran: false };
  }

  const sql = fs.readFileSync(upgradePath, 'utf8');
  logger.info('Aplicando parche 015: total_bs_cliente + venta_descuento_max_pct', {
    file: '015_ventas_total_bs_cliente_desc_max.sql'
  });

  await db.tx(async (t) => {
    await t.result(sql);
    await t.none(
      `INSERT INTO configuracion (clave, valor, categoria, descripcion)
       VALUES ($1, 'applied', 'sistema', 'Parche 015: ventas.total_bs_cliente + descuento_max_pct')
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
      [SCHEMA_PATCH_015_CLAVE]
    );
  });

  return { ran: true };
}

/**
 * Parche 016: SEQUENCE para numero_venta + campos crédito USD BCV en cuentas_cobrar.
 */
async function runPatch016CreditoSequence(db) {
  const hasCfg = await db.oneOrNone(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='configuracion') AS ex`
  );
  if (!hasCfg || !hasCfg.ex) return { ran: false };

  const applied = await db.oneOrNone(
    `SELECT 1 FROM configuracion WHERE clave = $1 LIMIT 1`,
    [SCHEMA_PATCH_016_CLAVE]
  );
  if (applied) {
    logger.debug('Parche 016 credito_sequence ya aplicado');
    return { ran: false, already: true };
  }

  const upgradePath = path.join(migrationsDir, '016_credito_sequence_cuentas_cobrar.sql');
  if (!fs.existsSync(upgradePath)) {
    logger.warn('Falta archivo de parche 016', { path: upgradePath });
    return { ran: false };
  }

  const sql = fs.readFileSync(upgradePath, 'utf8');
  logger.info('Aplicando parche 016: SEQUENCE numero_venta + crédito USD BCV', {
    file: '016_credito_sequence_cuentas_cobrar.sql'
  });

  await db.tx(async (t) => {
    await t.result(sql);
    await t.none(
      `INSERT INTO configuracion (clave, valor, categoria, descripcion)
       VALUES ($1, 'applied', 'sistema', 'Parche 016: ventas_numero_seq + cuentas_cobrar credito USD BCV')
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
      [SCHEMA_PATCH_016_CLAVE]
    );
  });

  return { ran: true };
}

/**
 * Parche 017: tabla devoluciones.
 */
async function runPatch017Devoluciones(db) {
  const hasCfg = await db.oneOrNone(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='configuracion') AS ex`
  );
  if (!hasCfg || !hasCfg.ex) return { ran: false };

  const applied = await db.oneOrNone(
    `SELECT 1 FROM configuracion WHERE clave = $1 LIMIT 1`,
    [SCHEMA_PATCH_017_CLAVE]
  );
  if (applied) { logger.debug('Parche 017 ya aplicado'); return { ran: false, already: true }; }

  const upgradePath = path.join(migrationsDir, '017_devoluciones.sql');
  if (!fs.existsSync(upgradePath)) { logger.warn('Falta archivo de parche 017', { path: upgradePath }); return { ran: false }; }

  const sql = fs.readFileSync(upgradePath, 'utf8');
  logger.info('Aplicando parche 017: tabla devoluciones', { file: '017_devoluciones.sql' });

  await db.tx(async (t) => {
    await t.result(sql);
    await t.none(
      `INSERT INTO configuracion (clave, valor, categoria, descripcion)
       VALUES ($1, 'applied', 'sistema', 'Parche 017: tabla devoluciones')
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
      [SCHEMA_PATCH_017_CLAVE]
    );
  });

  return { ran: true };
}

/**
 * Parche 018: columnas faltantes para módulo de cartera.
 * Agrega actualizado_en a cuentas_cobrar y clientes,
 * y cliente_id/notas/fecha_pago a pagos_credito.
 */
async function runPatch018CarteraMissingColumns(db) {
  const hasCfg = await db.oneOrNone(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='configuracion') AS ex`
  );
  if (!hasCfg || !hasCfg.ex) return { ran: false };

  const applied = await db.oneOrNone(
    `SELECT 1 FROM configuracion WHERE clave = $1 LIMIT 1`,
    [SCHEMA_PATCH_018_CLAVE]
  );
  if (applied) { logger.debug('Parche 018 ya aplicado'); return { ran: false, already: true }; }

  const upgradePath = path.join(migrationsDir, '018_cartera_missing_columns.sql');
  if (!fs.existsSync(upgradePath)) { logger.warn('Falta archivo de parche 018', { path: upgradePath }); return { ran: false }; }

  const sql = fs.readFileSync(upgradePath, 'utf8');
  logger.info('Aplicando parche 018: columnas faltantes cartera', { file: '018_cartera_missing_columns.sql' });

  await db.tx(async (t) => {
    await t.result(sql);
    await t.none(
      `INSERT INTO configuracion (clave, valor, categoria, descripcion)
       VALUES ($1, 'applied', 'sistema', 'Parche 018: actualizado_en en cuentas_cobrar/clientes + pagos_credito columnas')
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
      [SCHEMA_PATCH_018_CLAVE]
    );
  });

  return { ran: true };
}

/**
 * Helper genérico para aplicar un parche idempotente.
 * Centraliza la lógica de "leer marker → ejecutar SQL → marcar como aplicado"
 * para no duplicar 30 líneas de boilerplate por cada parche nuevo.
 */
async function aplicarParcheIdempotente(db, claveMarker, archivoSql, descripcion) {
  const hasCfg = await db.oneOrNone(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='configuracion') AS ex`
  );
  if (!hasCfg || !hasCfg.ex) return { ran: false };

  const applied = await db.oneOrNone(
    `SELECT 1 FROM configuracion WHERE clave = $1 LIMIT 1`,
    [claveMarker]
  );
  if (applied) {
    logger.debug(`Parche ${archivoSql} ya aplicado`);
    return { ran: false, already: true };
  }

  const upgradePath = path.join(migrationsDir, archivoSql);
  if (!fs.existsSync(upgradePath)) {
    logger.warn('Falta archivo de parche', { path: upgradePath });
    return { ran: false };
  }

  const sql = fs.readFileSync(upgradePath, 'utf8');
  logger.info('Aplicando parche', { file: archivoSql, descripcion });

  await db.tx(async (t) => {
    await t.result(sql);
    await t.none(
      `INSERT INTO configuracion (clave, valor, categoria, descripcion)
       VALUES ($1, 'applied', 'sistema', $2)
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
      [claveMarker, descripcion]
    );
  });

  return { ran: true };
}

async function runPatch019StockConstraints(db) {
  return aplicarParcheIdempotente(
    db, SCHEMA_PATCH_019_CLAVE,
    '019_stock_constraints.sql',
    'Parche 019: CHECK stock>=0 + guarda en trigger venta'
  );
}

async function runPatch020SesionesHuerfanas(db) {
  return aplicarParcheIdempotente(
    db, SCHEMA_PATCH_020_CLAVE,
    '020_sesiones_huerfanas.sql',
    'Parche 020: cierre automático de sesiones huérfanas'
  );
}

async function runPatch021IdempotencyVentas(db) {
  return aplicarParcheIdempotente(
    db, SCHEMA_PATCH_021_CLAVE,
    '021_idempotency_ventas.sql',
    'Parche 021: idempotency_key en ventas (anti doble-cobro)'
  );
}

async function runPatch022AnulacionCreditoReversa(db) {
  return aplicarParcheIdempotente(
    db, SCHEMA_PATCH_022_CLAVE,
    '022_anulacion_credito_reversa.sql',
    'Parche 022: estado anulada en cuentas_cobrar + índice'
  );
}

async function runPatch023RolesPermDashboardMerge(db) {
  return aplicarParcheIdempotente(
    db, SCHEMA_PATCH_023_CLAVE,
    '023_roles_perm_dashboard_merge.sql',
    'Parche 023: merge matriz permisos en roles sin clave dashboard'
  );
}

async function runPatch024FixIdempotencyIndex(db) {
  return aplicarParcheIdempotente(
    db, SCHEMA_PATCH_024_CLAVE,
    '024_fix_idempotency_index.sql',
    'Parche 024: índice idempotency_key por (usuario_id, key) en lugar de global'
  );
}

async function runPatch025UsuarioPermisosOverride(db) {
  return aplicarParcheIdempotente(
    db, SCHEMA_PATCH_025_CLAVE,
    '025_usuario_permisos_override.sql',
    'Parche 025: columna permisos_override por usuario'
  );
}

async function runPatch026QueryPerformanceIndexes(db) {
  return aplicarParcheIdempotente(
    db, SCHEMA_PATCH_026_CLAVE,
    '026_query_performance_indexes.sql',
    'Parche 026: índices ventas(estado,fecha), usuario_id, cashea liq_batch, detalles_prod_venta'
  );
}

async function runPatch027CasheaNivelesConfigExpress(db) {
  return aplicarParcheIdempotente(
    db, SCHEMA_PATCH_027_CLAVE,
    '027_cashea_niveles_y_config_express.sql',
    'Parche 027: cashea 6 niveles (semilla→araguaney), Express, día de pago configurable'
  );
}

async function runPatch028MonedaCostoProducto(db) {
  return aplicarParcheIdempotente(
    db, SCHEMA_PATCH_028_CLAVE,
    '028_moneda_costo_producto.sql',
    'Parche 028: metadato moneda_costo (usd_fisico|bcv) en productos y ajustes_inventario'
  );
}

async function runPatch029VentasTotalRefUsdBcv(db) {
  return aplicarParcheIdempotente(
    db, SCHEMA_PATCH_029_CLAVE,
    '029_ventas_total_ref_usd_bcv.sql',
    'Parche 029: ventas.total_ref_usd_bcv (TOTAL $ BCV histórico / cierres)'
  );
}

async function runPatch030VentasTasaBcvAplicada(db) {
  return aplicarParcheIdempotente(
    db, SCHEMA_PATCH_030_CLAVE,
    '030_ventas_tasa_bcv_aplicada.sql',
    'Parche 030: ventas.tasa_bcv_aplicada (BCV oficial al facturar)'
  );
}

async function runPatch031IdempotenciaIndiceReconciliar(db) {
  return aplicarParcheIdempotente(
    db, SCHEMA_PATCH_031_CLAVE,
    '031_idempotency_ventas_indice_reconciliar.sql',
    'Parche 031: índice idempotency ventas reconciliado por (usuario_id, idempotency_key)'
  );
}

async function runPatch032VentasCasheaPctInicialNumeric(db) {
  return aplicarParcheIdempotente(
    db, SCHEMA_PATCH_032_CLAVE,
    '032_ventas_cashea_pct_inicial_numeric.sql',
    'Parche 032: ventas_cashea.pct_inicial NUMERIC(5,2) (conserva decimales del % efectivo)'
  );
}

async function runPatch033CasheaTarifasComisionOficial(db) {
  return aplicarParcheIdempotente(
    db, SCHEMA_PATCH_033_CLAVE,
    '033_cashea_tarifas_comision_oficial.sql',
    'Parche 033: comisiones cashea_config alineadas a tarifas oficiales Base/Express por línea'
  );
}

async function runPatch034TasaBcvFeriadosVe2026(db) {
  return aplicarParcheIdempotente(
    db,
    SCHEMA_PATCH_034_CLAVE,
    '034_tasa_bcv_feriados_ve_2026.sql',
    'Parche 034: calendario feriados VE 2026 para tasa BCV automática'
  );
}

async function runPatch035NomenclaturaTasaUsdSinParalela(db) {
  return aplicarParcheIdempotente(
    db,
    SCHEMA_PATCH_035_CLAVE,
    '035_nomenclatura_tasa_usd_sin_paralela.sql',
    'Parche 035: clave tasa_usd única + trigger historial sin tasa_paralela'
  );
}

/**
 * Instalaciones existentes con admin ya personalizado: omitir paso 3 del wizard.
 */
async function runPatch036SetupAdminLegacy(db) {
  const marcador = await db.oneOrNone(
    `SELECT 1 AS ok FROM configuracion WHERE clave = $1 LIMIT 1`,
    [SCHEMA_PATCH_036_CLAVE]
  );
  if (marcador) {
    return { ran: false };
  }

  const admin = await db.oneOrNone(
    `SELECT id, password_hash FROM usuarios WHERE LOWER(TRIM(username)) = 'admin' LIMIT 1`
  );
  const { n: userCount } = await db.one(`SELECT COUNT(*)::int AS n FROM usuarios`);

  let marcarCompletado = false;
  if (admin && admin.password_hash !== ADMIN_DEFAULT_PASSWORD_HASH) {
    marcarCompletado = true;
  } else if (userCount > 1) {
    marcarCompletado = true;
  }

  await db.tx(async (t) => {
    if (marcarCompletado) {
      await t.none(
        `INSERT INTO configuracion (clave, valor, categoria, descripcion)
         VALUES ('setup_admin_completado', 'true', 'sistema',
                 'Administrador ya personalizado (parche legacy 036)')
         ON CONFLICT (clave) DO UPDATE SET valor = 'true', actualizado_en = NOW()`
      );
    }
    await t.none(
      `INSERT INTO configuracion (clave, valor, categoria, descripcion)
       VALUES ($1, '1', 'sistema', 'Parche 036: setup admin legacy aplicado')
       ON CONFLICT (clave) DO NOTHING`,
      [SCHEMA_PATCH_036_CLAVE]
    );
  });

  logger.info('Parche 036 aplicado: setup admin legacy', { marcarCompletado });
  return { ran: true, marcarCompletado };
}

async function runPatch037TotalBsBcvModoMoneda(db) {
  return aplicarParcheIdempotente(
    db,
    SCHEMA_PATCH_037_CLAVE,
    '037_total_bs_bcv_y_modo_moneda.sql',
    'Parche 037: ventas.total_bs_bcv_operativo + modo_moneda_operacion'
  );
}

async function runPatch038CasheaPctInicialSemilla60(db) {
  return aplicarParcheIdempotente(
    db,
    SCHEMA_PATCH_038_CLAVE,
    '038_cashea_pct_inicial_semilla_60.sql',
    'Parche 038: pct_inicial_semilla 60% (Lv1 Semilla; corrige default erróneo 1%)'
  );
}

/**
 * Cleanup al arrancar el backend: cerrar sesiones de caja huérfanas
 * (más de 24h abiertas sin cierre explícito).
 *
 * Se invoca DESPUÉS de aplicar el parche 020, que es el que crea la función SQL.
 * Si la función no existe (instalación antigua), simplemente no hace nada.
 */
async function cleanupSesionesHuerfanas(db, horasMaximas = 24) {
  const exists = await db.oneOrNone(
    `SELECT 1 FROM pg_proc WHERE proname = 'cerrar_sesiones_huerfanas' LIMIT 1`
  );
  if (!exists) {
    logger.debug('Función cerrar_sesiones_huerfanas no existe — cleanup omitido');
    return { cerradas: 0 };
  }

  const cerradas = await db.any(
    `SELECT * FROM cerrar_sesiones_huerfanas($1)`,
    [horasMaximas]
  );

  if (cerradas.length > 0) {
    logger.warn('Sesiones de caja huérfanas cerradas automáticamente', {
      cantidad: cerradas.length,
      ids: cerradas.map((s) => s.id),
      horasMaximas
    });
  }

  return { cerradas: cerradas.length, sesiones: cerradas };
}

/** Hash bcrypt de la contrasena por defecto `admin123` (debe coincidir con 004_seed_data.sql). */
const ADMIN_DEFAULT_PASSWORD_HASH =
  '$2a$10$YD93UDKrCaoufVSzuUh9/.RKBAYW3sTJObiKsplXK5O8gH2N/nN7a';

async function ensureRolAdminExiste(db) {
  const hasRoles = await db.oneOrNone(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'roles'
     ) AS ex`
  );
  if (!hasRoles || !hasRoles.ex) return;

  await db.none(
    `INSERT INTO roles (nombre, permisos)
     VALUES ('admin', '{"all":true}'::jsonb)
     ON CONFLICT (nombre) DO UPDATE SET permisos = '{"all":true}'::jsonb`
  );
}

/**
 * Garantiza rol «admin» en catálogo, usuario `admin` con ese rol y contraseña semilla si faltaba.
 * Si el usuario `admin` existe pero tenía otro rol (p. ej. vendedor), corrige `rol_id`.
 */
async function ensureSemillaAdminSiFalta(db) {
  const hasUsuarios = await db.oneOrNone(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'usuarios'
     ) AS ex`
  );
  if (!hasUsuarios || !hasUsuarios.ex) {
    return { ran: false };
  }

  await ensureRolAdminExiste(db);

  const rolAdmin = await db.oneOrNone(`SELECT id FROM roles WHERE nombre = 'admin' LIMIT 1`);
  if (!rolAdmin) {
    logger.error('ensureSemillaAdminSiFalta: no se pudo asegurar el rol admin.');
    return { ran: false };
  }

  const adminRow = await db.oneOrNone(
    `SELECT id, rol_id FROM usuarios WHERE LOWER(TRIM(username)) = 'admin' LIMIT 1`
  );

  if (!adminRow) {
    await db.none(
      `INSERT INTO usuarios (username, password_hash, nombre_completo, rol_id, activo)
       VALUES ('admin', $1, 'Administrador', $2, TRUE)`,
      [ADMIN_DEFAULT_PASSWORD_HASH, rolAdmin.id]
    );
    logger.warn(
      'Usuario admin creado automáticamente (no existía ninguno). Contraseña inicial: admin123 — cámbiela en producción.'
    );
    return { ran: true, created: true };
  }

  if (Number(adminRow.rol_id) !== Number(rolAdmin.id)) {
    await db.none(`UPDATE usuarios SET rol_id = $1 WHERE id = $2`, [rolAdmin.id, adminRow.id]);
    logger.warn(
      'Usuario admin: asignado al rol «admin» (antes tenía otro rol; faltaban opciones del menú).'
    );
    return { ran: true, repairedRol: true };
  }

  return { ran: false, already: true };
}

module.exports = {
  MARKER_TABLE,
  markerTableExists,
  migrationNumericPrefix,
  listAllMigrationSqlPaths,
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
  runPatch038CasheaPctInicialSemilla60,
  cleanupSesionesHuerfanas,
  ensureSemillaAdminSiFalta
};
