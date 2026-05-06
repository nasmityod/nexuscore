'use strict';

const { logger } = require('../config/logger');

/**
 * Campos de producto que afectan precio de venta / costos para el POS.
 */
const CAMPOS_PRECIO_PRODUCTO = [
  'costo_usd',
  'costo_promedio_ponderado_usd',
  'margen_ganancia_pct',
  'precio_manual_usd',
  'precio_mayorista_usd',
  'precio_especial_usd'
];

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff && typeof xff === 'string') {
    return xff.split(',')[0].trim() || null;
  }
  return req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : null;
}

function pickPrecioFields(row) {
  if (!row) return {};
  const o = {};
  for (let i = 0; i < CAMPOS_PRECIO_PRODUCTO.length; i += 1) {
    const k = CAMPOS_PRECIO_PRODUCTO[i];
    if (Object.prototype.hasOwnProperty.call(row, k) && row[k] !== undefined) {
      const v = row[k];
      o[k] = v !== null && typeof v === 'object' && typeof v.toString === 'function' ? String(v) : v;
    }
  }
  return o;
}

/**
 * Inserta un registro en auditoria. No lanza: errores solo se registran en log.
 *
 * @param {import('pg-promise').IDatabase<any>} db
 * @param {object} opts
 * @param {number|null} opts.usuario_id
 * @param {string} opts.accion
 * @param {string|null} [opts.tabla_afectada]
 * @param {number|null} [opts.registro_id]
 * @param {object|null} [opts.datos_anteriores]
 * @param {object|null} [opts.datos_nuevos]
 * @param {string|null} [opts.ip_address]
 */
async function registrarAuditoria(db, opts) {
  const {
    usuario_id,
    accion,
    tabla_afectada = null,
    registro_id = null,
    datos_anteriores = null,
    datos_nuevos = null,
    ip_address = null
  } = opts || {};

  if (!accion) return;

  let uid =
    usuario_id != null && usuario_id !== '' ? Number(usuario_id) : null;
  if (uid != null && (!Number.isFinite(uid) || uid < 1)) {
    uid = null;
  }
  if (uid != null) {
    const existe = await db.oneOrNone(
      `SELECT 1 AS ok FROM usuarios WHERE id = $1 LIMIT 1`,
      [uid]
    );
    if (!existe) {
      logger.warn(
        'Auditoría: usuario_id del token o contexto no existe en BD (sesión obsoleta o BD recreada); se registra con usuario NULL',
        { usuario_id_solicitado: usuario_id, accion }
      );
      uid = null;
    }
  }

  try {
    await db.none(
      `INSERT INTO auditoria (
        usuario_id, accion, tabla_afectada, registro_id,
        datos_anteriores, datos_nuevos, ip_address
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
      [
        uid,
        accion,
        tabla_afectada,
        registro_id,
        datos_anteriores != null ? JSON.stringify(datos_anteriores) : null,
        datos_nuevos != null ? JSON.stringify(datos_nuevos) : null,
        ip_address
      ]
    );
  } catch (err) {
    logger.error('registrarAuditoria falló', { error: err.message, accion, registro_id });
  }
}

module.exports = {
  CAMPOS_PRECIO_PRODUCTO,
  clientIp,
  pickPrecioFields,
  registrarAuditoria
};
