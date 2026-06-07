'use strict';

/**
 * Entrada única del BFF del panel — /api/panel/*
 * Vercel Hobby: una función + rewrites en vercel.json (sin [...path].js).
 */

const { route } = require('../../lib/panel/router');

const API_PREFIX = '/api/panel';

module.exports = async function handler(req, res) {
  return route(req, res, API_PREFIX);
};
