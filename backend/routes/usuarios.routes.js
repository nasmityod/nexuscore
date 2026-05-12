'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../config/database');
const bcrypt = require('bcryptjs');
const { asyncHandler } = require('../utils/asyncHandler');
const { registrarAuditoria } = require('../middleware/audit.middleware');
const { requirePermission, hasPermission, normalizePermisos } = require('../middleware/permissions.middleware');
const { FALLBACK_BY_ROLE } = require('../constants/rolePermissions');

/** Cualquier usuario autenticado puede cambiar su propia contraseña (validación dentro del handler). */
router.post('/:id/cambiar-password', asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const { password_actual, password_nuevo } = req.body;

  if (!password_nuevo || password_nuevo.length < 4) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 4 caracteres' });
  }

  const user = await db.oneOrNone(`SELECT * FROM usuarios WHERE id = $1`, [userId]);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const puedeGestionarOtros = hasPermission(req.user, 'usuarios_all');
  const esMismoUsuario = req.user.id === userId;

  if (esMismoUsuario) {
    if (!password_actual) {
      return res.status(400).json({ error: 'Debes indicar la contraseña actual' });
    }
    const valido = await bcrypt.compare(password_actual, user.password_hash);
    if (!valido) {
      return res.status(401).json({ error: 'La contraseña actual no es correcta' });
    }
  } else if (!puedeGestionarOtros) {
    return res.status(403).json({ error: 'No tienes permiso para cambiar la contraseña de otro usuario' });
  }

  const hash = await bcrypt.hash(password_nuevo, 10);
  await db.none(`UPDATE usuarios SET password_hash = $1 WHERE id = $2`, [hash, userId]);

  res.json({ ok: true, message: 'Contraseña actualizada correctamente' });
}));

router.use(requirePermission('usuarios_all'));

/**
 * Best-effort fetch of permisos_override for one or many user rows.
 * Returns a Map<id, object>.  Silently returns empty map if column doesn't exist yet.
 */
async function fetchOverrides(userIds) {
  const map = new Map();
  if (!userIds || !userIds.length) return map;
  try {
    const rows = await db.any(
      `SELECT id, COALESCE(permisos_override, '{}'::jsonb) AS permisos_override
       FROM usuarios WHERE id = ANY($1::int[])`,
      [userIds]
    );
    rows.forEach((r) => map.set(r.id, r.permisos_override || {}));
  } catch (_e) { /* migration 025 not applied yet — return empty map */ }
  return map;
}

// GET /api/usuarios
router.get('/', asyncHandler(async (req, res) => {
  const rows = await db.any(
    `SELECT u.id, u.username, u.nombre_completo, u.activo,
            u.rol_id,
            u.ultimo_acceso, u.creado_en,
            r.nombre AS rol
     FROM usuarios u
     LEFT JOIN roles r ON r.id = u.rol_id
     ORDER BY u.nombre_completo`
  );
  const overrides = await fetchOverrides(rows.map((r) => r.id));
  const out = rows.map((r) => ({ ...r, permisos_override: overrides.get(r.id) || {} }));
  res.json(out);
}));

// GET /api/usuarios/roles
router.get('/roles', asyncHandler(async (req, res) => {
  const rows = await db.any(`SELECT id, nombre FROM roles ORDER BY nombre`);
  res.json(rows);
}));

// POST /api/usuarios/roles — crear rol (solo admin)
router.post('/roles', requirePermission('usuarios_all'), asyncHandler(async (req, res) => {
  const { nombre, permisos } = req.body || {};
  if (!nombre || !String(nombre).trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
  const existing = await db.oneOrNone(`SELECT id FROM roles WHERE LOWER(nombre) = LOWER($1)`, [nombre]);
  if (existing) return res.status(409).json({ error: 'Ya existe un rol con ese nombre' });
  const nombreLc = String(nombre).trim().toLowerCase();
  const preset = FALLBACK_BY_ROLE[nombreLc] || {};
  const permObj = normalizePermisos(permisos);
  const mergedPerm =
    Object.keys(permObj).length === 0 && Object.keys(preset).length > 0
      ? { ...preset }
      : { ...preset, ...permObj };
  const row = await db.one(
    `INSERT INTO roles (nombre, permisos) VALUES ($1, $2::jsonb) RETURNING id, nombre`,
    [nombreLc, JSON.stringify(mergedPerm)]
  );
  res.status(201).json(row);
}));

// GET /api/usuarios/:id — debe ir después de /roles para no capturar "roles" como id
router.get('/:id', asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!userId || userId < 1) {
    return res.status(400).json({ error: 'ID de usuario inválido' });
  }
  const row = await db.oneOrNone(
    `SELECT u.id, u.username, u.nombre_completo, u.activo, u.rol_id,
            u.ultimo_acceso, u.creado_en,
            r.nombre AS rol,
            COALESCE(r.permisos, '{}'::jsonb) AS rol_permisos
     FROM usuarios u
     LEFT JOIN roles r ON r.id = u.rol_id
     WHERE u.id = $1`,
    [userId]
  );
  if (!row) {
    return res.status(404).json({ error: 'Usuario no encontrado' });
  }
  const overrides = await fetchOverrides([userId]);
  res.json({ ...row, permisos_override: overrides.get(userId) || {} });
}));

