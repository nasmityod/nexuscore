'use strict';

const { db } = require('../config/database');
const { logger } = require('../config/logger');
const { asyncHandler, httpError } = require('../utils/asyncHandler');
const { registrarAuditoria, clientIp } = require('../middleware/audit.middleware');
const SyncService = require('../services/syncService');
const PreciosService = require('../services/preciosService');
const { hasPermission } = require('../middleware/permissions.middleware');

/**
 * Suma cuota inicial Cashea de la sesión en Bs BCV (cobro en caja) y ref. $ BCV.
 * Prioriza inicialBsBcv / refInicialUsdBcv del JSON pagos; si faltan, aproxima con USD×BCV o BCV/Bs.
 */
async function sumCasheaInicialCobroCierre(sesionId, tasaBcvApertura) {
  const tasaParam =
    tasaBcvApertura != null && Number(tasaBcvApertura) > 0 ? Number(tasaBcvApertura) : null;
  const row = await db.one(
    `WITH tf AS (
       SELECT COALESCE(
         $2::numeric,
         (SELECT tasa_bcv FROM historial_tasas ORDER BY fecha DESC NULLS LAST LIMIT 1),
         0
       )::numeric AS t
     ),
     cp AS (
       SELECT
         COALESCE(
           vc.monto_inicial_usd::numeric,
           CASE
             WHEN jsonb_typeof(pago->'cashea_desglose') = 'object'
               AND (pago->'cashea_desglose' ? 'montoInicial')
               AND TRIM(COALESCE(pago->'cashea_desglose'->>'montoInicial', '')) <> ''
             THEN (pago->'cashea_desglose'->>'montoInicial')::numeric
             WHEN TRIM(COALESCE(pago->>'monto', '')) <> ''
             THEN (pago->>'monto')::numeric
             ELSE NULL
           END
         ) AS ini_usd,
         CASE
           WHEN jsonb_typeof(pago->'cashea_desglose') = 'object'
             AND (pago->'cashea_desglose' ? 'inicialBsBcv')
             AND TRIM(COALESCE(pago->'cashea_desglose'->>'inicialBsBcv', '')) <> ''
           THEN (pago->'cashea_desglose'->>'inicialBsBcv')::numeric
           ELSE NULL
         END AS ini_bs,
         CASE
           WHEN jsonb_typeof(pago->'cashea_desglose') = 'object'
             AND (pago->'cashea_desglose' ? 'refInicialUsdBcv')
             AND TRIM(COALESCE(pago->'cashea_desglose'->>'refInicialUsdBcv', '')) <> ''
           THEN (pago->'cashea_desglose'->>'refInicialUsdBcv')::numeric
           ELSE NULL
         END AS ref_bcv
       FROM ventas v
       LEFT JOIN ventas_cashea vc ON vc.venta_id = v.id
       , LATERAL jsonb_array_elements(
           CASE jsonb_typeof(v.pagos) WHEN 'array' THEN v.pagos ELSE '[]'::jsonb END
         ) AS pago
       WHERE v.sesion_caja_id = $1
         AND v.estado = 'completada'
         AND LOWER(TRIM(COALESCE(pago->>'metodo', ''))) = 'cashea'
         AND (vc.id IS NULL OR vc.estado_liquidacion <> 'ANULADA')
     )
     SELECT
       COALESCE((
         SELECT SUM(
           CASE
             WHEN cp.ini_bs IS NOT NULL AND cp.ini_bs > 0 THEN cp.ini_bs
             WHEN tf.t > 0 THEN ROUND((cp.ini_usd * tf.t)::numeric, 2)
             ELSE 0
           END
         )
         FROM cp CROSS JOIN tf
       ), 0)::numeric AS inicial_bs_bcv,
       COALESCE((
         SELECT SUM(
           CASE
             WHEN cp.ref_bcv IS NOT NULL AND cp.ref_bcv > 0 THEN cp.ref_bcv
             WHEN cp.ini_bs IS NOT NULL AND cp.ini_bs > 0 AND tf.t > 0
               THEN ROUND((cp.ini_bs / tf.t)::numeric, 2)
             ELSE cp.ini_usd
           END
         )
         FROM cp CROSS JOIN tf
       ), 0)::numeric AS ref_inicial_usd_bcv`,
    [sesionId, tasaParam]
  );
  return {
    inicialBsBcv: parseFloat(row.inicial_bs_bcv) || 0,
    refInicialUsdBcv: parseFloat(row.ref_inicial_usd_bcv) || 0
  };
}

