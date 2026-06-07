'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const ADMIN_MAP = [
  ['api/admin/licenses/index.js', 'lib/admin/handlers/licenses-list.js'],
  ['api/admin/licenses/create.js', 'lib/admin/handlers/licenses-create.js'],
  ['api/admin/licenses/trial.js', 'lib/admin/handlers/licenses-trial.js'],
  ['api/admin/licenses/[key]/index.js', 'lib/admin/handlers/licenses-detail.js'],
  ['api/admin/licenses/[key]/status.js', 'lib/admin/handlers/licenses-status.js'],
  ['api/admin/licenses/[key]/extend.js', 'lib/admin/handlers/licenses-extend.js'],
  ['api/admin/licenses/[key]/activations/[hwid].js', 'lib/admin/handlers/licenses-activation-delete.js'],
  ['api/admin/codes/list.js', 'lib/admin/handlers/codes-list.js'],
  ['api/admin/codes/create.js', 'lib/admin/handlers/codes-create.js'],
  ['api/admin/codes/revoke.js', 'lib/admin/handlers/codes-revoke.js'],
  ['api/admin/diagnostics/key-fingerprint.js', 'lib/admin/handlers/diagnostics-key-fingerprint.js']
];

const PANEL_MAP = [
  ['api/panel/auth/login.js', 'lib/panel/handlers/auth-login.js'],
  ['api/panel/auth/logout.js', 'lib/panel/handlers/auth-logout.js'],
  ['api/panel/auth/session.js', 'lib/panel/handlers/auth-session.js'],
  ['api/panel/health.js', 'lib/panel/handlers/health.js'],
  ['api/panel/stats.js', 'lib/panel/handlers/stats.js'],
  ['api/panel/licenses/index.js', 'lib/panel/handlers/licenses-list.js'],
  ['api/panel/licenses/create.js', 'lib/panel/handlers/licenses-create.js'],
  ['api/panel/licenses/trial.js', 'lib/panel/handlers/licenses-trial.js'],
  ['api/panel/licenses/[key]/index.js', 'lib/panel/handlers/licenses-detail.js'],
  ['api/panel/licenses/[key]/status.js', 'lib/panel/handlers/licenses-status.js'],
  ['api/panel/licenses/[key]/extend.js', 'lib/panel/handlers/licenses-extend.js'],
  ['api/panel/licenses/[key]/activations/[hwid].js', 'lib/panel/handlers/licenses-activation-delete.js']
];

const LICENSE_MAP = [
  ['api/license/activate.js', 'lib/license/handlers/activate.js'],
  ['api/license/generate.js', 'lib/license/handlers/generate.js']
];

function fixPanel(content) {
  return content
    .replace(/\.\.\/\.\.\/\.\.\/\.\.\/lib\/panel\//g, '../')
    .replace(/\.\.\/\.\.\/\.\.\/lib\/panel\//g, '../')
    .replace(/\.\.\/\.\.\/lib\/panel\//g, '../')
    .replace(/require\('\.\.\/\.\.\/(session|upstream|respond)'\)/g, "require('../$1')");
}

function fixAdmin(content) {
  return content
    .replace(/\.\.\/\.\.\/\.\.\/\.\.\/lib\//g, '../../')
    .replace(/\.\.\/\.\.\/\.\.\/lib\//g, '../../')
    .replace(/require\('\.\.\/\.\.\/\.\.\/(licenses|validate|logger|kv|crypto|ratelimit)'\)/g, "require('../../$1')");
}

function fixLicense(content) {
  return content.replace(/\.\.\/\.\.\/lib\//g, '../../');
}

function migrate(map, fixer) {
  for (const [src, dst] of map) {
    const srcPath = path.join(root, src);
    const dstPath = path.join(root, dst);
    if (!fs.existsSync(srcPath)) {
      console.warn('SKIP missing', src);
      continue;
    }
    let content = fs.readFileSync(srcPath, 'utf8');
    content = fixer(content);
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    fs.writeFileSync(dstPath, content);
    console.log('OK', dst);
  }
}

function rm(rel) {
  const p = path.join(root, rel);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
    console.log('DEL', rel);
  }
}

migrate(PANEL_MAP, fixPanel);
migrate(ADMIN_MAP, fixAdmin);
migrate(LICENSE_MAP, fixLicense);

rm('api/panel/auth');
rm('api/panel/licenses');
rm('api/panel/health.js');
rm('api/panel/stats.js');
rm('api/admin/licenses');
rm('api/admin/codes');
rm('api/admin/diagnostics');
rm('api/license/activate.js');
rm('api/license/generate.js');
rm('api/panel/[...path].js');
rm('api/admin/[...path].js');
rm('api/license/[...path].js');

console.log('DONE');
