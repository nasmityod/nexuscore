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

  const tokenUser = {
    id: user.id,
    username: user.username,
    nombre_completo: user.nombre_completo,
    rol_id: user.rol_id,
    rol_nombre: user.rol_nombre,
    permisos: user.rol_permisos
  };
  const token = signAccessToken(tokenUser);

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
      permisos: user.rol_permisos
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

async function logout(req, res) {
  // En arquitectura stateless JWT no hay blacklist.
  // El cliente ya limpió localStorage antes de llamar aquí.
  // Registramos auditoría si hay token válido.
  const token = getBearerToken(req);
  if (token) {
    try {
      const decoded = verifyAccessToken(token);
      await registrarAuditoria(db, {
        usuario_id: decoded.sub,
        accion: 'LOGOUT',
        tabla_afectada: 'usuarios',
        registro_id: decoded.sub,
        datos_nuevos: { username: decoded.username },
        ip_address: clientIp(req)
      });
    } catch (_e) {
      // Token ya expirado al hacer logout — no es error
    }
  }
  res.json({ ok: true });
}

module.exports = {
  login: asyncHandler(login),
  verify: asyncHandler(verify),
  logout: asyncHandler(logout)
};