// ─── GET /api/caja/sesion-activa ──────────────────────────────────────────────
async function sesionActiva(req, res) {
  // Buscar primero la sesión propia del usuario
  let sesion = await db.oneOrNone(
    `SELECT sc.*, c.nombre AS caja_nombre, u.nombre_completo AS cajero
     FROM sesiones_caja sc
     JOIN cajas c ON c.id = sc.caja_id
     JOIN usuarios u ON u.id = sc.usuario_id
     WHERE sc.estado = 'abierta' AND sc.fecha_cierre IS NULL AND sc.usuario_id = $1
     ORDER BY sc.fecha_apertura DESC LIMIT 1`,
    [req.user.id]
  );

  // Usuarios con pos_sales pero sin caja_operar (vendedores) pueden vender
  // usando cualquier sesión de caja abierta en el sistema.
  // Se les retorna la sesión disponible para que el POS les habilite el cobro.
  if (!sesion && !hasPermission(req.user, 'caja_operar') && hasPermission(req.user, 'pos_sales')) {
    sesion = await db.oneOrNone(
      `SELECT sc.*, c.nombre AS caja_nombre, u.nombre_completo AS cajero
       FROM sesiones_caja sc
       JOIN cajas c ON c.id = sc.caja_id
       JOIN usuarios u ON u.id = sc.usuario_id
       WHERE sc.estado = 'abierta' AND sc.fecha_cierre IS NULL
       ORDER BY sc.fecha_apertura DESC LIMIT 1`
    );
  }

  // Información secundaria: ¿hay cajas abiertas de OTROS usuarios?
  const otrasAbiertas = await db.any(
    `SELECT sc.id, sc.fecha_apertura, u.nombre_completo AS cajero, u.username
     FROM sesiones_caja sc
     JOIN usuarios u ON u.id = sc.usuario_id
     WHERE sc.estado = 'abierta' AND sc.fecha_cierre IS NULL AND sc.usuario_id != $1
     ORDER BY sc.fecha_apertura ASC`,
    [req.user.id]
  );

  res.json({
    sesion: sesion || null,
    abierta: !!sesion,
    otras_abiertas: otrasAbiertas
  });
}

// ─── GET /api/caja/sesiones-abiertas ──────────────────────────────────────────
// Lista TODAS las sesiones abiertas (cualquier usuario). Solo admin/supervisor.
async function listarAbiertas(req, res) {
  const rows = await db.any(
    `SELECT sc.id, sc.caja_id, sc.usuario_id, sc.fecha_apertura,
            sc.monto_inicial_usd, sc.monto_inicial_bs,
            sc.tasa_bcv_apertura, sc.tasa_usd_apertura,
            c.nombre AS caja_nombre,
            u.nombre_completo AS cajero, u.username,
            EXTRACT(EPOCH FROM (NOW() - sc.fecha_apertura))::int AS antiguedad_segundos
     FROM sesiones_caja sc
     JOIN cajas c ON c.id = sc.caja_id
     JOIN usuarios u ON u.id = sc.usuario_id
     WHERE sc.estado = 'abierta' AND sc.fecha_cierre IS NULL
     ORDER BY sc.fecha_apertura ASC`
  );
  res.json({ sesiones: rows });
}

// ─── POST /api/caja/forzar-cierre/:id ─────────────────────────────────────────
// Cierre forzado administrativo de sesiones huérfanas. Solo admin/supervisor.
async function forzarCierre(req, res) {
  const id = Number(req.params.id);
  if (!id || id < 1) throw httpError(400, 'ID de sesión inválido');

  const motivo = req.body && req.body.motivo
    ? String(req.body.motivo).trim().slice(0, 500)
    : 'Cierre forzado administrativo';

  const sesion = await db.oneOrNone(
    `SELECT * FROM sesiones_caja WHERE id = $1 AND estado = 'abierta' AND fecha_cierre IS NULL`,
    [id]
  );
  if (!sesion) throw httpError(404, 'Sesión no encontrada o ya cerrada');

  await db.none(
    `UPDATE sesiones_caja
        SET estado = 'cerrada',
            fecha_cierre = NOW(),
            cierre_forzado = TRUE,
            notas_cierre = COALESCE(notas_cierre || E'\n', '') || $2
      WHERE id = $1`,
    [id, motivo]
  );

  await registrarAuditoria(db, {
    usuario_id: req.user.id,
    accion: 'CIERRE_FORZADO_CAJA',
    tabla_afectada: 'sesiones_caja',
    registro_id: id,
    datos_anteriores: { estado: 'abierta', usuario_id: sesion.usuario_id },
    datos_nuevos: { estado: 'cerrada', motivo, forzado_por: req.user.id },
    ip_address: clientIp(req)
  });

  res.json({ ok: true, sesion_id: id, mensaje: 'Sesión cerrada forzosamente' });
}

