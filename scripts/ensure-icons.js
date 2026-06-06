'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ico = path.join(__dirname, '..', 'build-resources', 'icon.ico');
if (!fs.existsSync(ico)) {
  console.log('Generando iconos (faltaba build-resources/icon.ico)...');
  execSync('node scripts/generate-app-icon.js', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
}
