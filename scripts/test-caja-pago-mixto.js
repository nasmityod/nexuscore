'use strict';

/**
 * Pruebas — desglose cierre de caja con pagos mixtos.
 * Ejecutar: node scripts/test-caja-pago-mixto.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client } = require('pg');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error('FAIL:', msg);
}

/** Réplica de frontend/pages/caja/caja.js — mantener alineada. */
function formatVentasMetodoCelda(m) {
  const nv = Number(m.num_ventas) || 0;
  const nvm = Number(m.num_ventas_mixtas) || 0;
  if (nv <= 0) return '0';
  if (nvm <= 0) return String(nv);
  const solo = nv - nvm;
  if (solo <= 0) {
    if (nv === 1) {
      return '1 <span class="caja-metodo-ventas-mixta" title="Esta venta se cobró con más de un método">mixta</span>';
    }
    return String(nv) + ' <span class="caja-metodo-ventas-mixta" title="Todas son ventas con más de un método">mixtas</span>';
  }
  const mixtaTxt = nvm === 1 ? '1 mixta' : nvm + ' mixtas';
  return String(solo) + ' + ' + mixtaTxt;
}

function textoNotaPagoMixto(cantidad, totalVentasCompletadas) {
  const nMix = Number(cantidad) || 0;
  if (nMix <= 0) return '';
  const ventasTxt = nMix === 1 ? '1 venta con pago mixto' : nMix + ' ventas con pago mixto';
  const totalTxt = Number(totalVentasCompletadas) || 0;
  const totalLabel = totalTxt === 1 ? '1 venta única' : totalTxt + ' ventas únicas';
  return (
    'Hubo ' + ventasTxt +
    ' (varios métodos en la misma venta). El total del día es ' + totalLabel +
    '; cada fila del desglose indica cuántas ventas usaron ese método — no sumes esa columna.'
  );
}

/** Simula venta_metodos + totalesPorMetodo (conteos, no montos). */
function simularConteosPorMetodo(ventas) {
  const expanded = [];
  for (const v of ventas) {
    if (v.estado !== 'completada') continue;
    const pagos = Array.isArray(v.pagos) ? v.pagos : [];
    for (const p of pagos) {
      if (!p || p.metodo == null) continue;
      expanded.push({ venta_id: v.id, metodo: p.metodo });
    }
  }
  const ventaMetodos = new Map();
  for (const row of expanded) {
    if (!ventaMetodos.has(row.venta_id)) ventaMetodos.set(row.venta_id, new Set());
    ventaMetodos.get(row.venta_id).add(row.metodo);
  }
  const byMetodo = new Map();
  for (const row of expanded) {
    const numMetodos = ventaMetodos.get(row.venta_id).size;
    if (!byMetodo.has(row.metodo)) {
      byMetodo.set(row.metodo, { ventas: new Set(), mixtas: new Set() });
    }
    const bucket = byMetodo.get(row.metodo);
    bucket.ventas.add(row.venta_id);
    if (numMetodos > 1) bucket.mixtas.add(row.venta_id);
  }
  return [...byMetodo.entries()].map(([metodo, b]) => ({
    metodo,
    num_ventas: b.ventas.size,
    num_ventas_mixtas: b.mixtas.size
  }));
}

function contarVentasPagoMixto(ventas) {
  const metodosPorVenta = new Map();
  for (const v of ventas) {
    if (v.estado !== 'completada') continue;
    const pagos = Array.isArray(v.pagos) ? v.pagos : [];
    const metodos = new Set();
    for (const p of pagos) {
      if (p && p.metodo != null) metodos.add(p.metodo);
    }
    if (metodos.size > 1) metodosPorVenta.set(v.id, metodos.size);
  }
  return metodosPorVenta.size;
}

console.log('=== Caja pago mixto — pruebas ===\n');

