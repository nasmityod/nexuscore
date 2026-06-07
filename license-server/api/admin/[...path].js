'use strict';

/**
 * Catch-all admin — una sola función para /api/admin/licenses/*, /api/admin/codes/*, etc.
 */

const { route } = require('../../lib/admin/router');

module.exports = async function handler(req, res) {
  return route(req, res);
};
