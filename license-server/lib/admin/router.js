'use strict';

const L = require('../licenses');
const { pathSegments } = require('../pathSegments');
const { sendError } = require('../validate');

const H = {
  licensesList: require('./handlers/licenses-list'),
  licensesCreate: require('./handlers/licenses-create'),
  licensesTrial: require('./handlers/licenses-trial'),
  licensesDetail: require('./handlers/licenses-detail'),
  licensesStatus: require('./handlers/licenses-status'),
  licensesExtend: require('./handlers/licenses-extend'),
  licensesActivationDelete: require('./handlers/licenses-activation-delete'),
  codesList: require('./handlers/codes-list'),
  codesCreate: require('./handlers/codes-create'),
  codesRevoke: require('./handlers/codes-revoke'),
  diagnosticsKeyFingerprint: require('./handlers/diagnostics-key-fingerprint')
};

const STATIC_LICENSE = new Set(['create', 'trial']);

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

  if (segs[0] === 'licenses') {
    if (segs.length === 1 && m === 'GET') return H.licensesList(req, res);
    if (segs[1] === 'create' && m === 'POST') return H.licensesCreate(req, res);
    if (segs[1] === 'trial' && m === 'POST') return H.licensesTrial(req, res);
    if (segs.length === 2 && !STATIC_LICENSE.has(segs[1]) && m === 'GET') {
      withKey(req, segs[1]);
      if (!L.isValidKeyFormat(req.query.key)) return sendError(res, 400, 'Formato de licencia inválido.');
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

  if (segs[0] === 'codes') {
    if (segs[1] === 'list' && m === 'GET') return H.codesList(req, res);
    if (segs[1] === 'create' && m === 'POST') return H.codesCreate(req, res);
    if (segs[1] === 'revoke' && m === 'POST') return H.codesRevoke(req, res);
  }

  if (segs[0] === 'diagnostics' && segs[1] === 'key-fingerprint' && m === 'GET') {
    return H.diagnosticsKeyFingerprint(req, res);
  }

  return sendError(res, 404, 'Ruta admin no encontrada.');
}

module.exports = { route };
