'use strict';

const { pathSegments } = require('../pathSegments');
const { sendError } = require('./respond');

const H = {
  authLogin: require('./handlers/auth-login'),
  authLogout: require('./handlers/auth-logout'),
  authSession: require('./handlers/auth-session'),
  health: require('./handlers/health'),
  stats: require('./handlers/stats'),
  licensesList: require('./handlers/licenses-list'),
  licensesCreate: require('./handlers/licenses-create'),
  licensesTrial: require('./handlers/licenses-trial'),
  licensesDetail: require('./handlers/licenses-detail'),
  licensesStatus: require('./handlers/licenses-status'),
  licensesExtend: require('./handlers/licenses-extend'),
  licensesActivationDelete: require('./handlers/licenses-activation-delete')
};

function withKey(req, key) {
  req.query = { ...(req.query || {}), key: String(key || '').trim().toUpperCase() };
}

function withKeyHwid(req, key, hwid) {
  req.query = {
    ...(req.query || {}),
    key: String(key || '').trim().toUpperCase(),
    hwid: String(hwid || '').trim()
  };
}

async function route(req, res) {
  const segs = pathSegments(req);
  const m = req.method;

  if (segs[0] === 'auth' && segs[1] === 'login' && m === 'POST') return H.authLogin(req, res);
  if (segs[0] === 'auth' && segs[1] === 'logout' && m === 'POST') return H.authLogout(req, res);
  if (segs[0] === 'auth' && segs[1] === 'session' && m === 'GET') return H.authSession(req, res);

  if (segs[0] === 'health' && segs.length === 1 && m === 'GET') return H.health(req, res);
  if (segs[0] === 'stats' && segs.length === 1 && m === 'GET') return H.stats(req, res);

  if (segs[0] === 'licenses') {
    if (segs.length === 1 && m === 'GET') return H.licensesList(req, res);
    if (segs[1] === 'create' && m === 'POST') return H.licensesCreate(req, res);
    if (segs[1] === 'trial' && m === 'POST') return H.licensesTrial(req, res);
    if (segs.length === 2 && m === 'GET') {
      withKey(req, segs[1]);
      return H.licensesDetail(req, res);
    }
    if (segs.length === 3 && segs[2] === 'status' && (m === 'PUT' || m === 'PATCH')) {
      withKey(req, segs[1]);
      return H.licensesStatus(req, res);
    }
    if (segs.length === 3 && segs[2] === 'extend' && (m === 'PUT' || m === 'PATCH')) {
      withKey(req, segs[1]);
      return H.licensesExtend(req, res);
    }
    if (segs.length === 4 && segs[2] === 'activations' && m === 'DELETE') {
      withKeyHwid(req, segs[1], segs[3]);
      return H.licensesActivationDelete(req, res);
    }
  }

  return sendError(res, 404, 'Ruta del panel no encontrada.');
}

module.exports = { route };