// ─── POST /api/caja/abrir ─────────────────────────────────────────────────────
async function abrir(req, res) {
  const { monto_inicial_usd, monto_inicial_bs, tasa_bcv, tasa_usd, caja_id } = req.body;

  const sesionExistente = await db.oneOrNone(
    `SELECT id FROM sesiones_caja WHERE estado = 'abierta' AND fecha_cierre IS NULL AND usuario_id = $1`,
    [req.user.id]
  );
  if (sesionExistente) {
    throw httpError(409, 'Ya tienes una caja abierta. Ciérrala primero antes de abrir una nueva.');
  }

  let cajaIdFinal = caja_id ? Number(caja_id) : null;
  if (!cajaIdFinal || cajaIdFinal < 1) {
    let cajaDef = await db.oneOrNone(
      `SELECT id FROM cajas WHERE activa = TRUE ORDER BY id LIMIT 1`
    );
    if (!cajaDef) {
      await db.none(
        `INSERT INTO cajas (nombre, ubicacion, activa) VALUES ('Caja principal', 'Local', TRUE)`
      );
      cajaDef = await db.one(`SELECT id FROM cajas ORDER BY id ASC LIMIT 1`);
    }
    cajaIdFinal = cajaDef.id;
  }

  if (tasa_bcv != null && tasa_usd != null && String(tasa_bcv).trim() !== '' && String(tasa_usd).trim() !== '') {
    await PreciosService.actualizarTasas(db, tasa_bcv, tasa_usd, req.user.id, clientIp(req));
  }

  const tasas = await PreciosService.obtenerTasasActuales(db);

  const sesion = await db.one(
    `INSERT INTO sesiones_caja (
       caja_id, usuario_id,
       monto_inicial_usd, monto_inicial_bs,
       tasa_bcv_apertura, tasa_usd_apertura,
       tasa_dia, estado
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'abierta')
     RETURNING *`,
    [
      cajaIdFinal,
      req.user.id,
      parseFloat(monto_inicial_usd) || 0,
      parseFloat(monto_inicial_bs)  || 0,
      tasas.tasa_bcv,
      tasas.tasa_usd,
      tasas.tasa_usd   // tasa_dia (legacy, para compatibilidad)
    ]
  );

  res.status(201).json({ ok: true, sesion });
}

