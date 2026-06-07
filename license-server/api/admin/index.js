'use strict';

/**
 * Entrada única API admin — /api/admin/*
 * Vercel Hobby: una función + rewrites en vercel.json.
 */

const { route } = require('../../lib/admin/router');

const API_PREFIX = '/api/admin';

module.exports = async function handler(req, res) {
  return route(req, res, API_PREFIX);
};
