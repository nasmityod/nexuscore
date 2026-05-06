'use strict';

function isValidRif(rif) {
  return typeof rif === 'string' && rif.length >= 8;
}

module.exports = { isValidRif };