// ── 1. UI: celda solo mixta (caso usuario) ───────────────────────────────────
{
  const html = formatVentasMetodoCelda({ num_ventas: 1, num_ventas_mixtas: 1 });
  assert(html.indexOf('1') === 0, 'celda mixta empieza con 1');
  assert(html.indexOf('mixta') > 0, 'celda mixta incluye etiqueta mixta');
  assert(html.indexOf('mixtas') === -1, 'singular no dice mixtas');
}

// ── 2. UI: celda solo método único ───────────────────────────────────────────
{
  assert(formatVentasMetodoCelda({ num_ventas: 3, num_ventas_mixtas: 0 }) === '3', 'solo método → número plano');
}

// ── 3. UI: mezcla solo + mixta ───────────────────────────────────────────────
{
  assert(
    formatVentasMetodoCelda({ num_ventas: 4, num_ventas_mixtas: 2 }) === '2 + 2 mixtas',
    '4 ventas con 2 mixtas → 2 + 2 mixtas'
  );
}

// ── 4. UI: backend legacy sin num_ventas_mixtas ───────────────────────────────
{
  assert(formatVentasMetodoCelda({ num_ventas: 2 }) === '2', 'sin num_ventas_mixtas → fallback');
}

// ── 5. Nota: no mostrar si cero mixtas ───────────────────────────────────────
{
  assert(textoNotaPagoMixto(0, 5) === '', 'nota vacía sin mixtas');
}

// ── 6. Nota: texto caso usuario ───────────────────────────────────────────────
{
  const t = textoNotaPagoMixto(1, 1);
  assert(t.indexOf('1 venta con pago mixto') >= 0, 'nota menciona 1 mixta');
  assert(t.indexOf('1 venta única') >= 0, 'nota menciona 1 única');
  assert(t.indexOf('no sumes') >= 0, 'nota advierte no sumar columna');
}

// ── 7. Lógica conteo: una venta PM + Punto ───────────────────────────────────
{
  const ventas = [{
    id: 101,
    estado: 'completada',
    pagos: [
      { metodo: 'pago_movil', moneda: 'BS', monto: 26131.47 },
      { metodo: 'punto', moneda: 'BS', monto: 212 }
    ]
  }];
  assert(contarVentasPagoMixto(ventas) === 1, '1 venta mixta detectada');
  const tpm = simularConteosPorMetodo(ventas);
  const pm = tpm.find((r) => r.metodo === 'pago_movil');
  const pt = tpm.find((r) => r.metodo === 'punto');
  assert(pm && pm.num_ventas === 1 && pm.num_ventas_mixtas === 1, 'PM: 1 mixta');
  assert(pt && pt.num_ventas === 1 && pt.num_ventas_mixtas === 1, 'Punto: 1 mixta');
}

// ── 8. Mismo método dos veces NO es mixta ────────────────────────────────────
{
  const ventas = [{
    id: 102,
    estado: 'completada',
    pagos: [
      { metodo: 'pago_movil', moneda: 'BS', monto: 100 },
      { metodo: 'pago_movil', moneda: 'BS', monto: 50 }
    ]
  }];
  assert(contarVentasPagoMixto(ventas) === 0, 'doble línea mismo método ≠ mixta');
  const tpm = simularConteosPorMetodo(ventas);
  assert(tpm[0].num_ventas === 1 && tpm[0].num_ventas_mixtas === 0, 'PM doble línea: no mixta');
}

