'use strict';

const express = require('express');
const router  = express.Router();
const { db }  = require('../config/database');
const { asyncHandler, httpError } = require('../utils/asyncHandler');
const licenciaService = require('../services/licenciaService');
const { requirePermission } = require('../middleware/permissions.middleware');
const { requireAuth } = require('../middleware/auth.middleware');

function hwidsFromBody(body) {
  const { hwid, hwid_compat } = body || {};
  const list = [];
  const a = hwid && String(hwid).trim();
  const b = hwid_compat && String(hwid_compat).trim();
  if (a) list.push(a);
  if (b && !list.includes(b)) list.push(b);
  return list;
}

/**
 * GET /api/licencia/estado
 * Devuelve el estado de la licencia almacenada (verificación local, sin internet).
 */
router.get('/estado', asyncHandler(async (req, res) => {
  const q = req.query.hwid || req.headers['x-hardware-id'];
  const compat = req.query.hwid_compat;
  const list = [];
  if (q && String(q).trim()) list.push(String(q).trim());
  if (compat && String(compat).trim()) {
    const c = String(compat).trim();
    if (!list.includes(c)) list.push(c);
  }
  const hwids = list.length ? list : ['unknown'];
  const estado = await licenciaService.obtenerEstadoLicencia(db, hwids);
  res.json(estado);
}));

/**
 * POST /api/licencia/activar
 * Verifica la firma Ed25519 y persiste la clave en la BD.
 * Solo administradores pueden activar (cuando ya hay sesión iniciada).
 */
// AUD-SEC: este router se monta fuera de apiProtected, por lo que requireAuth debe ir
// explícito ANTES de requirePermission (que asume req.user ya verificado). Sin él,
// requirePermission siempre respondía 403 y el endpoint quedaba inutilizable para admins.
router.post('/activar', requireAuth, requirePermission('usuarios_all'), asyncHandler(async (req, res) => {
  const { clave } = req.body || {};
  const hwids = hwidsFromBody(req.body);
  if (!clave || !String(clave).trim()) throw httpError(400, 'La clave de licencia es obligatoria');
  if (!hwids.length) throw httpError(400, 'El Hardware ID es obligatorio');

  const info = await licenciaService.activarLicenciaConHwids(db, String(clave).trim(), hwids);
  res.json({ ok: true, info, message: `Licencia activada correctamente para ${info.empresa}` });
}));

/**
 * POST /api/licencia/activar-inicial
 * Igual que /activar pero SIN autenticación JWT.
 * Solo se rechaza si ya hay una licencia **válida y activa** para este equipo (409).
 * Si la clave guardada está expirada o inválida, se permite sustituirla (misma pantalla
 * de activación tras trial vencido — el cliente final no usa SQL ni Configuración).
 */
router.post('/activar-inicial', asyncHandler(async (req, res) => {
  const { clave } = req.body || {};
  const hwids = hwidsFromBody(req.body);
  if (!clave || !String(clave).trim()) throw httpError(400, 'La clave de licencia es obligatoria');
  if (!hwids.length) throw httpError(400, 'El Hardware ID es obligatorio');

  const claveGuardada = await db.oneOrNone(
    `SELECT valor FROM configuracion WHERE clave = 'licencia_clave' LIMIT 1`
  );
  if (claveGuardada?.valor) {
    const estado = await licenciaService.obtenerEstadoLicencia(db, hwids);
    if (estado.activada) {
      throw httpError(409, 'Ya existe una licencia activada en este sistema');
    }
  }

  const info = await licenciaService.activarLicenciaConHwids(db, String(clave).trim(), hwids);
  res.json({ ok: true, info, message: `Licencia activada correctamente para ${info.empresa}` });
}));

// NOTA: El endpoint /generar fue eliminado intencionalmente.
// Las licencias solo se crean desde el servidor Vercel privado del distribuidor.
// Ver: license-server/api/license/generate.js

module.exports = router;
