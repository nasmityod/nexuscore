'use strict';

function redondear4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

module.exports = { redondear4 };
