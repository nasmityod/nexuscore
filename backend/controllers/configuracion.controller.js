'use strict';

const { db } = require('../config/database');
const PreciosService = require('../services/preciosService');
const SyncService = require('../services/syncService');
const BackupScheduler = require('../services/backupScheduler');
const BcvTasaAutoService = require('../services/bcvTasaAutoService');
const ModoMonedaService = require('../services/modoMonedaService');
const { asyncHandler, httpError } = require('../utils/asyncHandler');
const { normalizarTelefonoMovilVeOpcional } = require('../utils/telefonoVe');
const { clientIp, registrarAuditoria } = require('../middleware/audit.middleware');

const CLAVES_EMPRESA = [
  'empresa_nombre','empresa_rif','empresa_telefono','empresa_direccion',
  'empresa_email','empresa_logo_url',
  'impresora_interfaz','impresora_nombre','impresora_activa'
];

/* ─── GET /api/configuracion/tasas-actuales ─── */
async function getTasasActuales(req, res) {
  // resolverTasasOperativas: misma fuente legal que ventas (respeta feriados y días no
  // hábiles) y unifica tasa_usd = tasa_bcv en modo solo_bcv. Único punto de entrada.
  const tasas = await PreciosService.resolverTasasOperativas(db);
  res.json({
    tasa_bcv: tasas.tasa_bcv,
    tasa_usd: tasas.tasa_usd,
    bcv: tasas.tasa_bcv,
    usd: tasas.tasa_usd,
    modo_moneda_operacion: tasas.modo_moneda_operacion,
    dia_habil_referencia: tasas.dia_habil_referencia,
    congelada_por_no_habil: tasas.congelada_por_no_habil
  });
}

/* ─── GET /api/configuracion ─── */
async function getAll(req, res) {
  const rows = await db.any(`SELECT clave, valor FROM configuracion ORDER BY clave`);
  const cfg = {};
  rows.forEach((r) => { cfg[r.clave] = r.valor; });
  res.json(cfg);
}

/* ─── PATCH /api/configuracion ─── */
async function updateGeneral(req, res) {
  const body = req.body || {};

  // El modo monetario NO se cambia por este endpoint genérico: tiene su propia ruta
  // con validación de caja cerrada y auditoría (PATCH /api/configuracion/modo-moneda).
  // Evita un bypass de la regla "caja cerrada" (restricción no negociable #3).
  if (Object.prototype.hasOwnProperty.call(body, ModoMonedaService.CLAVE_MODO)) {
    throw httpError(400, 'Usa PATCH /api/configuracion/modo-moneda para cambiar el modo monetario');
  }

  const updates = Object.entries(body).filter(([k]) => CLAVES_EMPRESA.includes(k));
  if (!updates.length) throw httpError(400, 'No hay parámetros válidos');

  await db.tx(async (t) => {
    for (const [clave, valor] of updates) {
      let strVal = String(valor ?? '').trim();
      if (
        (clave === 'empresa_telefono' || clave === 'telefono_empresa') &&
        strVal !== ''
      ) {
        const r = normalizarTelefonoMovilVeOpcional(strVal);
        if (!r.ok) throw httpError(400, r.error);
        strVal = r.normalizado;
      }
      await t.none(
        `INSERT INTO configuracion (clave, valor, actualizado_en, actualizado_por)
         VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (clave) DO UPDATE
         SET valor = EXCLUDED.valor, actualizado_en = NOW(), actualizado_por = EXCLUDED.actualizado_por`,
        [clave, strVal, req.user?.id || null]
      );
    }
  });
  res.json({ ok: true });
}

/**
 * PATCH /api/configuracion/modo-moneda
 * Cambia modo_moneda_operacion (multimoneda | solo_bcv). Solo admin (tasas_edit).
 * Body: { modo_moneda_operacion: 'multimoneda'|'solo_bcv', tasa_usd?: number }
 *
 * Reglas no negociables:
 *  - Rechaza con 409 si hay alguna sesión de caja abierta.
 *  - solo_bcv  → fuerza tasa_usd = tasa_bcv de inmediato.
 *  - multimoneda → solo toca tasa_usd si se envía una nueva (la UI la pide al salir de solo_bcv).
 *  - Registra auditoría del cambio (tabla auditoria).
 *  - Nunca modifica ventas, historial ni tasas históricas: solo inserta filas/parámetros nuevos.
 */
