'use strict';

const { logger } = require('../config/logger');

/**
 * Mapeo de errores de PostgreSQL/red a respuestas HTTP claras y en español.
 *
 * Objetivos:
 *   - El cajero NUNCA ve un mensaje técnico tipo "ECONNREFUSED 127.0.0.1:5432".
 *   - Errores transitorios de BD se devuelven como 503 para que el frontend
 *     muestre el toast "Base de datos no disponible" y permita reintentar.
 *   - Errores de validación de negocio mantienen su status (400/409) intactos.
 *   - Violaciones de constraints conocidos (stock_no_negativo, idempotency_key)
 *     reciben mensajes específicos que el frontend puede interpretar.
 */

// Códigos de estado de pg (SQLSTATE) y de red — agrupados por significado
const PG_CONNECTION_FAILURE = new Set([
  '08000', '08003', '08006', '08001', '08004', '08007', '08P01',
  '57P01', '57P02', '57P03'
]);
const PG_DEADLOCK_OR_LOCK_TIMEOUT = new Set(['40001', '40P01', '55P03']);
const PG_QUERY_CANCELED = new Set(['57014']);
const PG_INSUFFICIENT_RESOURCES = new Set(['53000', '53100', '53200', '53300', '53400']);
const PG_CHECK_VIOLATION = '23514';
const PG_UNIQUE_VIOLATION = '23505';
const PG_FK_VIOLATION = '23503';
const PG_NOT_NULL_VIOLATION = '23502';

const NET_CONN_ERRORS = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH',
  'EAI_AGAIN', 'EPIPE'
]);

function isDbConnectionError(err) {
  if (!err) return false;
  if (NET_CONN_ERRORS.has(err.code)) return true;
  if (err.code && PG_CONNECTION_FAILURE.has(err.code)) return true;
  const msg = String(err.message || '');
  return (
    msg.includes('Connection terminated') ||
    msg.includes('connect ECONNREFUSED') ||
    msg.includes('connect ETIMEDOUT') ||
    msg.includes('Client has encountered a connection error') ||
    msg.includes('terminating connection')
  );
}

function isDbResourceError(err) {
  if (!err) return false;
  if (err.code && PG_INSUFFICIENT_RESOURCES.has(err.code)) return true;
  if (err.code && PG_DEADLOCK_OR_LOCK_TIMEOUT.has(err.code)) return true;
  if (err.code && PG_QUERY_CANCELED.has(err.code)) return true;
  return false;
}

/**
 * Decide status HTTP y mensaje según el error.
 * Devuelve { status, message, code } donde `code` es opcional para que el
 * frontend pueda reaccionar específicamente (ej: STOCK_INSUFICIENTE → modal).
 */
function classifyError(err) {
  // Errores HTTP explícitos (httpError(400, '...') de los controllers)
  if (err && err.status && err.status < 500) {
    return { status: err.status, message: err.message, code: err.code || null };
  }

  // Pérdida de conexión a BD → 503 reintentable
  if (isDbConnectionError(err)) {
    return {
      status: 503,
      message: 'Base de datos no disponible. Verifica que PostgreSQL esté en ejecución y reintenta.',
      code: 'DB_UNAVAILABLE'
    };
  }

  // Recursos / deadlock → 503 reintentable (corto plazo)
  if (isDbResourceError(err)) {
    return {
      status: 503,
      message: 'La base de datos está ocupada en este momento. Reintenta en unos segundos.',
      code: 'DB_BUSY'
    };
  }

  // Constraint check_violation con mensaje explícito (stock, etc.)
  if (err && err.code === PG_CHECK_VIOLATION) {
    const m = String(err.message || '');
    if (m.includes('STOCK_INSUFICIENTE') || m.includes('chk_productos_stock_no_negativo')) {
      return {
        status: 409,
        message: 'Stock insuficiente para completar la operación. Otro usuario pudo haber vendido el último ítem.',
        code: 'STOCK_INSUFICIENTE'
      };
    }
    return {
      status: 409,
      message: 'La operación viola una regla de integridad: ' + (err.detail || err.message || ''),
      code: 'CHECK_VIOLATION'
    };
  }

  // Idempotency key duplicado → ya existe esa venta
  if (err && err.code === PG_UNIQUE_VIOLATION) {
    const constraint = String(err.constraint || '');
    if (constraint.includes('idempotency_key')) {
      return {
        status: 409,
        message: 'Esta venta ya fue registrada anteriormente (operación duplicada detectada).',
        code: 'DUPLICATE_OPERATION'
      };
    }
    return {
      status: 409,
      message: 'Ya existe un registro con esos datos: ' + (err.detail || err.message || ''),
      code: 'UNIQUE_VIOLATION'
    };
  }

  // Foreign key
  if (err && err.code === PG_FK_VIOLATION) {
    return {
      status: 409,
      message: 'Operación rechazada: el registro referenciado no existe o no se puede borrar porque está en uso.',
      code: 'FK_VIOLATION'
    };
  }

  // Not null
  if (err && err.code === PG_NOT_NULL_VIOLATION) {
    return {
      status: 400,
      message: 'Falta un campo obligatorio: ' + (err.column || ''),
      code: 'NOT_NULL_VIOLATION'
    };
  }

  // Catch-all 500
  return {
    status: err && err.status ? err.status : 500,
    message: err && err.message ? err.message : 'Error interno',
    code: null
  };
}

function errorHandlerMiddleware(err, req, res, next) {
  const { status, message, code } = classifyError(err);

  // Logging estructurado: 5xx siempre, 503 con menos ruido
  if (status >= 500 && status !== 503) {
    logger.error('Error interno del servidor', {
      method: req.method,
      url: req.originalUrl,
      status,
      error: message,
      pgCode: err && err.code,
      stack: err && err.stack ? err.stack : ''
    });
  } else if (status === 503) {
    logger.warn('Servicio temporalmente no disponible', {
      method: req.method,
      url: req.originalUrl,
      pgCode: err && err.code,
      error: err && err.message
    });
  }

  const body = { error: message };
  if (code) body.code = code;
  res.status(status).json(body);
}

module.exports = {
  errorHandlerMiddleware,
  classifyError,
  isDbConnectionError,
  isDbResourceError
};