// ─── GET /api/caja/resumen-cierre ─────────────────────────────────────────────
// Devuelve todo lo necesario para que el cajero haga el arqueo:
//   • resumenDia: estadísticas generales
//   • montosEsperados: cuánto debería haber por cada método, en su moneda nativa
//   • totalesPorMetodo: tabla de detalle para mostrar en pantalla
async function resumenCierre(req, res) {
  const sesion = await db.oneOrNone(
    `SELECT sc.*, c.nombre AS caja_nombre
     FROM sesiones_caja sc
     JOIN cajas c ON c.id = sc.caja_id
     WHERE sc.estado = 'abierta' AND sc.fecha_cierre IS NULL AND sc.usuario_id = $1
     ORDER BY sc.fecha_apertura DESC LIMIT 1`,
    [req.user.id]
  );
  if (!sesion) {
    throw httpError(404, 'No tienes ninguna caja abierta en este momento');
  }

  // Estadísticas generales del día
  const resumenDia = await db.one(
    `SELECT
       COUNT(*)::int AS total_ventas,
       COALESCE(SUM(CASE WHEN estado = 'completada' THEN total_usd ELSE 0 END), 0)::numeric AS total_usd_vendido,
       COALESCE(SUM(CASE WHEN estado = 'completada' THEN COALESCE(total_ref_usd_bcv, total_usd) ELSE 0 END), 0)::numeric AS total_ref_usd_bcv_vendido,
       COALESCE(SUM(CASE WHEN estado = 'completada' THEN total_bs  ELSE 0 END), 0)::numeric AS total_bs_vendido,
       COUNT(CASE WHEN estado = 'anulada' THEN 1 END)::int AS ventas_anuladas,
       COALESCE(AVG(CASE WHEN estado = 'completada' THEN total_usd END), 0)::numeric AS ticket_promedio,
       COALESCE(AVG(CASE WHEN estado = 'completada' THEN COALESCE(total_ref_usd_bcv, total_usd) END), 0)::numeric AS ticket_promedio_ref_usd_bcv,
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
       ) AS ventas_pago_mixto
     FROM ventas
     WHERE sesion_caja_id = $1`,
    [sesion.id]
  );

  // Montos esperados leyendo el JSONB pagos directamente para precisión en ventas mixtas.
  // Acumula por nombre de método desde el array pagos de cada venta.
  const pagosResumen = await db.any(
    `SELECT
       pago->>'metodo' AS metodo,
       pago->>'moneda' AS moneda,
       COALESCE(SUM((pago->>'monto')::numeric), 0) AS total
     FROM ventas v,
     LATERAL jsonb_array_elements(
       CASE jsonb_typeof(v.pagos) WHEN 'array' THEN v.pagos ELSE '[]'::jsonb END
     ) AS pago
     WHERE v.sesion_caja_id = $1 AND v.estado = 'completada'
       AND pago->>'metodo' IS NOT NULL
     GROUP BY pago->>'metodo', pago->>'moneda'`,
    [sesion.id]
  );

  // Suma por método/moneda para construir montosEsperados.
  const pmMap = {};
  for (const r of pagosResumen) {
    const k = `${r.metodo}__${r.moneda}`;
    pmMap[k] = parseFloat(r.total) || 0;
  }
  const pm = (metodo, moneda) => pmMap[`${metodo}__${moneda}`] || 0;

  const scRow = await db.one(
    `SELECT monto_inicial_usd, monto_inicial_bs FROM sesiones_caja WHERE id = $1`,
    [sesion.id]
  );
  const montosEsperados = {
    efectivo_usd: parseFloat(scRow.monto_inicial_usd) + pm('efectivo_usd', 'USD'),
    efectivo_bs:  parseFloat(scRow.monto_inicial_bs)  + pm('efectivo_bs', 'BS'),
    zelle_usd:    pm('zelle', 'USD'),
    transferencia_bs: pm('transferencia_bs', 'BS'),
    pago_movil_bs: pm('pago_movil', 'BS'),
    punto_bs:     pm('punto', 'BS'),
    credito_usd_bcv: pm('credito', 'USD_BCV'),
  };

  // Desglose por método: USD calle en total_usd/total_bs; volumen cadena oficial por método
  // como reparto proporcional del total_ref_usd_bcv de cada venta (equiv. USD calle por línea).
  const totalesPorMetodo = await db.any(
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
         CASE jsonb_typeof(v.pagos)
           WHEN 'array' THEN v.pagos
           ELSE '[]'::jsonb
         END
       ) AS pago
       WHERE v.sesion_caja_id = $1 AND v.estado = 'completada'
         AND pago->>'metodo' IS NOT NULL
     ),
     weighted AS (
       SELECT
         venta_id,
         ref_venta,
         metodo,
         moneda_u,
         monto,
         CASE
           WHEN moneda_u IN ('USD', 'USD_BCV', 'CASHEA') THEN monto
           WHEN moneda_u = 'BS' THEN
             COALESCE(
               monto / NULLIF(NULLIF(tasa_cambio_aplicada::numeric, 0), 0),
               monto
             )
           ELSE 0
         END AS w
       FROM expanded
     ),
     sums AS (
       SELECT
         *,
         SUM(w) OVER (PARTITION BY venta_id) AS sum_w
       FROM weighted
     ),
     venta_metodos AS (
       SELECT venta_id, COUNT(DISTINCT metodo)::int AS num_metodos
       FROM expanded
       GROUP BY venta_id
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
    [sesion.id]
  );

  // Filtrar ventas_cashea excluyendo las anuladas para todos los totales de cierre.
  const casheaRow = await db.oneOrNone(
    `SELECT
       COALESCE(SUM(vc.monto_inicial_usd), 0)::numeric AS total_inicial_cobrado,
       COALESCE(SUM(vc.total_venta_usd), 0)::numeric AS total_ticket_usd,
       COALESCE(
         SUM(CASE WHEN vc.estado_liquidacion = 'PENDIENTE' THEN vc.monto_prestado_usd ELSE 0 END),
         0
       )::numeric AS total_prestado_pendiente,
       COALESCE(SUM(vc.total_comisiones_usd), 0)::numeric AS total_comisiones,
       COALESCE(SUM(vc.neto_liquidacion_usd), 0)::numeric AS neto_esperado_banco,
       COUNT(*)::int AS cantidad_ventas
     FROM ventas_cashea vc
     INNER JOIN ventas v ON v.id = vc.venta_id
     WHERE v.sesion_caja_id = $1
       AND v.estado = 'completada'
       AND vc.estado_liquidacion != 'ANULADA'`,
    [sesion.id]
  ) ?? {
    total_inicial_cobrado: 0,
    total_ticket_usd: 0,
    total_prestado_pendiente: 0,
    total_comisiones: 0,
    neto_esperado_banco: 0,
    cantidad_ventas: 0
  };

  // Cuota inicial Cashea en Bs BCV (cobro caja) y ref. $ BCV — alineado al POS / JSON desglose.
  const cobroCashea = await sumCasheaInicialCobroCierre(
    sesion.id,
    sesion.tasa_bcv_apertura
  );
  montosEsperados.cashea_inicial_bs_bcv = cobroCashea.inicialBsBcv;
  montosEsperados.cashea_inicial_ref_usd_bcv = cobroCashea.refInicialUsdBcv;
  // Libro USD (ventas_cashea); ya no se suma al esperado USD del cierre — el cuadre de inicial va en Bs BCV.
  montosEsperados.cashea_inicial_usd = parseFloat(casheaRow.total_inicial_cobrado) || 0;

  const ventasPorUsuario = await db.any(
    `SELECT
       v.usuario_id,
       u.nombre_completo,
       u.username,
       COUNT(*)::int AS cantidad_ventas,
       COALESCE(SUM(v.total_usd), 0)::numeric AS total_usd,
       COALESCE(SUM(COALESCE(v.total_ref_usd_bcv, v.total_usd)), 0)::numeric AS total_ref_usd_bcv
     FROM ventas v
     JOIN usuarios u ON u.id = v.usuario_id
     WHERE v.sesion_caja_id = $1 AND v.estado = 'completada'
     GROUP BY v.usuario_id, u.nombre_completo, u.username
     ORDER BY cantidad_ventas DESC, u.nombre_completo ASC`,
    [sesion.id]
  );

  res.json({
    sesion,
    resumenDia,
    montosEsperados,
    totalesPorMetodo,
    ventasPorUsuario: ventasPorUsuario.map((r) => ({
      usuario_id: Number(r.usuario_id),
      nombre_completo: r.nombre_completo || '',
      username: r.username || '',
      cantidad_ventas: Number(r.cantidad_ventas) || 0,
      total_usd: parseFloat(r.total_usd) || 0,
      total_ref_usd_bcv: parseFloat(r.total_ref_usd_bcv) || 0
    })),
    cashea: {
      totalInicialCobrado: parseFloat(casheaRow.total_inicial_cobrado),
      totalInicialBsBcv: cobroCashea.inicialBsBcv,
      totalInicialRefUsdBcv: cobroCashea.refInicialUsdBcv,
      totalTicketUsd: parseFloat(casheaRow.total_ticket_usd),
      totalPrestadoPendiente: parseFloat(casheaRow.total_prestado_pendiente),
      totalComisiones: parseFloat(casheaRow.total_comisiones),
      netoEsperadoBanco: parseFloat(casheaRow.neto_esperado_banco),
      cantidadVentas: Number(casheaRow.cantidad_ventas) || 0
    }
  });
}

