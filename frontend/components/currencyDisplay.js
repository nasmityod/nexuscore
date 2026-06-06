'use strict';

function currencyDisplay(usd, bs) {
  return { usd: usd, bs: bs };
}

/** Ref. $ BCV cadena — 2 decimales, locale es-VE. NEXUS-DUAL: backend/utils/formatters.js */
function formatRefUsdBcv(value) {
  var x = Number(value);
  var n = Number.isFinite(x) ? x : 0;
  return n.toLocaleString('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

window.NexusComponents = window.NexusComponents || {};
window.NexusComponents.currencyDisplay = currencyDisplay;
window.NexusComponents.formatRefUsdBcv = formatRefUsdBcv;
