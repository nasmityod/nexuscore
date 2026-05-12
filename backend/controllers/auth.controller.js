'use strict';

const bcrypt = require('bcryptjs');

const { db } = require('../config/database');
const {
  signAccessToken,
  getBearerToken,
  verifyAccessToken
} = require('../middleware/auth.middleware');
const { asyncHandler, httpError } = require('../utils/asyncHandler');
const { clientIp, registrarAuditoria } = require('../middleware/audit.middleware');
const { resolvedPermissions } = require('../middleware/permissions.middleware');

async function login(req, res) {
  const body = req.body || {};
  const username = body.username != null ? String(body.username).trim().toLowerCase() : '';
  const password = body.password != null ? String(body.password).trim() : '';

  if (!username || !password) {
    throw httpError(400, 'Usuario y contraseña son obligatorios');
  }

  const user = await db.oneOrNone(
    `SELECT u.id, u.username, u.password_hash, u.nombre_completo, u.rol_id, u.activo,
            r.nombre AS rol_nombre,
            COALESCE(r.permisos, '{}'::jsonb) AS rol_permisos
     FROM usuarios u
     LEFT JOIN roles r ON r.id = u.rol_id
     WHERE LOWER(TRIM(u.username)) = $1`,
    [username]
  );

  if (!user || user.activo === false) {
    throw httpError(401, 'Credenciales incorrectas');
  }

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) {
    throw httpError(401, 'Credenciales incorrectas');
  }

  await db.none(`UPDATE usuarios SET ultimo_acceso = NOW() WHERE id = $1`, [user.id]);

  // Fetch per-user override if the column exists (migration 025).
  // Falls back to {} silently so login works even before the migration runs.
  let overrideRaw = {};
  try {
    const ovRow = await db.oneOrNone(
      `SELECT permisos_override FROM usuarios WHERE id = $1`, [user.id]
    );
    if (ovRow && ovRow.permisos_override) {
      overrideRaw = typeof ovRow.permisos_override === 'string'
        ? JSON.parse(ovRow.permisos_override)
        : ovRow.permisos_override;
    }
  } catch (_migPending) { /* column not yet added — ignore */ }

  const hasOverride = Object.keys(overrideRaw).length > 0;

  const permisosEfectivos = resolvedPermissions({
    permisos: hasOverride ? overrideRaw : user.rol_permisos,
    rol_nombre: user.rol_nombre
  });

  const tokenUser = {
    id: user.id,
    username: user.username,
    nombre_completo: user.nombre_completo,
    rol_id: user.rol_id,
    rol_nombre: user.rol_nombre,
    permisos: permisosEfectivos
  };
  const token = signAccessToken(tokenUser);

  // TODO: implementar token blacklist o refresh token rotativo para invalidar sesiones previas del mismo usuario.

  await registrarAuditoria(db, {
    usuario_id: user.id,
    accion: 'LOGIN',
    tabla_afectada: 'usuarios',
    registro_id: user.id,
    datos_nuevos: { username: user.username },
    ip_address: clientIp(req)
  });

  // Detectar cajas abiertas de OTROS usuarios para advertir al login.
  // No bloquea, solo informa para que el cajero o supervisor decida qué hacer.
  const cajasOtros = await db.any(
    `SELECT sc.id, sc.fecha_apertura,
            u.nombre_completo AS cajero,
            u.username,
            EXTRACT(EPOCH FROM (NOW() - sc.fecha_apertura))::int AS antiguedad_segundos
     FROM sesiones_caja sc
     JOIN usuarios u ON u.id = sc.usuario_id
     WHERE sc.estado = 'abierta' AND sc.fecha_cierre IS NULL AND sc.usuario_id != $1
     ORDER BY sc.fecha_apertura ASC`,
    [user.id]
  );

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      nombre_completo: user.nombre_completo,
      rol_id: user.rol_id,
      rol_nombre: user.rol_nombre,
      permisos: permisosEfectivos
    },
    cajas_abiertas_otros: cajasOtros
  });
}

async function verify(req, res) {
  // Reutiliza requireAuth inline para validar el token
  // Si llega aquí, el token es válido (requireAuth ya verificó)
  // El router la montará con requireAuth como middleware previo
  res.json({
    valid: true,
    user: {
      id: req.user.id,
      username: req.user.username,
      nombre_completo: req.user.nombre_completo,
      rol_id: req.user.rol_id,
      rol_nombre: req.user.rol_nombre,
      permisos: req.user.permisos
    }
  });
}

/**
 * POST /api/auth/logout
 * Query param ?confirm=1 means the client already showed the caja-abierta warning
 * and the user chose to proceed.  Without it, the endpoint only checks for open caja
 * and returns the advertencia WITHOUT writing the audit record yet.
 * The audit is only written once confirm=1 arrives (or when there is no caja warning).
 */
async function logout(req, res) {
  const token = getBearerToken(req);
  const confirmed = req.query.confirm === '1' || req.body?.confirmed === true;
  const payload = { ok: true };

  if (token) {
    try {
      const decoded = verifyAccessToken(token);
      const sub = decoded.sub;
      const usuarioId =
        typeof sub === 'number' ? sub : parseInt(String(sub), 10);

      const sesAbierta = await db.oneOrNone(
        `SELECT id FROM sesiones_caja
         WHERE estado = 'abierta' AND fecha_cierre IS NULL AND usuario_id = $1
         LIMIT 1`,
        [usuarioId]
      );

      if (sesAbierta && !confirmed) {
        // Return the warning without auditing — the client will confirm via ?confirm=1
        payload.advertencia = 'caja_abierta';
        payload.sesion_caja_id = sesAbierta.id;
        return res.json(payload);
      }

      // No warning, or client already confirmed → audit the logout now
      await registrarAuditoria(db, {
        usuario_id: usuarioId,
        accion: 'LOGOUT',
        tabla_afectada: 'usuarios',
        registro_id: usuarioId,
        datos_nuevos: { username: decoded.username },
        ip_address: clientIp(req)
      });
    } catch (_e) {
      // Token inválido o expirado — respuesta mínima
    }
  }

  res.json(payload);
}

module.exports = {
  login: asyncHandler(login),
  verify: asyncHandler(verify),
  logout: asyncHandler(logout)
};
