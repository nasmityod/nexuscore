'use strict';

/**
 * Cuentas por Pagar — Controladores HTTP.
 * Delega toda la lógica al servicio; no contiene negocio inline.
 */

const { asyncHandler, httpError } = require('../utils/asyncHandler');
const svc = require('../services/cuentasPagarService');

const resumen = asyncHandler(async (req, res) => {
  const data = await svc.resumen();
  res.json(data);
});

const listCuentas = asyncHandler(async (req, res) => {
  const { estado, proveedor_id, page, limit } = req.query;
  const data = await svc.listCuentas({ estado, proveedor_id, page, limit });
  res.json(data);
});

const crear = asyncHandler(async (req, res) => {
  const { proveedor_id, monto_usd, dias_credito, notas, numero_referencia } = req.body || {};
  if (!proveedor_id) throw httpError(400, 'proveedor_id es obligatorio');
  if (!monto_usd || Number(monto_usd) <= 0) throw httpError(400, 'monto_usd debe ser mayor a 0');

  const result = await svc.crear({
    proveedor_id,
    monto_usd,
    dias_credito,
    notas,
    numero_referencia,
    usuario_id: req.user?.id,
    ip_address: req.ip
  });
  res.status(201).json(result);
});

const abonar = asyncHandler(async (req, res) => {
  const cuentaId = Number(req.params.cuentaId);
  if (!cuentaId || cuentaId < 1) throw httpError(400, 'ID de cuenta inválido');

  const { monto_usd, monto_bs, tasa_cambio, metodo_pago, referencia, notas } = req.body || {};
  if (!monto_usd || Number(monto_usd) <= 0) throw httpError(400, 'monto_usd debe ser mayor a 0');

  const result = await svc.abonar({
    cuentaId,
    monto_usd,
    monto_bs,
    tasa_cambio,
    metodo_pago,
    referencia,
    notas,
    usuario_id: req.user?.id,
    ip_address: req.ip
  });
  res.json(result);
});

const historialPagos = asyncHandler(async (req, res) => {
  const cuentaId = Number(req.params.cuentaId);
  if (!cuentaId || cuentaId < 1) throw httpError(400, 'ID de cuenta inválido');
  const data = await svc.historialPagos(cuentaId);
  res.json(data);
});

const anular = asyncHandler(async (req, res) => {
  const cuentaId = Number(req.params.cuentaId);
  if (!cuentaId || cuentaId < 1) throw httpError(400, 'ID de cuenta inválido');
  const { motivo } = req.body || {};
  const result = await svc.anular(cuentaId, { motivo, usuario_id: req.user?.id, ip_address: req.ip });
  res.json(result);
});

module.exports = { resumen, listCuentas, crear, abonar, historialPagos, anular };