async function patchModoMoneda(req, res) {
  const body = req.body || {};
  const modo = String(body.modo_moneda_operacion ?? body.modo ?? '').trim().toLowerCase();
  if (!ModoMonedaService.MODOS_VALIDOS.has(modo)) {
    throw httpError(400, 'modo_moneda_operacion debe ser multimoneda o solo_bcv');
  }

  const usuario_id = req.user && req.user.id ? Number(req.user.id) : null;
  if (!usuario_id || usuario_id < 1) throw httpError(401, 'Usuario no autenticado');

  const ipCliente = clientIp(req);

  // Restricción no negociable: el cambio de modo exige caja cerrada (validación en backend).
  const cajaAbierta = await db.oneOrNone(
    `SELECT id FROM sesiones_caja WHERE estado = 'abierta' AND fecha_cierre IS NULL LIMIT 1`
  );
  if (cajaAbierta) {
    throw httpError(
      409,
      'No se puede cambiar el modo monetario con una caja abierta. Cierra la caja primero.'
    );
  }

  const modoActual = await ModoMonedaService.leerModo(db);
  const rawUsdNueva = body.tasa_usd != null && body.tasa_usd !== '' ? body.tasa_usd : null;

  const result = await db.tx(async (t) => {
    const prev = await PreciosService.leerTasasPreviasConfig(t);

    // 1) Persistir el modo PRIMERO: así actualizarTasas() lo lee y unifica si aplica.
    await t.none(
      `INSERT INTO configuracion (clave, valor, categoria, descripcion, actualizado_en, actualizado_por)
       VALUES ($1, $2, 'moneda', 'Modo operativo: multimoneda | solo_bcv', NOW(), $3)
       ON CONFLICT (clave) DO UPDATE
       SET valor = EXCLUDED.valor, actualizado_en = NOW(), actualizado_por = EXCLUDED.actualizado_por`,
      [ModoMonedaService.CLAVE_MODO, modo, usuario_id]
    );

    let usdFinal = prev.tasa_usd;

    if (ModoMonedaService.esSoloBcv(modo)) {
      if (prev.tasa_bcv == null || prev.tasa_bcv <= 0) {
        throw httpError(400, 'No hay tasa BCV configurada para unificar las tasas');
      }
      // actualizarTasas leerá modo=solo_bcv (recién persistido) y forzará usd = bcv.
      const r = await PreciosService.actualizarTasas(
        t, prev.tasa_bcv, prev.tasa_bcv, usuario_id, ipCliente
      );
      usdFinal = r.tasa_usd;
    } else if (rawUsdNueva != null) {
      const usdNueva4 = PreciosService.redondearTasa4(rawUsdNueva);
      if (Number.isNaN(usdNueva4) || usdNueva4 <= 0) {
        throw httpError(400, 'La tasa USD proporcionada no es válida');
      }
      if (prev.tasa_bcv == null || prev.tasa_bcv <= 0) {
        throw httpError(400, 'No hay tasa BCV configurada');
      }
      if (usdNueva4 < prev.tasa_bcv) {
        throw httpError(400, 'La tasa USD no puede ser menor que la tasa BCV');
      }
      const r = await PreciosService.actualizarTasas(
        t, prev.tasa_bcv, usdNueva4, usuario_id, ipCliente
      );
      usdFinal = r.tasa_usd;
    }
    // multimoneda sin tasa_usd nueva → no se toca tasa_usd vigente.

    await registrarAuditoria(t, {
      usuario_id,
      accion: 'CAMBIAR_MODO_MONEDA',
      tabla_afectada: 'configuracion',
      registro_id: null,
      datos_anteriores: { modo_moneda_operacion: modoActual, tasa_usd: prev.tasa_usd },
      datos_nuevos: { modo_moneda_operacion: modo, tasa_usd: usdFinal },
      ip_address: ipCliente
    });

    return { modo_moneda_operacion: modo, tasa_bcv: prev.tasa_bcv, tasa_usd: usdFinal };
  });

  res.json({ ok: true, ...result });
}

