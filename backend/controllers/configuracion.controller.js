'use strict';

const { db } = require('../config/database');
const PreciosService = require('../services/preciosService');
const { asyncHandler, httpError } = require('../utils/asyncHandler');
const { clientIp } = require('../middleware/audit.middleware');

const CLAVES_EMPRESA = [
  'empresa_nombre','empresa_rif','empresa_telefono','empresa_direccion',
  'empresa_email','empresa_logo_url',
  'impresora_interfaz','impresora_nombre','impresora_activa',
  'pos_moneda_principal','pos_mostrar_bcv'
];

/* ─── GET /api/configuracion/tasas-actuales ─── */
async function getTasasActuales(req, res) {
  const rows = await db.any(
    `SELECT clave, valor FROM configuracion WHERE clave IN ('tasa_bcv', 'tasa_usd')`
  );
  const map = {};
  rows.forEach((r) => {
    map[r.clave] = r.valor;
  });
  const tasa_bcv = parseFloat(map.tasa_bcv) || 0;
  const tasa_usd = parseFloat(map.tasa_usd) || 0;
  res.json({
    tasa_bcv,
    tasa_usd,
    bcv: tasa_bcv,
    usd: tasa_usd
  });
}

/* ─── GET /api/configuracion ─── */
async function getAll(req, res) {
  const rows = await db.any(`SELECT clave, valor FROM configuracion ORDER BY clave`);
  const cfg = {};
  rows.forEach((r) => { cfg[r.clave] = r.valor; });
  res.json(cfg);
}

/* ─── PATCH /api/configuracion ─── */
async function updateGeneral(req, res) {
  const body = req.body || {};
  const updates = Object.entries(body).filter(([k]) => CLAVES_EMPRESA.includes(k));
  if (!updates.length) throw httpError(400, 'No hay parámetros válidos');

  await db.tx(async (t) => {
    for (const [clave, valor] of updates) {
      await t.none(
        `INSERT INTO configuracion (clave, valor, actualizado_en, actualizado_por)
         VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (clave) DO UPDATE
         SET valor = EXCLUDED.valor, actualizado_en = NOW(), actualizado_por = EXCLUDED.actualizado_por`,
        [clave, String(valor ?? ''), req.user?.id || null]
      );
    }
  });
  res.json({ ok: true });
}

/**
 * POST /api/configuracion/tasas
 * Body: { tasa_bcv, tasa_usd } o { bcv, usd }
 */
async function saveTasas(req, res) {
  const body = req.body || {};
  const rawBcv =
    body.tasa_bcv !== undefined && body.tasa_bcv !== null
      ? body.tasa_bcv
      : body.bcv;
  const rawUsd =
    body.tasa_usd !== undefined && body.tasa_usd !== null ? body.tasa_usd : body.usd;

  if (rawBcv === undefined || rawUsd === undefined) {
    throw httpError(400, 'Se requieren tasa_bcv y tasa_usd (o bcv y usd)');
  }

  const usuario_id = req.user && req.user.id ? Number(req.user.id) : null;
  if (!usuario_id || usuario_id < 1) {
    throw httpError(401, 'Usuario no autenticado');
  }

  const result = await PreciosService.actualizarTasas(db, rawBcv, rawUsd, usuario_id, clientIp(req));

  res.json({
    ok: true,
    tasa_bcv: result.tasa_bcv,
    tasa_usd: result.tasa_usd
  });
}

/** GET público para POS (vendedores sin config_read): % IVA de ventas. */
async function getImpuestoIvaVenta(req, res) {
  const pct = await PreciosService.leerImpuestoIvaPorcentaje(db);
  res.json({ impuesto_iva: pct });
}

module.exports = {
  getAll:            asyncHandler(getAll),
  getTasasActuales:  asyncHandler(getTasasActuales),
  getImpuestoIvaVenta: asyncHandler(getImpuestoIvaVenta),
  updateGeneral:     asyncHandler(updateGeneral),
  saveTasas:         asyncHandler(saveTasas)
};
