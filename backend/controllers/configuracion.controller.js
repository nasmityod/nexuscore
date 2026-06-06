'use strict';

const { db } = require('../config/database');
const PreciosService = require('../services/preciosService');
const SyncService = require('../services/syncService');
const BackupScheduler = require('../services/backupScheduler');
const BcvTasaAutoService = require('../services/bcvTasaAutoService');
const ModoMonedaService = require('../services/modoMonedaService');
const { asyncHandler, httpError } = require('../utils/asyncHandler');
const { normalizarTelefonoMovilVeOpcional } = require('../utils/telefonoVe');
const { clientIp } = require('../middleware/audit.middleware');

const CLAVES_EMPRESA = [
  'empresa_nombre','empresa_rif','empresa_telefono','empresa_direccion',
  'empresa_email','empresa_logo_url',
  'impresora_interfaz','impresora_nombre','impresora_activa'
];

const CLAVES_MODO_MONEDA = [ModoMonedaService.CLAVE_MODO];

/* ─── GET /api/configuracion/tasas-actuales ─── */
async function getTasasActuales(req, res) {
  // Usar la misma fuente legal que ventas (respeta feriados y días no hábiles)
  const tasas = await PreciosService.obtenerTasasActuales(db);
  const modo_moneda_operacion = await ModoMonedaService.leerModo(db);
  res.json({
    tasa_bcv: tasas.tasa_bcv,
    tasa_usd: tasas.tasa_usd,
    bcv: tasas.tasa_bcv,
    usd: tasas.tasa_usd,
    modo_moneda_operacion,
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
  const updates = Object.entries(body).filter(
    ([k]) => CLAVES_EMPRESA.includes(k) || CLAVES_MODO_MONEDA.includes(k)
  );
  if (!updates.length) throw httpError(400, 'No hay parámetros válidos');

  await db.tx(async (t) => {
    for (const [clave, valor] of updates) {
      let strVal = String(valor ?? '').trim();
      if (CLAVES_MODO_MONEDA.includes(clave)) {
        const modo = strVal.toLowerCase();
        if (!ModoMonedaService.MODOS_VALIDOS.has(modo)) {
          throw httpError(400, 'modo_moneda_operacion debe ser multimoneda o solo_bcv');
        }
        strVal = modo;
      }
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
  saveTasas:         asyncHandler(saveTasas),
  getRespaldoStatus: asyncHandler(getRespaldoStatus),
  patchRespaldoScheduler: asyncHandler(patchRespaldoScheduler),
  getTasaBcvAuto:    asyncHandler(getTasaBcvAuto),
  patchTasaBcvAuto:  asyncHandler(patchTasaBcvAuto),
  postTasaBcvAutoSync: asyncHandler(postTasaBcvAutoSync),
  postTasaBcvAutoForzarAplicar: asyncHandler(postTasaBcvAutoForzarAplicar)
};
