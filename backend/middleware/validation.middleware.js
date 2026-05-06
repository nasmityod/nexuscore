'use strict';

function validationMiddleware(req, res, next) {
  next();
}

module.exports = { validationMiddleware };
