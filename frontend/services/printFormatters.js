'use strict';

/** NEXUS-DUAL: backend/utils/formatters.js */
var PAGO_METODO_LABELS = {
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

function formatRefUsdBcv(value) {
  var x = Number(value);
  var n = Number.isFinite(x) ? x : 0;
  return n.toLocaleString('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatBolivares(value) {
  return 'Bs.\u00A0' + formatBs(value);
}

function formatUsdRef(value) {
  return 'USD\u00A0' + formatRefUsdBcv(value);
}

function formatTasaBcv(tasa) {
  var x = Number(tasa);
  if (!Number.isFinite(x) || x <= 0) return '—';
  var n = x.toLocaleString('es-VE', {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4
  });
  return 'Bs.\u00A0' + n + '\u00A0por\u00A0USD';
}

function labelMetodoPago(key) {
  if (key == null || key === '') return '—';
  var k = String(key).trim();
  if (PAGO_METODO_LABELS[k]) return PAGO_METODO_LABELS[k];
  return k.replace(/_/g, ' ');
}

window.NexusPrintFormatters = {
  PAGO_METODO_LABELS: PAGO_METODO_LABELS,
  formatBs: formatBs,
  formatRefUsdBcv: formatRefUsdBcv,
  formatBolivares: formatBolivares,
  formatUsdRef: formatUsdRef,
  formatTasaBcv: formatTasaBcv,
  labelMetodoPago: labelMetodoPago
};
