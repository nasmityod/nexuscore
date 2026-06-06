'use strict';

function formatBs(value) {
  return Number(value || 0).toLocaleString('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

/** Ref. $ BCV cadena — 2 decimales, locale es-VE. NEXUS-DUAL: frontend/components/currencyDisplay.js */
function formatRefUsdBcv(value) {
  const x = Number(value);
  const n = Number.isFinite(x) ? x : 0;
  return n.toLocaleString('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

module.exports = { formatBs, formatRefUsdBcv };
