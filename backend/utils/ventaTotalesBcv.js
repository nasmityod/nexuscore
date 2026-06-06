'use strict';

const PreciosService = require('../services/preciosService');

function round4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

/**
 * Totales BCV para ticket/PDF/impresión (coherente con cobro POS).
 * @param {object} venta fila ventas
 * @returns {{ tasaBcv: number, totalRefUsdBcv: number|null, totalBsBcv: number|null }}
 */
function resolveTotalesBcvTicket(venta) {
  if (!venta) {
    return { tasaBcv: 0, totalRefUsdBcv: null, totalBsBcv: null };
  }

  const tasaBcv = Number(venta.tasa_bcv_aplicada) || 0;
  let totalRefUsdBcv = Number(venta.total_ref_usd_bcv);
  if (!Number.isFinite(totalRefUsdBcv) || totalRefUsdBcv <= 0) {
    totalRefUsdBcv = null;
  } else {
    totalRefUsdBcv = round4(totalRefUsdBcv);
  }

  let totalBsBcv = Number(venta.total_bs_bcv_operativo);
  if (!Number.isFinite(totalBsBcv) || totalBsBcv <= 0) {
    totalBsBcv = null;
  }

  if (totalBsBcv == null && totalRefUsdBcv != null && tasaBcv > 0) {
    try {
      totalBsBcv = PreciosService.totalBolivaresDesdeRefUsdBcv(totalRefUsdBcv, tasaBcv);
    } catch (_e) {
      totalBsBcv = null;
    }
  }

  return { tasaBcv, totalRefUsdBcv, totalBsBcv };
}

/**
 * Línea de detalle con precios ref. USD BCV (2 dec) para comprobantes.
 */
function mapDetalleLineaUsdBcv(d, tasaBcv, tasaCalle) {
  const pu = Number(d.precio_unitario_usd);
  const cantidad = Number(d.cantidad);
  const disc = Number(d.descuento_porcentaje) || 0;
  let precioUsdBcv = pu;
  let subtotalUsdBcv = Number(d.subtotal_usd);

  if (pu > 0 && tasaBcv > 0 && tasaCalle > 0) {
    try {
      const chain = PreciosService.aplicarCadenaPorPrecioEfectivo(pu, tasaBcv, tasaCalle, { precisionPe: 4 });
      precioUsdBcv = chain.precio_usd_bcv;
      subtotalUsdBcv = round4(cantidad * precioUsdBcv * (1 - disc / 100));
    } catch (_e) {
      /* conservar valores almacenados */
    }
  }

  return {
    descripcion: d.producto_nombre || d.descripcion || 'Ítem',
    cantidad,
    precio_unitario_usd: precioUsdBcv,
    subtotal_usd: subtotalUsdBcv
  };
}

module.exports = {
  resolveTotalesBcvTicket,
  mapDetalleLineaUsdBcv,
  round4
};
