'use strict';

/**
 * Entrada única sistema legado NC-… — /api/license/*
 * Vercel Hobby: una función + rewrites en vercel.json.
 */

const { route } = require('../../lib/license/router');

const API_PREFIX = '/api/license';

module.exports = async function handler(req, res) {
  return route(req, res, API_PREFIX);
};
