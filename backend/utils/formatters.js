'use strict';

function formatBs(value) {
  return Number(value || 0).toLocaleString('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

module.exports = { formatBs };