/**
 * POST /api/configuracion/tasas
 * Body: { tasa_bcv, tasa_usd } o { bcv, usd }
 * Permite actualización parcial: si falta uno de los dos valores, se conserva el vigente en BD.
 */
async function saveTasas(req, res) {
  const body = req.body || {};
  const rawBcv =
    body.tasa_bcv !== undefined && body.tasa_bcv !== null
      ? body.tasa_bcv
      : body.bcv;
  const rawUsd =
    body.tasa_usd !== undefined && body.tasa_usd !== null ? body.tasa_usd : body.usd;

  const usuario_id = req.user && req.user.id ? Number(req.user.id) : null;
  if (!usuario_id || usuario_id < 1) {
    throw httpError(401, 'Usuario no autenticado');
  }

  const needsMerge = rawBcv === undefined || rawBcv === null || rawUsd === undefined || rawUsd === null;
  const ipCliente = clientIp(req);

  // Leer previo y escribir en una sola transacción para evitar race condition con job medianoche
  const result = await db.tx(async (t) => {
    let tasasBcvFinal = rawBcv;
    let tasasUsdFinal = rawUsd;

    if (needsMerge) {
      const prev = await PreciosService.leerTasasPreviasConfig(t);
      if (rawBcv === undefined || rawBcv === null) {
        if (prev.tasa_bcv == null) throw httpError(400, 'No hay tasa BCV configurada y no se proporcionó una nueva');
        tasasBcvFinal = prev.tasa_bcv;
      }
      if (rawUsd === undefined || rawUsd === null) {
        if (prev.tasa_usd == null) throw httpError(400, 'No hay tasa USD configurada y no se proporcionó una nueva');
        tasasUsdFinal = prev.tasa_usd;
      }
    }

    // actualizarTasas abre su propio db.tx() → al recibir 't' pg-promise usa savepoint anidado
    return PreciosService.actualizarTasas(t, tasasBcvFinal, tasasUsdFinal, usuario_id, ipCliente);
  });

  res.json({
    ok: true,
    tasa_bcv: result.tasa_bcv,
    tasa_usd: result.tasa_usd
  });
}

/** GET público para POS (vendedores sin config_read): % IVA de ventas. */
async function getImpuestoIvaVenta(req, res) {
  const pct = await PreciosService.leerImpuestoIvaPorcentaje(db);
  res.json({ impuesto_iva: pct });
}

/* ─── Estado del respaldo (archivos pg_dump + programa periódico) ─── */
async function getRespaldoStatus(req, res) {
  const status = await SyncService.getBackupStatus();
  const scheduler = await BackupScheduler.getPublicState(db);
  res.json({ ...status, scheduler });
}