// ─── POST /api/caja/cerrar ────────────────────────────────────────────────────
// Recibe el conteo físico del cajero, calcula las diferencias y cierra la sesión.
// Una vez cerrada, las ventas de esa sesión quedan bloqueadas (ver ventas.controller).
async function cerrar(req, res) {
  const {
    efectivo_usd_contado,
    efectivo_bs_contado,
    zelle_usd,
    cashea_inicial_bs_contado,
    transferencias_bs,
    pagos_moviles_bs,
    punto_bs,
    notas
  } = req.body;

  const sesion = await db.oneOrNone(
    `SELECT * FROM sesiones_caja WHERE estado = 'abierta' AND fecha_cierre IS NULL AND usuario_id = $1`,
    [req.user.id]
  );
  if (!sesion) {
    throw httpError(404, 'No tienes ninguna caja abierta para cerrar');
  }

  // Totales esperados del sistema leyendo JSONB pagos (preciso para ventas mixtas).
  const esperadoRows = await db.any(
    `SELECT
       pago->>'metodo' AS metodo,
       pago->>'moneda' AS moneda,
       COALESCE(SUM((pago->>'monto')::numeric), 0) AS total
     FROM ventas v,
     LATERAL jsonb_array_elements(
       CASE jsonb_typeof(v.pagos) WHEN 'array' THEN v.pagos ELSE '[]'::jsonb END
     ) AS pago
     WHERE v.sesion_caja_id = $1 AND v.estado = 'completada'
       AND pago->>'metodo' IS NOT NULL
     GROUP BY pago->>'metodo', pago->>'moneda'`,
    [sesion.id]
  );

  const espMap = {};
  for (const r of esperadoRows) {
    const k = `${r.metodo}__${r.moneda}`;
    espMap[k] = parseFloat(r.total) || 0;
  }
  const ep = (metodo, moneda) => espMap[`${metodo}__${moneda}`] || 0;

  const esperado = {
    efectivo_usd:     ep('efectivo_usd', 'USD'),
    zelle_usd:        ep('zelle', 'USD'),
    efectivo_bs:      ep('efectivo_bs', 'BS'),
    transferencia_bs: ep('transferencia_bs', 'BS'),
    pago_movil_bs:    ep('pago_movil', 'BS'),
    punto_bs:         ep('punto', 'BS'),
  };

  // Cuota inicial Cashea: se cuadra en Bs BCV (cobro en caja), no en USD.
  const cobroCasheaEsp = await sumCasheaInicialCobroCierre(
    sesion.id,
    sesion.tasa_bcv_apertura
  );
  const casheaInicialBsEsperado = cobroCasheaEsp.inicialBsBcv;

  // Conteos físicos ingresados por el cajero
  const usdCash  = parseFloat(efectivo_usd_contado) || 0;
  const zelleUsd = parseFloat(zelle_usd) || 0;
  const casheaInicialBsContado = Math.max(0, parseFloat(cashea_inicial_bs_contado) || 0);
  const bsCash   = parseFloat(efectivo_bs_contado) || 0;
  const bsTransf = parseFloat(transferencias_bs) || 0;
  const bsPm     = parseFloat(pagos_moviles_bs) || 0;
  const bsPunto  = parseFloat(punto_bs) || 0;

  // Esperado USD: apertura + ventas (sin cuota inicial Cashea — va en Bs BCV).
  const apertura = sesion;
  const esperadoUsdTotal = parseFloat(apertura.monto_inicial_usd || 0) +
    esperado.efectivo_usd +
    esperado.zelle_usd;
  const esperadoBsTotal  = parseFloat(apertura.monto_inicial_bs || 0) +
    esperado.efectivo_bs +
    esperado.transferencia_bs +
    esperado.pago_movil_bs +
    esperado.punto_bs +
    casheaInicialBsEsperado;

  // Diferencias: positivo = sobra, negativo = falta
  const difUsd = (usdCash + zelleUsd) - esperadoUsdTotal;
  const difBs  = (bsCash + bsTransf + bsPm + bsPunto + casheaInicialBsContado) - esperadoBsTotal;

  await db.none(
    `UPDATE sesiones_caja SET
       estado                     = 'cerrada',
       fecha_cierre               = NOW(),
       efectivo_usd_contado       = $1,
       efectivo_bs_contado        = $2,
       zelle_usd_contado          = $3,
       transferencias_bs_contado  = $4,
       pagos_moviles_bs_contado   = $5,
       punto_bs_contado           = $6,
       diferencia_usd             = $7,
       diferencia_bs              = $8,
       notas_cierre               = $9
     WHERE id = $10`,
    [usdCash, bsCash, zelleUsd, bsTransf, bsPm, bsPunto,
     difUsd, difBs, notas || null, sesion.id]
  );

  await registrarAuditoria(db, {
    usuario_id: req.user.id,
    accion: 'CERRAR_CAJA',
    tabla_afectada: 'sesiones_caja',
    registro_id: sesion.id,
    datos_nuevos: {
      diferencia_usd: difUsd,
      diferencia_bs: difBs,
      efectivo_usd_contado: usdCash,
      efectivo_bs_contado: bsCash,
      cashea_inicial_bs_contado: casheaInicialBsContado,
      cashea_inicial_bs_esperado: casheaInicialBsEsperado
    },
    ip_address: clientIp(req)
  });

  let backupOk = true;
  try {
    await SyncService.runFullBackup({ source: 'caja_cierre' });
  } catch (err) {
    backupOk = false;
    logger.error('Nexus caja: respaldo automático post-cierre fallido', {
      sesion_caja_id: sesion.id,
      err: err && err.message ? err.message : String(err)
    });
  }

  res.json({
    ok: true,
    backup_ok: backupOk,
    message: backupOk
      ? 'Caja cerrada correctamente. ¡Buen trabajo hoy!'
      : 'Caja cerrada. Avisar al administrador: el respaldo automático falló (revisar logs y NEXUS_BACKUP_DIR).',
    diferencias: {
      usd: difUsd,
      bs:  difBs,
      usd_estado: Math.abs(difUsd) < 0.50 ? 'cuadra' : (difUsd > 0 ? 'sobra' : 'falta'),
      bs_estado:  Math.abs(difBs)  < 1.00 ? 'cuadra' : (difBs  > 0 ? 'sobra' : 'falta')
    }
  });
}

