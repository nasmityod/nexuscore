'use strict';

/** GET /api/panel/stats — Dashboard agregado del panel. */

const { requireSession } = require('../session');
const { callUpstream } = require('../upstream');
const { sendOk, sendError } = require('../respond');

function expiringSoonDays() {
  const n = parseInt(process.env.PANEL_EXPIRING_SOON_DAYS, 10);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(n, 365);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return sendError(res, 405, 'Método no permitido.');
  try { requireSession(req); } catch (e) { return sendError(res, e.status || 401, e.message); }

  let data;
  try {
    data = await callUpstream('GET', '/api/admin/licenses');
  } catch (e) {
    return sendError(res, e.status || 500, e.message);
  }

  const licenses = Array.isArray(data.licenses) ? data.licenses : [];
  const stats = data.stats || {};
  const soonThreshold = expiringSoonDays();

  let totalActivations = 0;
  let activatedLicenses = 0;
  let neverActivated = 0;
  const customers = new Map();
  const expiringSoon = [];

  for (const l of licenses) {
    totalActivations += Number(l.activationCount) || 0;
    if (l.activatedAt) activatedLicenses += 1; else neverActivated += 1;

    const custKey = (l.customerEmail || l.customerName || '—').toLowerCase();
    if (!customers.has(custKey)) {
      customers.set(custKey, {
        name: l.customerName || '—',
        email: l.customerEmail || '',
        licenses: 0,
        activations: 0,
        active: 0
      });
    }
    const c = customers.get(custKey);
    c.licenses += 1;
    c.activations += Number(l.activationCount) || 0;
    if (l.status === 'active' && !l.expired) c.active += 1;

    if (
      l.status === 'active' &&
      l.type !== 'permanent' &&
      typeof l.daysRemaining === 'number' &&
      l.daysRemaining >= 0 &&
      l.daysRemaining <= soonThreshold
    ) {
      expiringSoon.push({
        key: l.key,
        customerName: l.customerName || '—',
        type: l.type,
        expiresAt: l.expiresAt,
        daysRemaining: l.daysRemaining
      });
    }
  }

  expiringSoon.sort((a, b) => (a.daysRemaining || 0) - (b.daysRemaining || 0));

  const recent = licenses
    .slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 6)
    .map((l) => ({
      key: l.key,
      customerName: l.customerName || '—',
      type: l.type,
      status: l.status,
      expired: !!l.expired,
      createdAt: l.createdAt
    }));

  return sendOk(res, {
    stats,
    derived: {
      totalLicenses: licenses.length,
      totalActivations,
      activatedLicenses,
      neverActivated,
      distinctCustomers: customers.size,
      expiringSoonThreshold: soonThreshold,
      expiringSoonCount: expiringSoon.length
    },
    expiringSoon: expiringSoon.slice(0, 10),
    recent
  });
};
