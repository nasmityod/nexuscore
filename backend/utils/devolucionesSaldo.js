'use strict';

const PreciosService = require('../services/preciosService');
const { lineaMontosBcvRef, round4 } = require('./ventaTotalesBcv');

function parseLineasJson(lineas) {
  if (Array.isArray(lineas)) return lineas;
  try {
    return JSON.parse(lineas || '[]');
  } catch {
    return [];
  }
}

/**
 * Cantidades ya devueltas por producto_id (devoluciones no anuladas de la venta).
 * @param {object} tOrDb pg-promise transaction o db
 * @param {number} ventaId
 * @returns {Promise<Map<number, number>>}
 */
async function loadDevolucionesPreviasMap(tOrDb, ventaId) {
  const rows = await tOrDb.any(
    `SELECT lineas FROM devoluciones WHERE venta_id = $1 AND estado != 'anulada'`,
    [ventaId]
  );
  const map = new Map();
  for (const row of rows) {
    for (const l of parseLineasJson(row.lineas)) {
      const pid = Number(l.producto_id);
      const qty = Number(l.cantidad) || 0;
      if (!pid || pid < 1 || !(qty > 0)) continue;
      map.set(pid, (map.get(pid) || 0) + qty);
    }
  }
  return map;
}

/**
 * Saldo devolvable por línea de venta.
 * @param {Array} detalles filas detalles_ventas
 * @param {Map<number, number>} prevMap
 */
function buildSaldoPorDetalle(detalles, prevMap) {
  const vendidaPorPid = new Map();
  for (const d of detalles) {
    const pid = Number(d.producto_id);
    if (!pid || pid < 1) continue;
    const qty = Number(d.cantidad) || 0;
    vendidaPorPid.set(pid, (vendidaPorPid.get(pid) || 0) + qty);
  }

  const saldos = [];
  let hayPendiente = false;
  for (const [pid, vendida] of vendidaPorPid) {
    const devuelta = prevMap.get(pid) || 0;
    const pendiente = Math.max(0, Math.round((vendida - devuelta) * 1000) / 1000);
    if (pendiente > 0) hayPendiente = true;
    saldos.push({
      producto_id: pid,
      cantidad_vendida: vendida,
      cantidad_devuelta: devuelta,
      cantidad_pendiente: pendiente
    });
  }
  return { saldos, hayPendiente };
}

async function resolverTasaBcvVenta(tOrDb, venta) {
  const directa = Number(venta.tasa_bcv_aplicada) || 0;
  if (directa > 0 || !venta.fecha_venta) return directa;
  const ht = await tOrDb.oneOrNone(
    `SELECT tasa_bcv FROM historial_tasas WHERE fecha = ($1::timestamp)::date LIMIT 1`,
    [venta.fecha_venta]
  );
  return ht && ht.tasa_bcv != null ? Number(ht.tasa_bcv) : 0;
}

/**
 * Total Bs BCV de la devolución (misma cadena que ticket / POS).
 */
function calcularTotalBsDevolucion(lineasNorm, venta, detallesVenta) {
  const tasaBcv = Number(venta.tasa_bcv_aplicada) || 0;
  if (!(tasaBcv > 0) || !lineasNorm.length) return 0;

  const sumSubtotalesUsd = detallesVenta.reduce(
    (s, d) => s + (Number(d.subtotal_usd) || 0),
    0
  );

  const subBcvPorPid = new Map();
  const cantVendidaPorPid = new Map();
  for (const det of detallesVenta) {
    const pid = Number(det.producto_id);
    if (!pid || pid < 1) continue;
    const { subBcv } = lineaMontosBcvRef(det, venta, sumSubtotalesUsd);
    subBcvPorPid.set(pid, (subBcvPorPid.get(pid) || 0) + (subBcv || 0));
    cantVendidaPorPid.set(pid, (cantVendidaPorPid.get(pid) || 0) + (Number(det.cantidad) || 0));
  }

  let totalRefBcv = 0;
  for (const l of lineasNorm) {
    const pid = Number(l.producto_id);
    const subBcvTotal = subBcvPorPid.get(pid) || 0;
    const cantVendida = cantVendidaPorPid.get(pid) || 0;
    if (cantVendida > 0 && subBcvTotal > 0) {
      totalRefBcv += round4((Number(l.cantidad) / cantVendida) * subBcvTotal);
    }
  }
  totalRefBcv = round4(totalRefBcv);
  if (!(totalRefBcv > 0)) return 0;
  try {
    return PreciosService.totalBolivaresDesdeRefUsdBcv(totalRefBcv, tasaBcv);
  } catch {
    return 0;
  }
}

module.exports = {
  loadDevolucionesPreviasMap,
  buildSaldoPorDetalle,
  resolverTasaBcvVenta,
  calcularTotalBsDevolucion
};