// ─── GET /api/caja/historial ──────────────────────────────────────────────────
async function historial(req, res) {
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);

  const rows = await db.any(
    `SELECT
       sc.id, sc.fecha_apertura, sc.fecha_cierre, sc.estado,
       sc.monto_inicial_usd, sc.monto_inicial_bs,
       sc.diferencia_usd, sc.diferencia_bs,
       sc.notas_cierre,
       c.nombre AS caja_nombre,
       u.nombre_completo AS cajero,
       (SELECT COUNT(*)::int
          FROM ventas v
          WHERE v.sesion_caja_id = sc.id AND v.estado = 'completada') AS total_ventas,
       (SELECT COALESCE(SUM(COALESCE(v.total_ref_usd_bcv, v.total_usd)), 0)::numeric
          FROM ventas v
          WHERE v.sesion_caja_id = sc.id AND v.estado = 'completada') AS total_ref_usd_bcv_vendido,
       (SELECT COALESCE(SUM(v.total_usd), 0)::numeric
          FROM ventas v
          WHERE v.sesion_caja_id = sc.id AND v.estado = 'completada') AS total_usd_vendido
     FROM sesiones_caja sc
     JOIN cajas c ON c.id = sc.caja_id
     JOIN usuarios u ON u.id = sc.usuario_id
     ORDER BY sc.fecha_apertura DESC
     LIMIT $1`,
    [limit]
  );
  res.json(rows);
}

