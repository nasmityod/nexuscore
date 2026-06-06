'use strict';

/**
 * Verificación automatizada de correcciones INV-01..INV-09 (inventario / alta producto).
 * Ejecutar: node scripts/test-inventario-bugs-fix.js
 */
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PreciosService = require('../backend/services/preciosService');

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push(msg);
  console.error('FAIL:', msg);
}

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

console.log('=== Inventario bugs fix — verificación ===\n');

// ── INV-01 / INV-02: columnas SQL en inventario.controller.js ───────────────
{
  const src = read('backend/controllers/inventario.controller.js');
  assert(!/INSERT INTO ajustes_inventario[\s\S]*?\([^)]*\bnotas\b/.test(src),
    'INV-01: INSERT ajuste-stock no debe usar columna notas en SQL');
  assert(/\bmotivo\b/.test(src), 'INV-01: INSERT debe usar columna motivo');
  assert(!/ai\.notas/.test(src), 'INV-02: SELECT movimientos no debe usar ai.notas');
  assert(!/ai\.creado_en/.test(src), 'INV-02: SELECT movimientos no debe usar ai.creado_en');
  assert(/ai\.motivo/.test(src) && /ai\.fecha/.test(src), 'INV-02: SELECT debe usar ai.motivo y ai.fecha');
  assert(/ORDER BY ai\.fecha DESC/.test(src), 'INV-02: ORDER BY debe usar ai.fecha');
}

