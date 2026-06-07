'use strict';

/** Etiquetas legibles para comprobantes impresos. NEXUS-DUAL: frontend/services/printFormatters.js */
const PAGO_METODO_LABELS = {
  efectivo_usd: 'Efectivo en dólares',
  efectivo_bs: 'Efectivo en bolívares',
  transferencia_bs: 'Transferencia bancaria',
  pago_movil: 'Pago móvil',
  zelle: 'Zelle',
  punto: 'Punto de venta',
  credito: 'Crédito',
  mixto: 'Pago mixto',
  cashea: 'Cashea'
};

function formatBs(value) {
  return Number(value || 0).toLocaleString('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

/** Ref. USD BCV — 2 decimales, locale es-VE. NEXUS-DUAL: frontend/services/printFormatters.js */
function formatRefUsdBcv(value) {
  const x = Number(value);
  const n = Number.isFinite(x) ? x : 0;
  return n.toLocaleString('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

/** Monto en bolívares con prefijo estándar venezolano: Bs. 1.250,00 */
function formatBolivares(value) {
  return `Bs.\u00A0${formatBs(value)}`;
}

/** Referencia USD BCV con prefijo explícito (sin confundir con montos en Bs.) */
function formatUsdRef(value) {
  return `USD\u00A0${formatRefUsdBcv(value)}`;
}

/** Tasa BCV para leyendas de comprobante */
function formatTasaBcv(tasa) {
  const x = Number(tasa);
  if (!Number.isFinite(x) || x <= 0) return '—';
  const n = x.toLocaleString('es-VE', {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4
  });
  return `Bs.\u00A0${n}\u00A0por\u00A0USD`;
}

function labelMetodoPago(key) {
  if (key == null || key === '') return '—';
  const k = String(key).trim();
  if (PAGO_METODO_LABELS[k]) return PAGO_METODO_LABELS[k];
  return k.replace(/_/g, ' ');
}

module.exports = {
  PAGO_METODO_LABELS,
  formatBs,
  formatRefUsdBcv,
  formatBolivares,
  formatUsdRef,
  formatTasaBcv,
  labelMetodoPago
};