// ── 9. Tres ventas: 1 mixta + 2 simples ──────────────────────────────────────
{
  const ventas = [
    {
      id: 1,
      estado: 'completada',
      pagos: [
        { metodo: 'pago_movil', moneda: 'BS', monto: 10 },
        { metodo: 'punto', moneda: 'BS', monto: 5 }
      ]
    },
    { id: 2, estado: 'completada', pagos: [{ metodo: 'pago_movil', moneda: 'BS', monto: 20 }] },
    { id: 3, estado: 'completada', pagos: [{ metodo: 'punto', moneda: 'BS', monto: 30 }] }
  ];
  assert(contarVentasPagoMixto(ventas) === 1, '1 mixta entre 3 ventas');
  const tpm = simularConteosPorMetodo(ventas);
  const pm = tpm.find((r) => r.metodo === 'pago_movil');
  const pt = tpm.find((r) => r.metodo === 'punto');
  assert(pm.num_ventas === 2 && pm.num_ventas_mixtas === 1, 'PM: 2 ventas, 1 mixta');
  assert(pt.num_ventas === 2 && pt.num_ventas_mixtas === 1, 'Punto: 2 ventas, 1 mixta');
  assert(formatVentasMetodoCelda(pm) === '1 + 1 mixta', 'celda PM 1+1 mixta');
}

// ── 10. Anuladas no cuentan en mixtas ─────────────────────────────────────────
{
  const ventas = [{
    id: 200,
    estado: 'anulada',
    pagos: [
      { metodo: 'pago_movil', moneda: 'BS', monto: 10 },
      { metodo: 'punto', moneda: 'BS', monto: 5 }
    ]
  }];
  assert(contarVentasPagoMixto(ventas) === 0, 'anulada no cuenta mixta');
}

// ── 11. Invariante: num_ventas_mixtas <= num_ventas ───────────────────────────
{
  const ventas = [
    { id: 1, estado: 'completada', pagos: [{ metodo: 'zelle', moneda: 'USD', monto: 1 }, { metodo: 'efectivo_usd', moneda: 'USD', monto: 2 }] },
    { id: 2, estado: 'completada', pagos: [{ metodo: 'zelle', moneda: 'USD', monto: 3 }] },
    { id: 3, estado: 'completada', pagos: [{ metodo: 'efectivo_usd', moneda: 'USD', monto: 4 }, { metodo: 'zelle', moneda: 'USD', monto: 5 }] }
  ];
  for (const row of simularConteosPorMetodo(ventas)) {
    assert(row.num_ventas_mixtas <= row.num_ventas, 'mixtas <= ventas para ' + row.metodo);
  }
}

// ── 12. Montos: reparto proporcional suma el total ref de la venta ───────────
{
  const refVenta = 50;
  const pagos = [
    { moneda_u: 'BS', monto: 26131.47, tasa: 526.87 },
    { moneda_u: 'BS', monto: 212, tasa: 526.87 }
  ];
  const weighted = pagos.map((p) => ({
    w: p.monto / p.tasa,
    monto: p.monto
  }));
  const sumW = weighted.reduce((a, b) => a + b.w, 0);
  const parts = weighted.map((x) => refVenta * (x.w / sumW));
  const sumParts = parts.reduce((a, b) => a + b, 0);
  assert(Math.abs(sumParts - refVenta) < 0.02, 'reparto ref suma total venta');
  assert(Math.abs(parts[0] - 49.6) < 0.05, 'PM ~49.60 ref');
  assert(Math.abs(parts[1] - 0.4) < 0.05, 'Punto ~0.40 ref');
}

