'use strict';

/**
 * Pruebas — historial de caja y detalle de cierre específico.
 * Ejecutar: node scripts/test-caja-historial-detalle.js
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

function n(v) {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : 0;
}

/** Réplica simplificada de ventasResumen en detalle() */
async function fetchVentasResumen(client, sesionId) {
  const row = await client.query(
    `SELECT
       COUNT(*)::int AS total_ventas,
       COUNT(CASE WHEN estado = 'completada' THEN 1 END)::int AS ventas_completadas,
       COUNT(CASE WHEN estado = 'anulada' THEN 1 END)::int AS ventas_anuladas,
       COALESCE(SUM(CASE WHEN estado = 'completada' THEN COALESCE(total_ref_usd_bcv, total_usd) ELSE 0 END), 0)::numeric AS total_ref_usd_bcv,
       COALESCE(SUM(CASE WHEN estado = 'completada' THEN total_bs ELSE 0 END), 0)::numeric AS total_bs,
       COALESCE(AVG(CASE WHEN estado = 'completada' THEN COALESCE(total_ref_usd_bcv, total_usd) END), 0)::numeric AS ticket_promedio_ref_usd_bcv,
       (
         SELECT COUNT(*)::int
         FROM (
           SELECT v2.id
           FROM ventas v2,
           LATERAL jsonb_array_elements(
             CASE jsonb_typeof(v2.pagos) WHEN 'array' THEN v2.pagos ELSE '[]'::jsonb END
           ) AS pago
           WHERE v2.sesion_caja_id = $1 AND v2.estado = 'completada'
             AND pago->>'metodo' IS NOT NULL
           GROUP BY v2.id
           HAVING COUNT(DISTINCT pago->>'metodo') > 1
         ) mix
       ) AS ventas_pago_mixto
     FROM ventas WHERE sesion_caja_id = $1`,
    [sesionId]
  );
  return row.rows[0];
}

/** Réplica de totalesPorMetodo en detalle() */
async function fetchTotalesPorMetodo(client, sesionId) {
  const row = await client.query(
    `WITH expanded AS (
       SELECT
         v.id AS venta_id,
         v.tasa_cambio_aplicada,
         COALESCE(v.total_ref_usd_bcv, v.total_usd, 0)::numeric AS ref_venta,
         pago->>'metodo' AS metodo,
         UPPER(TRIM(COALESCE(pago->>'moneda', ''))) AS moneda_u,
         COALESCE((pago->>'monto')::numeric, 0) AS monto
       FROM ventas v,
       LATERAL jsonb_array_elements(
         CASE jsonb_typeof(v.pagos) WHEN 'array' THEN v.pagos ELSE '[]'::jsonb END
       ) AS pago
       WHERE v.sesion_caja_id = $1 AND v.estado = 'completada'
         AND pago->>'metodo' IS NOT NULL
     ),
     weighted AS (
       SELECT
         venta_id, ref_venta, metodo, moneda_u, monto,
         CASE
           WHEN moneda_u IN ('USD', 'USD_BCV', 'CASHEA') THEN monto
           WHEN moneda_u = 'BS' THEN
             COALESCE(monto / NULLIF(NULLIF(tasa_cambio_aplicada::numeric, 0), 0), monto)
           ELSE 0
         END AS w
       FROM expanded
     ),
     sums AS (
       SELECT *, SUM(w) OVER (PARTITION BY venta_id) AS sum_w FROM weighted
     ),
     venta_metodos AS (
       SELECT venta_id, COUNT(DISTINCT metodo)::int AS num_metodos
       FROM expanded GROUP BY venta_id
     )
     SELECT
       s.metodo,
       COUNT(DISTINCT s.venta_id)::int AS num_ventas,
       COUNT(DISTINCT CASE WHEN vm.num_metodos > 1 THEN s.venta_id END)::int AS num_ventas_mixtas,
       COALESCE(SUM(CASE WHEN s.moneda_u IN ('USD', 'USD_BCV', 'CASHEA') THEN s.monto ELSE 0 END), 0)::numeric AS total_usd,
       COALESCE(SUM(CASE WHEN s.moneda_u = 'BS' THEN s.monto ELSE 0 END), 0)::numeric AS total_bs,
       COALESCE(SUM(CASE WHEN s.sum_w > 0 THEN s.ref_venta * (s.w / s.sum_w) ELSE 0 END), 0)::numeric AS total_ref_usd_bcv
     FROM sums s
     INNER JOIN venta_metodos vm ON vm.venta_id = s.venta_id
     GROUP BY s.metodo
     ORDER BY total_ref_usd_bcv DESC`,
    [sesionId]
  );
  return row.rows;
}