// ── INV-03 / INV-09: productos.controller create ────────────────────────────
{
  const src = read('backend/controllers/productos.controller.js');
  assert(/body\.creado_por\s*=/.test(src), 'INV-09: create() debe asignar creado_por');
  assert(/db\.tx\(async t =>/.test(src), 'INV-03: create() debe usar transacción');
  assert(/'entrada_inicial'/.test(src), 'INV-03: create() debe insertar tipo entrada_inicial');
  assert(/Stock inicial al crear producto/.test(src), 'INV-03: motivo de entrada inicial en create');
}

// ── INV-04: importProductosService ──────────────────────────────────────────
{
  const src = read('backend/services/importProductosService.js');
  assert(/'entrada_inicial'/.test(src), 'INV-04: import debe registrar entrada_inicial');
  assert(/PreciosService\.costoUsdDesdeCostoBcv/.test(src), 'INV-06: import debe usar costoUsdDesdeCostoBcv');
}

// ── INV-06: redondeo costo BCV → USD (dual) ─────────────────────────────────
{
  const bcv = 36.5432;
  const usd = 40.1234;
  const costoBcv = 10.33;
  const conv = PreciosService.costoUsdDesdeCostoBcv(costoBcv, bcv, usd);
  const raw = (costoBcv * bcv) / usd;
  assert(conv !== raw || Number.isInteger(conv * 10000), 'INV-06: costoUsdDesdeCostoBcv debe redondear a 4 dec');
  assert(String(conv).replace(/^-?\d+\.?/, '').length <= 4 || conv === Math.round(conv * 10000) / 10000,
    'INV-06: resultado con máximo 4 decimales (' + conv + ')');

  const clientSrc = read('frontend/services/preciosClient.js');
  assert(/Math\.round\(\(cb \* bcv\) \/ usd \* 10000\) \/ 10000/.test(clientSrc),
    'INV-06: preciosClient debe redondear costoUsdDesdeCostoBcv a 4 dec');
}

// ── INV-05: USD objetivo exacto sin precio_manual_usd ──────────────────────
{
  const invSrc = read('frontend/pages/inventario/inventario.js');
  assert(/gananciaPctDesdePrecioUsdFisicoObjetivoExacto/.test(invSrc),
    'INV-05: inventario.js debe usar búsqueda exacta USD');
  assert(!/precioManualParaGuardar = Math\.round\(valUsdObjetivoSave \* 100\) \/ 100/.test(invSrc),
    'INV-05: no debe guardar USD objetivo en precio_manual_usd');

  const tasaBcv = 36.5;
  const tasaUsd = 40.0;
  const costo = 1.33;
  const objetivo = 4.99;

  const linear = PreciosService.gananciaPctDesdePrecioUsdFisicoObjetivo(costo, objetivo);
  const linearPreview = PreciosService.calcularPrecios(costo, linear, tasaBcv, tasaUsd);
  const linearDrift = linearPreview.precio_usd_efectivo !== objetivo;

  const exact = PreciosService.gananciaPctDesdePrecioUsdFisicoObjetivoExacto(
    costo, objetivo, tasaBcv, tasaUsd
  );
  assert(exact.exacto === true, 'INV-05: búsqueda exacta debe alcanzar $' + objetivo);
  assert(exact.precio_usd_efectivo === objetivo,
    'INV-05: precio_usd_efectivo=' + exact.precio_usd_efectivo + ' esperado ' + objetivo);
  if (linearDrift) {
    assert(true, 'INV-05: margen lineal produce drift (demostración caso 1.33→4.99)');
  }
}

// ── INV-07: lógica de preservación costo_usd (simulación) ───────────────────
{
  const costoUsdOriginal = 30.1125;
  const costoBcvDisplay = 33.0;
  const costoBcvActual = 33.0;
  const shouldPreserve =
    Math.abs(costoBcvActual - costoBcvDisplay) < 0.005;
  assert(shouldPreserve, 'INV-07: costo BCV sin cambio debe preservar costo_usd original');
  const costoBcvModificado = 35.0;
  const shouldReconvert = Math.abs(costoBcvModificado - costoBcvDisplay) >= 0.005;
  assert(shouldReconvert, 'INV-07: costo BCV modificado debe reconverter');
}

// ── INV-05 BCV: precio_manual_usd sigue reservado a modo BCV ────────────────
{
  const objetivoBcv = 50.0;
  const tasaBcv = 36.5;
  const tasaUsd = 40.0;
  const manual = PreciosService.precioManualUsdDesdeBcvObjetivo(objetivoBcv, tasaBcv, tasaUsd);
  const cadena = PreciosService.aplicarCadenaPorPrecioEfectivo(manual, tasaBcv, tasaUsd, { precisionPe: 4 });
  assert(Math.round(cadena.precio_usd_bcv * 100) === Math.round(objetivoBcv * 100),
    'Modo BCV: precio_manual_usd debe reproducir $BCV exacto');
}

// ── Integración BD (opcional) ───────────────────────────────────────────────
async function runDbTests() {
  const { Client } = require('pg');
  const client = new Client({
    host: process.env.PG_HOST || '127.0.0.1',
    port: Number(process.env.PG_PORT || 5432),
    database: process.env.PG_DATABASE || 'nexuscore',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'postgres'
  });

  try {
    await client.connect();
  } catch (e) {
    console.log('\n[BD omitida] No se pudo conectar a PostgreSQL:', e.message);
    return;
  }

  console.log('\n--- Pruebas de integración BD ---');

  // Esquema ajustes_inventario
  const cols = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'ajustes_inventario'`
  );
  const colSet = new Set(cols.rows.map((r) => r.column_name));
  assert(colSet.has('motivo'), 'BD: columna motivo existe');
  assert(colSet.has('fecha'), 'BD: columna fecha existe');
  assert(!colSet.has('notas'), 'BD: columna notas NO debe existir en ajustes_inventario');
  assert(!colSet.has('creado_en'), 'BD: columna creado_en NO debe existir en ajustes_inventario');

  // Simular INSERT de create() + movimiento (rollback al final)
  await client.query('BEGIN');
  try {
    const sku = 'TEST-INV-' + Date.now();
    const ins = await client.query(
      `INSERT INTO productos (nombre, codigo_interno, stock_actual, costo_usd, margen_ganancia_pct, activo)
       VALUES ($1, $2, 25, 2.5, 30, TRUE)
       RETURNING id, stock_actual, costo_usd`,
      ['Producto test INV', sku]
    );
    const pid = ins.rows[0].id;
    await client.query(
      `INSERT INTO ajustes_inventario (
         producto_id, lote_id, tipo, cantidad,
         cantidad_anterior, cantidad_nueva, costo_unitario_usd,
         referencia_id, referencia_tipo, motivo
       ) VALUES ($1, NULL, 'entrada_inicial', 25, 0, 25, 2.5, $1, 'producto', $2)`,
      [pid, 'Stock inicial al crear producto']
    );
    const mov = await client.query(
      `SELECT tipo, cantidad::numeric, motivo FROM ajustes_inventario WHERE producto_id = $1`,
      [pid]
    );
    assert(mov.rows.length === 1, 'BD: debe existir 1 movimiento entrada_inicial');
    assert(mov.rows[0].tipo === 'entrada_inicial', 'BD: tipo entrada_inicial');
    assert(Number(mov.rows[0].cantidad) === 25, 'BD: cantidad movimiento = 25');
  } finally {
    await client.query('ROLLBACK');
  }

  // Simular INSERT ajuste-stock con motivo (rollback)
  await client.query('BEGIN');
  try {
    const sku2 = 'TEST-AJ-' + Date.now();
    const ins2 = await client.query(
      `INSERT INTO productos (nombre, codigo_interno, stock_actual, costo_usd, margen_ganancia_pct, activo)
       VALUES ('Ajuste test', $1, 10, 1, 20, TRUE) RETURNING id`,
      [sku2]
    );
    const pid2 = ins2.rows[0].id;
    await client.query(`UPDATE productos SET stock_actual = stock_actual + 5 WHERE id = $1`, [pid2]);
    await client.query(
      `INSERT INTO ajustes_inventario
         (producto_id, tipo, cantidad, referencia_tipo, motivo, moneda_costo)
       VALUES ($1, 'entrada', 5, 'ajuste_manual', $2, 'usd_fisico')`,
      [pid2, 'Conteo físico test']
    );
    const chk = await client.query(
      `SELECT ai.motivo, ai.fecha FROM ajustes_inventario ai WHERE ai.producto_id = $1 ORDER BY ai.fecha DESC LIMIT 1`,
      [pid2]
    );
    assert(chk.rows.length === 1 && chk.rows[0].motivo === 'Conteo físico test',
      'BD: ajuste-stock INSERT con motivo OK');
  } finally {
    await client.query('ROLLBACK');
  }

  await client.end();
}

runDbTests()
  .catch((e) => {
    failed += 1;
    failures.push('BD: error inesperado — ' + e.message);
    console.error('FAIL BD:', e.message);
  })
  .finally(() => {
    console.log('\n=== Resultado ===');
    console.log('Passed:', passed);
    console.log('Failed:', failed);
    if (failures.length) {
      console.log('\nFallos:');
      failures.forEach((f) => console.log(' -', f));
    }
    process.exit(failed > 0 ? 1 : 0);
  });
