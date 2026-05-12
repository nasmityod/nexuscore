'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { db } = require('../backend/config/database');

db.any(
  `SELECT clave, valor, actualizado_en FROM configuracion WHERE clave LIKE 'licencia%' ORDER BY clave`
)
  .then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  })
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