/** PATCH programa de respaldos por intervalo (configuracion.backup_*). */
async function patchRespaldoScheduler(req, res) {
  const body = req.body || {};

  const autoExplicit = typeof body.backup_automatico !== 'undefined' ? Boolean(body.backup_automatico) : null;
  if (autoExplicit === null) throw httpError(400, 'Se requiere backup_automatico (boolean)');
  let minutos = Number.parseInt(body.intervalo_minutos, 10);
  if (!Number.isFinite(minutos)) throw httpError(400, 'intervalo_minutos inválido');

  minutos = Math.round(minutos);

  let minutosStored = minutos;

  const usuarioId =
    typeof req.user !== 'undefined' && req.user?.id !== undefined ? Number(req.user.id) || null : null;

  await db.tx(async (t) => {
    await t.none(
      `INSERT INTO configuracion (clave, valor, actualizado_en, actualizado_por)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (clave) DO UPDATE
       SET valor = EXCLUDED.valor, actualizado_en = NOW(), actualizado_por = EXCLUDED.actualizado_por`,
      [BackupScheduler.CFG_AUTO, autoExplicit ? 'true' : 'false', usuarioId]
    );

    if (autoExplicit) {
      if (
        minutos < BackupScheduler.MIN_SCHEDULE_MINUTES ||
        minutos > BackupScheduler.MAX_SCHEDULE_MINUTES
      ) {
        throw httpError(
          400,
          `intervalo_minutos debe estar entre ${BackupScheduler.MIN_SCHEDULE_MINUTES} y ${BackupScheduler.MAX_SCHEDULE_MINUTES}`
        );
      }
      minutosStored = Math.min(
        BackupScheduler.MAX_SCHEDULE_MINUTES,
        Math.max(BackupScheduler.MIN_SCHEDULE_MINUTES, minutosStored)
      );
      const horasTxt = BackupScheduler.intervaloMinutosAHorasTexto(minutosStored);
      await t.none(
        `INSERT INTO configuracion (clave, valor, actualizado_en, actualizado_por)
         VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (clave) DO UPDATE
         SET valor = EXCLUDED.valor, actualizado_en = NOW(), actualizado_por = EXCLUDED.actualizado_por`,
        [BackupScheduler.CFG_INTERVALO_HORAS, horasTxt, usuarioId]
      );
    }
  });

  await BackupScheduler.restart(db);

  const scheduler = await BackupScheduler.getPublicState(db);

  const rawEnvMs = process.env.NEXUS_BACKUP_INTERVAL_MINUTES;
  let avisoPrioridadEntorno = null;
  if (rawEnvMs !== undefined && rawEnvMs !== null && String(rawEnvMs).trim() !== '') {
    avisoPrioridadEntorno =
      'La variable NEXUS_BACKUP_INTERVAL_MINUTES está definida en el entorno; prevalece sobre la configuración guardada hasta eliminarla o vaciarla.';
  }

  res.json({
    ok: true,
    scheduler,
    aviso: avisoPrioridadEntorno
  });
}

async function getTasaBcvAuto(req, res) {
  const estado = await BcvTasaAutoService.leerEstado(db);
  res.json(estado);
}

async function patchTasaBcvAuto(req, res) {
  const body = req.body || {};
  if (typeof body.activo !== 'boolean') {
    throw httpError(400, 'Se requiere activo (boolean)');
  }
  const usuarioId = req.user?.id != null ? Number(req.user.id) : null;
  const estado = await BcvTasaAutoService.setActivo(
    db,
    body.activo,
    body.feriados,
    usuarioId
  );
  res.json({ ok: true, estado });
}

async function postTasaBcvAutoSync(req, res) {
  const r = await BcvTasaAutoService.sincronizarManual(db);
  res.json({ ok: true, resultado: r });
}

/**
 * Fuerza la aplicación inmediata de la tasa pendiente sin esperar a la medianoche
 * del día fecha valor. Solo disponible para admins (tasas_edit).
 * Útil cuando la tasa semilla inicial es obsoleta y ya existe un pendiente.
 */
async function postTasaBcvAutoForzarAplicar(req, res) {
  const aplicacion = await BcvTasaAutoService.intentarAplicarPendiente(db, {
    forzarInstalacionInicial: true
  });
  const estado = await BcvTasaAutoService.leerEstado(db);
  res.json({ ok: true, aplicacion, estado });
}

module.exports = {
  getAll:            asyncHandler(getAll),
  getTasasActuales:  asyncHandler(getTasasActuales),
  getImpuestoIvaVenta: asyncHandler(getImpuestoIvaVenta),
  updateGeneral:     asyncHandler(updateGeneral),
  patchModoMoneda:   asyncHandler(patchModoMoneda),
  saveTasas:         asyncHandler(saveTasas),
  getRespaldoStatus: asyncHandler(getRespaldoStatus),
  patchRespaldoScheduler: asyncHandler(patchRespaldoScheduler),
  getTasaBcvAuto:    asyncHandler(getTasaBcvAuto),
  patchTasaBcvAuto:  asyncHandler(patchTasaBcvAuto),
  postTasaBcvAutoSync: asyncHandler(postTasaBcvAutoSync),
  postTasaBcvAutoForzarAplicar: asyncHandler(postTasaBcvAutoForzarAplicar)
};
