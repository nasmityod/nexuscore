'use strict';

const CasheaService = require('../services/casheaService');
const { asyncHandler, httpError } = require('../utils/asyncHandler');

function mapConfigResp(row) {
  if (!row) return null;
  // Soporta tanto el nombre post-027 (comision_base_sobre_total_pct)
  // como el legacy pre-027 (comision_base_pct) para instalaciones no actualizadas.
  const comisionBase = Number(row.comision_base_sobre_total_pct ?? row.comision_base_pct ?? 0);
  return {
    activo:                              row.activo !== false,
    comision_base_sobre_total_pct:       comisionBase,
    comision_express_sobre_financiado_pct: Number(
      row.comision_express_sobre_financiado_pct ?? row.pct_express ?? 0
    ),
    pct_inicial_semilla:                 CasheaService.normalizarPctSemilla(row.pct_inicial_semilla),
    pct_inicial_raiz:                    Number(row.pct_inicial_raiz     ?? 50),
    pct_inicial_hoja:                    Number(row.pct_inicial_hoja     ?? 40),
    pct_inicial_tronco:                  Number(row.pct_inicial_tronco   ?? 40),
    pct_inicial_arbol:                   Number(row.pct_inicial_arbol    ?? 40),
    pct_inicial_araguaney:               Number(row.pct_inicial_araguaney ?? 40),
    modo_express_activo:                 Boolean(row.modo_express_activo),
    dia_pago_semana:                     Number(row.dia_pago_semana ?? 3),
    linea_comercial:                     String(row.linea_comercial || 'Principal'),
    // alias legacy — para no romper código de frontend antiguo que lo lea
    pct_express:                         Number(row.pct_express ?? row.comision_express_sobre_financiado_pct ?? 0)
  };
}

async function getConfig(req, res) {
  const row = await CasheaService.obtenerConfig();
  const cfg = mapConfigResp(row);
  const tarifas = CasheaService.resolverTarifasComisionCashea(
    row || {},
    row && row.modo_express_activo
  );
  res.json({
    ...cfg,
    tarifasReferencia: CasheaService.listarTarifasCasheaReferencia(),
    comisionesAplicadas: {
      linea: tarifas.linea,
      modelo: tarifas.modelo,
      baseSobreTotalPct: tarifas.comisionBaseSobreTotalPct,
      expressSobreFinanciadoPct: tarifas.comisionExpressSobreFinanciadoPct,
      totalReferenciaAproxPct: tarifas.totalReferenciaAproxPct,
      tarifaOficialReferencia: tarifas.tarifaOficialReferencia || null
    }
  });
}

async function putConfig(req, res) {
  const row = await CasheaService.actualizarConfig(req.body || {});
  const cfg = mapConfigResp(row);
  const tarifas = CasheaService.resolverTarifasComisionCashea(
    row || {},
    row && row.modo_express_activo
  );
  res.json({
    ...cfg,
    comisionesAplicadas: {
      linea: tarifas.linea,
      modelo: tarifas.modelo,
      baseSobreTotalPct: tarifas.comisionBaseSobreTotalPct,
      expressSobreFinanciadoPct: tarifas.comisionExpressSobreFinanciadoPct,
      totalReferenciaAproxPct: tarifas.totalReferenciaAproxPct,
      tarifaOficialReferencia: tarifas.tarifaOficialReferencia || null
    }
  });
}

async function postCalcular(req, res) {
  try {
    const b = req.body || {};
    const totalVenta = Number(b.totalVenta);
    if (!Number.isFinite(totalVenta) || totalVenta <= 0) throw httpError(400, 'totalVenta inválido');

    // Aceptar tanto los 6 niveles nuevos (minúsculas) como los 3 legacy (mayúsculas)
    const NIVELES_NUEVOS = new Set(['semilla', 'raiz', 'hoja', 'tronco', 'arbol', 'araguaney']);
    const NIVELES_LEGACY = new Set(['BRONCE', 'PLATA', 'ORO']);
    const nivelRaw = String(b.nivelCliente || '').trim();
    const nivelLower = nivelRaw.toLowerCase();
    const nivelUpper = nivelRaw.toUpperCase();
    if (!NIVELES_NUEVOS.has(nivelLower) && !NIVELES_LEGACY.has(nivelUpper)) {
      throw httpError(400, 'nivelCliente inválido');
    }
    // Pasar en minúsculas para que el servicio lo normalice correctamente
    const nivelNorm = NIVELES_NUEVOS.has(nivelLower) ? nivelLower : nivelUpper;

    const opcionesBcv = {};
    const bsTot = b.totalVentaBsBcv ?? b.total_bs_bcv;
    const refTot = b.totalVentaUsdBcvRef ?? b.totalUsdBcvRef;

    if (
      bsTot !== undefined &&
      bsTot !== null &&
      String(bsTot).trim() !== '' &&
      Number.isFinite(Number(bsTot)) &&
      Number(bsTot) > 0
    ) {
      opcionesBcv.totalVentaBsBcv = Number(bsTot);
    }
    if (
      refTot !== undefined &&
      refTot !== null &&
      String(refTot).trim() !== '' &&
      Number.isFinite(Number(refTot)) &&
      Number(refTot) > 0
    ) {
      opcionesBcv.totalVentaUsdBcvRef = Number(refTot);
    }

    const credDisp =
      b.creditoDisponibleUsd ?? b.creditoCasheaDisponibleUsd ?? b.credito_cashea_disponible_usd;
    if (
      credDisp !== undefined &&
      credDisp !== null &&
      String(credDisp).trim() !== '' &&
      Number.isFinite(Number(credDisp)) &&
      Number(credDisp) >= 0
    ) {
      opcionesBcv.creditoDisponibleUsd = Number(credDisp);
    }

    const d = await CasheaService.calcularDesglose(
      totalVenta,
      nivelNorm,
      Boolean(b.modoExpress),
      b.pctExtra,
      Object.keys(opcionesBcv).length > 0 ? opcionesBcv : null
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

async function getEstadisticas(req, res) {
  const hoy = new Date();
  const inicioDefecto = new Date(hoy);
  const diaActual = hoy.getDay();
  // Inicio de semana = lunes (getDay: 0=Dom, 1=Lun, …)
  const diasDesdelunes = diaActual === 0 ? 6 : diaActual - 1;
  inicioDefecto.setDate(hoy.getDate() - diasDesdelunes);
  const finDefecto = new Date(inicioDefecto);
  finDefecto.setDate(inicioDefecto.getDate() + 6);

  const inicio = req.query.semanaInicio || inicioDefecto.toISOString().split('T')[0];
  const fin    = req.query.semanaFin    || finDefecto.toISOString().split('T')[0];

  const stats = await CasheaService.obtenerEstadisticasExpress(inicio, fin);
  res.json({ ok: true, data: stats });
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
  getEstadisticas: asyncHandler(getEstadisticas),
  getPendientes: asyncHandler(getPendientes),
  postLiquidar: asyncHandler(postLiquidar),
  listLiquidaciones: asyncHandler(listLiquidaciones),
  getLiquidacionById: asyncHandler(getLiquidacionById)
};