async function pruebaSqlIntegracion() {
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
    console.log('\n[SQL] PostgreSQL no disponible — omitiendo pruebas de integración (' + e.message + ')');
    return;
  }

  try {

  const sqlMixtas = `
    WITH datos AS (
      SELECT * FROM (VALUES
        (1, 'completada'::text, '[{"metodo":"pago_movil","moneda":"BS","monto":100},{"metodo":"punto","moneda":"BS","monto":50}]'::jsonb),
        (2, 'completada'::text, '[{"metodo":"pago_movil","moneda":"BS","monto":200}]'::jsonb),
        (3, 'anulada'::text, '[{"metodo":"pago_movil","moneda":"BS","monto":10},{"metodo":"punto","moneda":"BS","monto":5}]'::jsonb)
      ) AS t(id, estado, pagos)
    ),
    expanded AS (
      SELECT d.id AS venta_id, pago->>'metodo' AS metodo
      FROM datos d,
      LATERAL jsonb_array_elements(d.pagos) AS pago
      WHERE d.estado = 'completada' AND pago->>'metodo' IS NOT NULL
    ),
    venta_metodos AS (
      SELECT venta_id, COUNT(DISTINCT metodo)::int AS num_metodos
      FROM expanded GROUP BY venta_id
    ),
    mixto AS (
      SELECT COUNT(*)::int AS ventas_pago_mixto
      FROM venta_metodos WHERE num_metodos > 1
    ),
    por_metodo AS (
      SELECT
        e.metodo,
        COUNT(DISTINCT e.venta_id)::int AS num_ventas,
        COUNT(DISTINCT CASE WHEN vm.num_metodos > 1 THEN e.venta_id END)::int AS num_ventas_mixtas
      FROM expanded e
      JOIN venta_metodos vm ON vm.venta_id = e.venta_id
      GROUP BY e.metodo
    )
    SELECT
      (SELECT ventas_pago_mixto FROM mixto) AS ventas_pago_mixto,
      json_agg(por_metodo ORDER BY metodo) AS por_metodo
    FROM por_metodo`;

  console.log('\n--- Pruebas SQL (integración) ---');

  const row = await client.query(sqlMixtas);
  assert(Number(row.rows[0].ventas_pago_mixto) === 1, 'SQL: 1 venta mixta en dataset');
  const tpm = row.rows[0].por_metodo || [];
  const pm = tpm.find((r) => r.metodo === 'pago_movil');
  assert(pm && Number(pm.num_ventas) === 2 && Number(pm.num_ventas_mixtas) === 1, 'SQL: PM 2 ventas 1 mixta');
  const pt = tpm.find((r) => r.metodo === 'punto');
  assert(pt && Number(pt.num_ventas) === 1 && Number(pt.num_ventas_mixtas) === 1, 'SQL: Punto 1 mixta');

  const sesionRes = await client.query(
    `SELECT sc.id
     FROM sesiones_caja sc
     WHERE sc.estado = 'abierta'
     ORDER BY sc.fecha_apertura DESC
     LIMIT 1`
  );
  const sesion = sesionRes.rows[0];
  if (sesion) {
    const liveRes = await client.query(
      `SELECT
         (
           SELECT COUNT(*)::int
           FROM (
             SELECT v.id
             FROM ventas v,
             LATERAL jsonb_array_elements(
               CASE jsonb_typeof(v.pagos) WHEN 'array' THEN v.pagos ELSE '[]'::jsonb END
             ) AS pago
             WHERE v.sesion_caja_id = $1 AND v.estado = 'completada'
               AND pago->>'metodo' IS NOT NULL
             GROUP BY v.id
             HAVING COUNT(DISTINCT pago->>'metodo') > 1
           ) mix
         ) AS ventas_pago_mixto,
         COUNT(CASE WHEN estado = 'completada' THEN 1 END)::int AS completadas
       FROM ventas WHERE sesion_caja_id = $1`,
      [sesion.id]
    );
    const live = liveRes.rows[0];
    assert(
      Number(live.ventas_pago_mixto) <= Number(live.completadas),
      'SQL live: mixtas <= completadas (sesión ' + sesion.id + ')'
    );
    console.log('[SQL] Sesión abierta #' + sesion.id + ': ' + live.ventas_pago_mixto + ' mixtas / ' + live.completadas + ' completadas');
  } else {
    console.log('[SQL] Sin sesión abierta — omitiendo chequeo live');
  }
  } finally {
    await client.end();
  }
}

pruebaSqlIntegracion()
  .then(() => {
    console.log('\n=== Resultado: ' + passed + ' OK, ' + failed + ' FAIL ===');
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('\nError fatal:', err.message);
    process.exit(1);
  });