// ─── GET /api/caja/detalle/:id ────────────────────────────────────────────────
async function detalle(req, res) {
  const id = Number(req.params.id);
  if (!id || id < 1) throw httpError(400, 'ID de sesión inválido');

  const sesion = await db.oneOrNone(
    `SELECT sc.*, c.nombre AS caja_nombre, u.nombre_completo AS cajero
     FROM sesiones_caja sc
     JOIN cajas c ON c.id = sc.caja_id
     JOIN usuarios u ON u.id = sc.usuario_id
     WHERE sc.id = $1`,
    [id]
  );
  if (!sesion) throw httpError(404, 'Sesión de caja no encontrada');

  const ventasResumen = await db.one(
    `SELECT
       COUNT(*)::int AS total_ventas,
       COUNT(CASE WHEN estado = 'completada' THEN 1 END)::int AS ventas_completadas,
       COUNT(CASE WHEN estado = 'anulada' THEN 1 END)::int AS ventas_anuladas,
       COALESCE(SUM(CASE WHEN estado = 'completada' THEN total_usd ELSE 0 END), 0)::numeric AS total_usd,
       COALESCE(SUM(CASE WHEN estado = 'completada' THEN COALESCE(total_ref_usd_bcv, total_usd) ELSE 0 END), 0)::numeric AS total_ref_usd_bcv,
       COALESCE(SUM(CASE WHEN estado = 'completada' THEN total_bs  ELSE 0 END), 0)::numeric AS total_bs,
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
    [id]
  );

  // Desglose por método de pago (igual lógica que resumenCierre)
  const totalesPorMetodo = await db.any(
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
    [id]
  );

  // Ventas por usuario en esta sesión
  const ventasPorUsuario = await db.any(
    `SELECT
       v.usuario_id,
       u.nombre_completo,
       u.username,
       COUNT(*)::int AS cantidad_ventas,
       COALESCE(SUM(COALESCE(v.total_ref_usd_bcv, v.total_usd)), 0)::numeric AS total_ref_usd_bcv,
       COALESCE(SUM(v.total_bs), 0)::numeric AS total_bs
     FROM ventas v
     JOIN usuarios u ON u.id = v.usuario_id
     WHERE v.sesion_caja_id = $1 AND v.estado = 'completada'
     GROUP BY v.usuario_id, u.nombre_completo, u.username
     ORDER BY cantidad_ventas DESC, u.nombre_completo ASC`,
    [id]
  );

  // Detalle Cashea para la sesión
  const casheaRow = await db.oneOrNone(
    `SELECT
       COALESCE(SUM(vc.monto_inicial_usd), 0)::numeric AS total_inicial_cobrado,
       COALESCE(SUM(vc.total_venta_usd), 0)::numeric AS total_ticket_usd,
       COALESCE(SUM(CASE WHEN vc.estado_liquidacion = 'PENDIENTE' THEN vc.monto_prestado_usd ELSE 0 END), 0)::numeric AS total_prestado_pendiente,
       COALESCE(SUM(vc.total_comisiones_usd), 0)::numeric AS total_comisiones,
       COALESCE(SUM(vc.neto_liquidacion_usd), 0)::numeric AS neto_esperado_banco,
       COUNT(*)::int AS cantidad_ventas
     FROM ventas_cashea vc
     INNER JOIN ventas v ON v.id = vc.venta_id
     WHERE v.sesion_caja_id = $1
       AND v.estado = 'completada'
       AND vc.estado_liquidacion != 'ANULADA'`,
    [id]
  );

  const cobroCashea = await sumCasheaInicialCobroCierre(id, sesion.tasa_bcv_apertura);

  res.json({
    sesion,
    ventasResumen: {
      total_ventas: Number(ventasResumen.total_ventas) || 0,
      ventas_completadas: Number(ventasResumen.ventas_completadas) || 0,
      ventas_anuladas: Number(ventasResumen.ventas_anuladas) || 0,
      total_usd: parseFloat(ventasResumen.total_usd) || 0,
      total_ref_usd_bcv: parseFloat(ventasResumen.total_ref_usd_bcv) || 0,
      total_bs: parseFloat(ventasResumen.total_bs) || 0,
      ticket_promedio_ref_usd_bcv: parseFloat(ventasResumen.ticket_promedio_ref_usd_bcv) || 0,
      ventas_pago_mixto: Number(ventasResumen.ventas_pago_mixto) || 0
    },
    totalesPorMetodo: totalesPorMetodo.map((m) => ({
      metodo: m.metodo,
      num_ventas: Number(m.num_ventas) || 0,
      num_ventas_mixtas: Number(m.num_ventas_mixtas) || 0,
      total_usd: parseFloat(m.total_usd) || 0,
      total_bs: parseFloat(m.total_bs) || 0,
      total_ref_usd_bcv: parseFloat(m.total_ref_usd_bcv) || 0
    })),
    ventasPorUsuario: ventasPorUsuario.map((r) => ({
      usuario_id: Number(r.usuario_id),
      nombre_completo: r.nombre_completo || '',
      username: r.username || '',
      cantidad_ventas: Number(r.cantidad_ventas) || 0,
      total_ref_usd_bcv: parseFloat(r.total_ref_usd_bcv) || 0,
      total_bs: parseFloat(r.total_bs) || 0
    })),
    cashea: casheaRow && Number(casheaRow.cantidad_ventas) > 0
      ? {
          totalInicialCobrado: parseFloat(casheaRow.total_inicial_cobrado),
          totalInicialBsBcv: cobroCashea.inicialBsBcv,
          totalInicialRefUsdBcv: cobroCashea.refInicialUsdBcv,
          totalTicketUsd: parseFloat(casheaRow.total_ticket_usd),
          totalPrestadoPendiente: parseFloat(casheaRow.total_prestado_pendiente),
          totalComisiones: parseFloat(casheaRow.total_comisiones),
          netoEsperadoBanco: parseFloat(casheaRow.neto_esperado_banco),
          cantidadVentas: Number(casheaRow.cantidad_ventas)
        }
      : null
  });
}

module.exports = {
  sesionActiva:   asyncHandler(sesionActiva),
  abrir:          asyncHandler(abrir),
  resumenCierre:  asyncHandler(resumenCierre),
  cerrar:         asyncHandler(cerrar),
  historial:      asyncHandler(historial),
  detalle:        asyncHandler(detalle),
  listarAbiertas: asyncHandler(listarAbiertas),
  forzarCierre:   asyncHandler(forzarCierre)
};