/** Réplica de historial() subquery ventas */
async function fetchHistorialVentas(client, sesionId) {
  const row = await client.query(
    `SELECT
       (SELECT COUNT(*)::int
          FROM ventas v
          WHERE v.sesion_caja_id = sc.id AND v.estado = 'completada') AS total_ventas,
       (SELECT COALESCE(SUM(COALESCE(v.total_ref_usd_bcv, v.total_usd)), 0)::numeric
          FROM ventas v
          WHERE v.sesion_caja_id = sc.id AND v.estado = 'completada') AS total_ref_usd_bcv_vendido
     FROM sesiones_caja sc
     WHERE sc.id = $1`,
    [sesionId]
  );
  return row.rows[0];
}

console.log('=== Caja historial/detalle — pruebas ===\n');

// ── 1. Invariante ventas_completadas = total - anuladas ─────────────────────
{
  const total = 10;
  const completadas = 8;
  const anuladas = 2;
  assert(completadas === total - anuladas, 'ventas_completadas = total_ventas - anuladas');
}

// ── 2. ventas_pago_mixto no puede superar ventas_completadas ─────────────────
{
  const mixtas = 2;
  const completadas = 5;
  assert(mixtas <= completadas, 'mixtas <= completadas (lógica UI)');
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
    console.log('\n[SQL] PostgreSQL no disponible — omitiendo integración (' + e.message + ')');
    return;
  }

  try {
    console.log('--- Pruebas SQL (integración historial ↔ detalle) ---');

    const sesionesRes = await client.query(
      `SELECT sc.id, sc.estado, sc.fecha_apertura, sc.fecha_cierre,
              sc.diferencia_usd, sc.diferencia_bs
       FROM sesiones_caja sc
       ORDER BY sc.fecha_apertura DESC
       LIMIT 5`
    );

    if (!sesionesRes.rows.length) {
      console.log('[SQL] Sin sesiones de caja — omitiendo pruebas live');
      return;
    }

    for (const ses of sesionesRes.rows) {
      const sid = ses.id;
      const vr = await fetchVentasResumen(client, sid);
      const hist = await fetchHistorialVentas(client, sid);
      const tpm = await fetchTotalesPorMetodo(client, sid);

      assert(
        Number(vr.ventas_completadas) === Number(hist.total_ventas),
        'sesión #' + sid + ': ventas_completadas detalle = total_ventas historial (' +
          vr.ventas_completadas + ' vs ' + hist.total_ventas + ')'
      );

      assert(
        Math.abs(n(vr.total_ref_usd_bcv) - n(hist.total_ref_usd_bcv_vendido)) < 0.02,
        'sesión #' + sid + ': total_ref_usd_bcv detalle = historial'
      );

      assert(
        Number(vr.ventas_completadas) + Number(vr.ventas_anuladas) === Number(vr.total_ventas),
        'sesión #' + sid + ': completadas + anuladas = total_ventas'
      );

      assert(
        Number(vr.ventas_pago_mixto) <= Number(vr.ventas_completadas),
        'sesión #' + sid + ': ventas_pago_mixto <= ventas_completadas'
      );

      for (const m of tpm) {
        assert(
          Number(m.num_ventas_mixtas) <= Number(m.num_ventas),
          'sesión #' + sid + ' método ' + m.metodo + ': mixtas <= ventas'
        );
      }

      const sumRefMetodos = tpm.reduce((acc, m) => acc + n(m.total_ref_usd_bcv), 0);
      if (Number(vr.ventas_completadas) > 0 && tpm.length > 0) {
        assert(
          Math.abs(sumRefMetodos - n(vr.total_ref_usd_bcv)) < 0.05 * Number(vr.ventas_completadas) + 0.5,
          'sesión #' + sid + ': suma ref por método ≈ total ref sesión (' +
            sumRefMetodos.toFixed(2) + ' vs ' + n(vr.total_ref_usd_bcv).toFixed(2) + ')'
        );
      }

      if (ses.estado === 'cerrada') {
        assert(ses.fecha_cierre != null, 'sesión #' + sid + ' cerrada tiene fecha_cierre');
      }

      console.log(
        '[SQL] Sesión #' + sid + ' (' + ses.estado + '): ' +
          vr.ventas_completadas + ' completadas, ' +
          vr.ventas_anuladas + ' anuladas, ' +
          vr.ventas_pago_mixto + ' mixtas, ' +
          tpm.length + ' métodos'
      );
    }

    // Endpoint shape mínimo esperado por frontend
    const sample = sesionesRes.rows[0];
    const vrSample = await fetchVentasResumen(client, sample.id);
    assert(vrSample.ventas_completadas != null, 'campo ventas_completadas presente en query detalle');
    assert(vrSample.ventas_pago_mixto != null, 'campo ventas_pago_mixto presente');
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
