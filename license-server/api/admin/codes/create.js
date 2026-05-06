'use strict';

/**
 * POST /api/admin/codes/create
 * Endpoint privado — solo para el distribuidor.
 * Requiere header: Authorization: Bearer {NEXUS_ADMIN_API_KEY}
 *
 * Body JSON:
 *   empresa      string  (obligatorio)  Nombre del cliente/empresa
 *   edition      string  (opcional)     "basico" | "profesional" | "enterprise"
 *   expiraEn     string  (opcional)     ISO 8601, fecha de expiración de la LICENCIA
 *   expiraCodigo string  (opcional)     ISO 8601, fecha límite para CANJEAR el código
 *   cantidad     number  (opcional)     Cuántos códigos generar en lote (max 50)
 *
 * Retorna:
 *   { ok: true, codes: ["NC-XXXXX-XXXXX-XXXXX", ...] }
 */

const { kv }                                   = require('@vercel/kv');
const { generarCodigo, computeCodeHmac }       = require('../../../lib/crypto');
const { validateAdminAuth, sendError, sendOk } = require('../../../lib/validate');

const EDITIONS_VALIDAS = ['basico', 'profesional', 'enterprise'];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Método no permitido.');

  // ── Autenticación admin ────────────────────────────────────────────────
  try { validateAdminAuth(req); }
  catch (e) { return sendError(res, e.status || 401, e.message); }

  // ── Validación del body ────────────────────────────────────────────────
  const body = req.body || {};

  const empresa = String(body.empresa || '').trim().slice(0, 100);
  if (!empresa) return sendError(res, 400, 'El campo "empresa" es obligatorio.');

  const edition = EDITIONS_VALIDAS.includes(body.edition) ? body.edition : 'profesional';

  const expiraEn = body.expiraEn
    ? validarFechaIso(body.expiraEn) : null;
  const expiraCodigo = body.expiraCodigo
    ? validarFechaIso(body.expiraCodigo) : null;

  const cantidad = Math.min(Math.max(parseInt(body.cantidad) || 1, 1), 50);

  // ── Generación de códigos ──────────────────────────────────────────────
  const codesGenerados = [];
  const pipeline = [];

  for (let i = 0; i < cantidad; i++) {
    const code = generarCodigo();
    const hmac = computeCodeHmac(code);

    const entry = {
      empresa,
      edition,
      expiraEn:          expiraEn || null,
      expiraCodigo:      expiraCodigo || null,
      hmac,                         // firma del código — verifica integridad en KV
      activatedHwidHash: null,
      activatedAt:       null,
      activatedIp:       null,
      revocado:          false,
      creadoEn:          new Date().toISOString(),
    };

    // TTL en KV: si tiene fecha de expiración de canje, expira automáticamente
    const ttlOpts = expiraCodigo
      ? { ex: Math.max(1, Math.floor((new Date(expiraCodigo) - Date.now()) / 1000)) }
      : {};

    pipeline.push(kv.set(`code:${code}`, entry, ttlOpts));
    codesGenerados.push(code);
  }

  try {
    await Promise.all(pipeline);
  } catch (kvErr) {
    console.error('[create] KV error:', kvErr);
    return sendError(res, 503, 'No se pudieron guardar los códigos. Intenta de nuevo.');
  }

  // Log de auditoría
  await kv.lpush('audit:created', JSON.stringify({
    empresa, edition, cantidad,
    codes: codesGenerados.map(c => c.slice(0, 5) + '…'),
    ts:    new Date().toISOString(),
  })).catch(console.error);
  await kv.ltrim('audit:created', 0, 9999).catch(() => {});

  return sendOk(res, {
    codes: codesGenerados,
    empresa,
    edition,
    expiraEn:      expiraEn     || null,
    expiraCodigo:  expiraCodigo || null,
    message:       `${cantidad} código(s) generado(s) para "${empresa}".`,
  });
};

function validarFechaIso(val) {
  const d = new Date(val);
  if (isNaN(d.getTime())) throw Object.assign(new Error(`Fecha inválida: "${val}"`), { status: 400 });
  if (d < new Date()) throw Object.assign(new Error(`La fecha "${val}" ya pasó.`), { status: 400 });
  return d.toISOString();
}
