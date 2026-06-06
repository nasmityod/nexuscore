'use strict';

const { httpError } = require('../utils/asyncHandler');

/** Saldo pendiente en ref. USD BCV (misma fórmula que dashboardService / cartera). */
const SALDO_BCV_SQL = `
  COALESCE(
    cc.monto_usd_bcv * cc.saldo_pendiente_usd / NULLIF(cc.monto_original_usd, 0),
    v.total_ref_usd_bcv * cc.saldo_pendiente_usd / NULLIF(v.total_usd, 0),
    cc.saldo_pendiente_usd
  )
`;

const METODOS_PAGO_BS = new Set(['efectivo_bs', 'transferencia_bs', 'pago_movil', 'punto']);
const METODOS_PAGO_USD_EFECTIVO = new Set(['efectivo_usd', 'zelle']);

function roundRefBcv2(v) {
  return Math.round(Number(v) * 100) / 100;
}

function round4(v) {
  return Math.round(Number(v) * 10000) / 10000;
}

function montoUsdEfectivoDesdeBcv(montoBcv, cuenta) {
  const bcv = Number(montoBcv);
  if (!bcv || bcv <= 0) return 0;
  const origBcv = Number(cuenta.monto_usd_bcv);
  const origUsd = Number(cuenta.monto_original_usd);
  if (origBcv > 0 && origUsd > 0) {
    return round4((bcv * origUsd) / origBcv);
  }
  const tasaBcv = Number(cuenta.tasa_bcv_pactada);
  const tasaUsd = Number(cuenta.tasa_usd_pactada);
  if (tasaBcv > 0 && tasaUsd > 0) {
    return round4((bcv * tasaBcv) / tasaUsd);
  }
  return round4(bcv);
}

function refBcvDesdeBs(montoBs, tasaBcv) {
  const bs = Number(montoBs);
  const tasa = Number(tasaBcv);
  if (!Number.isFinite(bs) || bs <= 0 || !Number.isFinite(tasa) || tasa <= 0) return 0;
  return roundRefBcv2(bs / tasa);
}

function refBcvDesdeUsdEfectivo(montoUsd, cuenta) {
  const usd = Number(montoUsd);
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  const saldoBcv = Number(cuenta.saldo_pendiente_bcv);
  const saldoUsd = Number(cuenta.saldo_pendiente_usd);
  if (Number.isFinite(saldoBcv) && saldoBcv > 0 && Number.isFinite(saldoUsd) && saldoUsd > 0) {
    return roundRefBcv2((usd * saldoBcv) / saldoUsd);
  }
  const origBcv = Number(cuenta.monto_usd_bcv);
  const origUsd = Number(cuenta.monto_original_usd);
  if (Number.isFinite(origBcv) && origBcv > 0 && Number.isFinite(origUsd) && origUsd > 0) {
    return roundRefBcv2((usd * origBcv) / origUsd);
  }
  // Fallback: sin proporción disponible, 1 USD = 1 ref BCV (cuenta antigua sin tasa pactada)
  return roundRefBcv2(usd);
}

async function leerTasaBcvActual(t) {
  const row = await t.oneOrNone(
    `SELECT valor FROM configuracion WHERE clave = 'tasa_bcv'`
  );
  return parseFloat(row?.valor) || 0;
}

/**
 * Resuelve el abono según método: Bs → ref. BCV → USD efectivo (servidor autoritativo).
 */
async function resolverMontoAbono(body, cuenta, t) {
  const metodo = String(body.metodo || 'efectivo_usd').trim();
  let montoBs = null;
  let tasaCambio = null;
  let refBcv = 0;
  let montoUsdEfectivo = 0;

  if (METODOS_PAGO_BS.has(metodo)) {
    montoBs = Number(body.monto_bs);
    if (!montoBs || montoBs <= 0) {
      throw httpError(400, 'Ingrese el monto recibido en bolívares');
    }
    tasaCambio = await leerTasaBcvActual(t);
    if (!tasaCambio || tasaCambio <= 0) {
      throw httpError(503, 'No hay tasa BCV vigente para convertir el pago en Bs');
    }
    refBcv = refBcvDesdeBs(montoBs, tasaCambio);
    montoUsdEfectivo = montoUsdEfectivoDesdeBcv(refBcv, cuenta);
  } else if (METODOS_PAGO_USD_EFECTIVO.has(metodo)) {
    montoUsdEfectivo = round4(body.monto_usd);
    if (!montoUsdEfectivo || montoUsdEfectivo <= 0) {
      throw httpError(400, 'Ingrese el monto en dólares efectivo');
    }
    refBcv = refBcvDesdeUsdEfectivo(montoUsdEfectivo, cuenta);
  } else if (Number(body.monto_usd_bcv) > 0) {
    refBcv = roundRefBcv2(body.monto_usd_bcv);
    montoUsdEfectivo = montoUsdEfectivoDesdeBcv(refBcv, cuenta);
  } else if (Number(body.monto_usd) > 0) {
    montoUsdEfectivo = round4(body.monto_usd);
    refBcv = refBcvDesdeUsdEfectivo(montoUsdEfectivo, cuenta);
  } else {
    throw httpError(400, 'El monto del abono debe ser mayor a cero');
  }

  if (!refBcv || refBcv <= 0 || !montoUsdEfectivo || montoUsdEfectivo <= 0) {
    throw httpError(400, 'No se pudo calcular el equivalente del abono');
  }

  return { metodo, refBcv, montoUsdEfectivo, montoBs, tasaCambio };
}

module.exports = {
  SALDO_BCV_SQL,
  METODOS_PAGO_BS,
  METODOS_PAGO_USD_EFECTIVO,
  resolverMontoAbono
};
