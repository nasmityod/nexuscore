'use strict';

const { db } = require('../config/database');
const { asyncHandler, httpError } = require('../utils/asyncHandler');
const { registrarAuditoria, clientIp } = require('../middleware/audit.middleware');
const SyncService = require('../services/syncService');
const PreciosService = require('../services/preciosService');

// ─── GET /api/caja/sesion-activa ──────────────────────────────────────────────
async function sesionActiva(req, res) {
  const sesion = await db.oneOrNone(
    `SELECT sc.*, c.nombre AS caja_nombre, u.nombre_completo AS cajero
     FROM sesiones_caja sc
     JOIN cajas c ON c.id = sc.caja_id
     JOIN usuarios u ON u.id = sc.usuario_id
     WHERE sc.estado = 'abierta' AND sc.fecha_cierre IS NULL AND sc.usuario_id = $1
     ORDER BY sc.fecha_apertura DESC LIMIT 1`,
    [req.user.id]
  );

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
       COALESCE(SUM(CASE WHEN estado = 'completada' THEN total_bs  ELSE 0 END), 0)::numeric AS total_bs_vendido,
       COUNT(CASE WHEN estado = 'anulada' THEN 1 END)::int AS ventas_anuladas,
       COALESCE(AVG(CASE WHEN estado = 'completada' THEN total_usd END), 0)::numeric AS ticket_promedio
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

  // Desglose por método leyendo el JSONB pagos (preciso para ventas mixtas).
  // Para ventas no mixtas el JSONB tiene un solo elemento; para mixtas, varios.
  const totalesPorMetodo = await db.any(
    `SELECT
       pago->>'metodo' AS metodo,
       COUNT(DISTINCT v.id)::int AS num_ventas,
       COALESCE(SUM(
         CASE WHEN (pago->>'moneda') IN ('USD','USD_BCV','cashea')
              THEN (pago->>'monto')::numeric ELSE 0 END
       ), 0)::numeric AS total_usd_pagado,
       COALESCE(SUM(
         CASE WHEN (pago->>'moneda') = 'BS'
              THEN (pago->>'monto')::numeric ELSE 0 END
       ), 0)::numeric AS total_bs_pagado
     FROM ventas v,
     LATERAL jsonb_array_elements(
       CASE jsonb_typeof(v.pagos)
         WHEN 'array' THEN v.pagos
         ELSE '[]'::jsonb
       END
     ) AS pago
     WHERE v.sesion_caja_id = $1 AND v.estado = 'completada'
       AND pago->>'metodo' IS NOT NULL
     GROUP BY pago->>'metodo'
     ORDER BY total_usd_pagado DESC`,
    [sesion.id]
  );

  const casheaRow = await db.oneOrNone(
    `SELECT
       COALESCE(SUM(vc.monto_inicial_usd), 0)::numeric AS total_inicial_cobrado,
       COALESCE(
         SUM(CASE WHEN vc.estado_liquidacion = 'PENDIENTE' THEN vc.monto_prestado_usd ELSE 0 END),
         0
       )::numeric AS total_prestado_pendiente,
       COALESCE(SUM(vc.total_comisiones_usd), 0)::numeric AS total_comisiones,
       COALESCE(SUM(vc.neto_liquidacion_usd), 0)::numeric AS neto_esperado_banco,
       COUNT(*)::int AS cantidad_ventas
     FROM ventas_cashea vc
     INNER JOIN ventas v ON v.id = vc.venta_id
     WHERE v.sesion_caja_id = $1 AND v.estado = 'completada'`,
    [sesion.id]
  ) ?? {
    total_inicial_cobrado: 0,
    total_prestado_pendiente: 0,
    total_comisiones: 0,
    neto_esperado_banco: 0,
    cantidad_ventas: 0
  };

  res.json({
    sesion,
    resumenDia,
    montosEsperados,
    totalesPorMetodo,
    cashea: {
      totalInicialCobrado: parseFloat(casheaRow.total_inicial_cobrado),
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

  // Conteos físicos ingresados por el cajero
  const usdCash  = parseFloat(efectivo_usd_contado) || 0;
  const zelleUsd = parseFloat(zelle_usd) || 0;
  const bsCash   = parseFloat(efectivo_bs_contado) || 0;
  const bsTransf = parseFloat(transferencias_bs) || 0;
  const bsPm     = parseFloat(pagos_moviles_bs) || 0;
  const bsPunto  = parseFloat(punto_bs) || 0;

  // Esperado del sistema: ventas + saldo inicial de apertura
  const apertura = sesion;
  const esperadoUsdTotal = parseFloat(apertura.monto_inicial_usd || 0) +
    esperado.efectivo_usd +
    esperado.zelle_usd;
  const esperadoBsTotal  = parseFloat(apertura.monto_inicial_bs || 0) +
    esperado.efectivo_bs +
    esperado.transferencia_bs +
    esperado.pago_movil_bs +
    esperado.punto_bs;

  // Diferencias: positivo = sobra, negativo = falta
  const difUsd = (usdCash + zelleUsd) - esperadoUsdTotal;
  const difBs  = (bsCash + bsTransf + bsPm + bsPunto) - esperadoBsTotal;

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
      efectivo_bs_contado: bsCash
    },
    ip_address: clientIp(req)
  });

  // Respaldo automático al cerrar caja
  SyncService.runFullBackup({ source: 'caja_cierre' }).catch(() => {});

  res.json({
    ok: true,
    message: 'Caja cerrada correctamente. ¡Buen trabajo hoy!',
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
       (SELECT COALESCE(SUM(total_usd), 0)::numeric
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
       COUNT(CASE WHEN estado = 'anulada' THEN 1 END)::int AS ventas_anuladas,
       COALESCE(SUM(CASE WHEN estado = 'completada' THEN total_usd ELSE 0 END), 0)::numeric AS total_usd,
       COALESCE(SUM(CASE WHEN estado = 'completada' THEN total_bs  ELSE 0 END), 0)::numeric AS total_bs
     FROM ventas WHERE sesion_caja_id = $1`,
    [id]
  );

  res.json({ sesion, ventasResumen });
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