async function resolverRolId(body, fallbackActual = null) {
  const rid = body.rol_id;
  if (rid !== undefined && rid !== null && String(rid).trim() !== '') {
    const n = parseInt(String(rid), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const rolNombre = body.rol != null ? String(body.rol).trim().toLowerCase() : '';
  if (!rolNombre) return fallbackActual;
  const row = await db.oneOrNone(`SELECT id FROM roles WHERE LOWER(TRIM(nombre)) = $1`, [rolNombre]);
  return row ? row.id : null;
}

// POST /api/usuarios — crear usuario
router.post('/', asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  const nombreCompletoRaw = req.body.nombre_completo != null ? req.body.nombre_completo : req.body.nombre;
  const nombreCompleto = nombreCompletoRaw != null ? String(nombreCompletoRaw).trim() : '';

  if (!username || !String(username).trim()) {
    return res.status(400).json({ error: 'El nombre de usuario es obligatorio' });
  }
  if (!password || password.length < 4) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });
  }
  if (!nombreCompleto) {
    return res.status(400).json({ error: 'El nombre completo es obligatorio' });
  }

  const existing = await db.oneOrNone(
    `SELECT id FROM usuarios WHERE LOWER(username) = LOWER($1)`, [username]
  );
  if (existing) {
    return res.status(409).json({ error: `El usuario "${username}" ya existe. Elige otro nombre.` });
  }

  const rolIdFinal = await resolverRolId(req.body, null);

  const permisosOverride =
    req.body.permisos_override != null && typeof req.body.permisos_override === 'object'
      ? req.body.permisos_override
      : {};

  const hash = await bcrypt.hash(password, 10);
  // Insert without permisos_override first (always works), then apply override if column exists
  const user = await db.one(
    `INSERT INTO usuarios (username, password_hash, nombre_completo, rol_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, username, nombre_completo, activo`,
    [username.trim().toLowerCase(), hash, nombreCompleto, rolIdFinal]
  );

  if (Object.keys(permisosOverride).length > 0) {
    try {
      await db.none(
        `UPDATE usuarios SET permisos_override = $1::jsonb WHERE id = $2`,
        [JSON.stringify(permisosOverride), user.id]
      );
    } catch (_e) { /* migration 025 not applied yet — skip */ }
  }

  await registrarAuditoria(db, {
    usuario_id: req.user.id,
    accion: 'CREAR_USUARIO',
    tabla_afectada: 'usuarios',
    registro_id: user.id,
    datos_anteriores: null,
    datos_nuevos: { username: user.username, nombre_completo: user.nombre_completo },
    ip_address: req.ip
  });

  res.status(201).json(user);
}));

// PATCH /api/usuarios/:id — editar usuario
router.patch('/:id', asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id);
  const { activo } = req.body;

  const user = await db.oneOrNone(`SELECT * FROM usuarios WHERE id = $1`, [userId]);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const updates = [];
  const values = [];
  let idx = 1;

  const nombrePatch =
    req.body.nombre_completo !== undefined ? req.body.nombre_completo : req.body.nombre;
  if (nombrePatch !== undefined) {
    const nc = String(nombrePatch).trim();
    if (!nc) {
      return res.status(400).json({ error: 'El nombre completo no puede estar vacío' });
    }
    updates.push(`nombre_completo = $${idx++}`);
    values.push(nc);
  }

  if (req.body.rol_id !== undefined || req.body.rol !== undefined) {
    const rolIdFinal = await resolverRolId(req.body, user.rol_id);
    updates.push(`rol_id = $${idx++}`);
    values.push(rolIdFinal);
  }
  if (activo !== undefined) {
    if (userId === req.user.id && activo === false) {
      return res.status(400).json({ error: 'No puedes desactivar tu propia cuenta' });
    }
    updates.push(`activo = $${idx++}`);
    values.push(activo);
  }

  // permisos_override is saved separately (best-effort) after the main UPDATE
  // so the main PATCH never crashes if column doesn't exist yet.
  const permOverridePatch =
    req.body.permisos_override !== undefined ? req.body.permisos_override : undefined;

  if (updates.length === 0 && permOverridePatch === undefined) {
    return res.status(400).json({ error: 'No hay cambios para guardar' });
  }

  // If only permisos_override changed, apply it and return current user data
  if (updates.length === 0 && permOverridePatch !== undefined) {
    const po = permOverridePatch === null ? {} : permOverridePatch;
    try {
      await db.none(
        `UPDATE usuarios SET permisos_override = $1::jsonb WHERE id = $2`,
        [JSON.stringify(po), userId]
      );
    } catch (_e) { /* migration 025 not applied yet */ }
    return res.json({ id: user.id, username: user.username, nombre_completo: user.nombre_completo, activo: user.activo });
  }

  values.push(userId);
  const updated = await db.one(
    `UPDATE usuarios SET ${updates.join(', ')} WHERE id = $${idx}
     RETURNING id, username, nombre_completo, activo`,
    values
  );

  // Apply permisos_override separately (best-effort) so PATCH never crashes
  // if migration 025 hasn't run yet.
  if (permOverridePatch !== undefined) {
    const po = permOverridePatch === null ? {} : permOverridePatch;
    if (typeof po !== 'object') {
      return res.status(400).json({ error: 'permisos_override debe ser un objeto JSON' });
    }
    try {
      await db.none(
        `UPDATE usuarios SET permisos_override = $1::jsonb WHERE id = $2`,
        [JSON.stringify(po), userId]
      );
    } catch (_e) { /* migration 025 not applied yet — skip */ }
  }

  res.json(updated);
}));

// DELETE /api/usuarios/:id — desactivar (nunca borrar)
router.delete('/:id', asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id);

  if (userId === req.user.id) {
    return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
  }

  await db.none(`UPDATE usuarios SET activo = FALSE WHERE id = $1`, [userId]);
  res.json({ ok: true, message: 'Usuario desactivado correctamente' });
}));

module.exports = router;
