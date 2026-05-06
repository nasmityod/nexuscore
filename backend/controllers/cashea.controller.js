'use strict';

const CasheaService = require('../services/casheaService');
const { asyncHandler, httpError } = require('../utils/asyncHandler');

function mapConfigResp(row) {
  if (!row) return null;
  return {
    comision_base_pct: Number(row.comision_base_pct),
    pct_inicial_bronce: Number(row.pct_inicial_bronce),
    pct_inicial_plata: Number(row.pct_inicial_plata),
    pct_inicial_oro: Number(row.pct_inicial_oro),
    modo_express_activo: Boolean(row.modo_express_activo),
    pct_express: Number(row.pct_express),
    activo: row.activo !== false
  };
}

async function getConfig(req, res) {
  const row = await CasheaService.obtenerConfig();
  res.json(mapConfigResp(row));
}

async function putConfig(req, res) {
  const row = await CasheaService.actualizarConfig(req.body || {});
  res.json(mapConfigResp(row));
}

async function postCalcular(req, res) {
  try {
    const b = req.body || {};
    const totalVenta = Number(b.totalVenta);
    if (!Number.isFinite(totalVenta) || totalVenta <= 0) throw httpError(400, 'totalVenta inválido');
    const NIVELES_VALIDOS = ['BRONCE', 'PLATA', 'ORO'];
    const nivelCliente = String(b.nivelCliente || '').toUpperCase().trim();
    if (!NIVELES_VALIDOS.includes(nivelCliente)) {
      throw httpError(400, 'nivelCliente debe ser BRONCE, PLATA u ORO');
    }
    const d = await CasheaService.calcularDesglose(
      totalVenta,
      nivelCliente,
      Boolean(b.modoExpress),
      b.pctExtra
    );
    res.json(d);
  } catch (err) {
    if (err && err.status) throw err;
    const msg =
      typeof err.message === 'string' && err.message ? err.message : String(err || 'Error');
    if (msg.includes('inválido') || msg.includes('desactivada')) throw httpError(400, msg);
    throw httpError(500, msg);
  }
}

async function getPendientes(req, res) {
  try {
    const result = await CasheaService.obtenerResumenPendiente(
      req.query.fechaDesde,
      req.query.fechaHasta
    );
    res.json(result);
  } catch (err) {
    if (err && err.status) throw err;
    const msg =
      typeof err.message === 'string' && err.message ? err.message : String(err || 'Error');
    if (msg.includes('inválida') || msg.includes('juntas')) throw httpError(400, msg);
    throw err;
  }
}

async function postLiquidar(req, res) {
  const b = req.body || {};
  try {
    const result = await CasheaService.procesarLiquidacion({
      semanaInicio: b.semanaInicio,
      semanaFin: b.semanaFin,
      referenciaBancaria: b.referenciaBancaria,
      montoRecibido: b.montoRecibido,
      notasOpt: b.notas != null ? String(b.notas) : null
    });
    res.json(result);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e || '');
    if (
      msg.includes('inválid') ||
      msg.includes('deben') ||
      msg.includes('montoRecibido') ||
      msg.includes('fecha')
    ) {
      throw httpError(400, msg);
    }
    throw e;
  }
}

async function listLiquidaciones(req, res) {
  const result = await CasheaService.listarLiquidaciones(req.query.page, req.query.limit);
  res.json(result);
}

async function getLiquidacionById(req, res) {
  const detail = await CasheaService.detalleLiquidacion(req.params.id);
  if (!detail) throw httpError(404, 'Liquidación no encontrada');
  res.json(detail);
}

module.exports = {
  getConfig: asyncHandler(getConfig),
  putConfig: asyncHandler(putConfig),
  postCalcular: asyncHandler(postCalcular),
  getPendientes: asyncHandler(getPendientes),
  postLiquidar: asyncHandler(postLiquidar),
  listLiquidaciones: asyncHandler(listLiquidaciones),
  getLiquidacionById: asyncHandler(getLiquidacionById)
};
