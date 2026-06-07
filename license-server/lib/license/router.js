'use strict';

const { pathSegments } = require('../pathSegments');
const { sendError } = require('../validate');

const activate = require('./handlers/activate');
const generate = require('./handlers/generate');

async function route(req, res, apiPrefix = '/api/license') {
  const segs = pathSegments(req, apiPrefix);
  const m = req.method;

  if (segs[0] === 'activate' && m === 'POST') return activate(req, res);
  if (segs[0] === 'generate' && m === 'POST') return generate(req, res);

  return sendError(res, 404, 'Ruta no encontrada.');
}

module.exports = { route };
