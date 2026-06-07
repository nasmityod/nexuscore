'use strict';

/**
 * Catch-all legado — /api/license/activate y /api/license/generate en una función.
 */

const { route } = require('../../lib/license/router');

module.exports = async function handler(req, res) {
  return route(req, res);
};
