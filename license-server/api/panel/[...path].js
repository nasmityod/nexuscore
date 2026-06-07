'use strict';

/**
 * Catch-all del panel web — una sola Serverless Function para todo /api/panel/*
 * (límite Hobby: máx. 12 funciones por despliegue).
 */

const { route } = require('../../lib/panel/router');

module.exports = async function handler(req, res) {
  return route(req, res);
};
