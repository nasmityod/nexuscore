'use strict';

const SyncService = require('./syncService');
const { logger } = require('../config/logger');

/** Almacenamiento en tabla `configuracion` desde 001_initial_schema.sql */
const CFG_AUTO = 'backup_automatico';
const CFG_INTERVALO_HORAS = 'backup_intervalo_horas';

const MIN_MINUTES = 15;
const MAX_MINUTES = 10080; // 7 días
const FALLBACK_INTERVALO_HORAS = 24;

let intervalTimer = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let initialBackupTimeout = null;
/** @type {Promise<void>|null} */
let runningBackup = null;

function clampMinutes(m) {
  if (!Number.isFinite(m)) return FALLBACK_INTERVALO_HORAS * 60;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(m)));
}

function isTruthyBackupAuto(raw) {
  const x = String(raw ?? '').trim().toLowerCase();
  return x === 'true' || x === '1' || x === 'yes' || x === 'si' || x === 'sí';
}

/** @returns {{ minutos: number, horasTextoOriginal: string } | null } */
function intervaloHorasBdAMinutos(horasTextoOriginal) {
  const h = Number.parseFloat(String(horasTextoOriginal ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(h) || h <= 0) return null;
  return { minutos: clampMinutes(Math.round(h * 60)), horasTextoOriginal: String(horasTextoOriginal) };
}

/**
 * @returns {number|null} valor entero de minutos, o null si la variable no aplica / no existe
 */
function parseEnvIntervalMinutes() {
  const raw = process.env.NEXUS_BACKUP_INTERVAL_MINUTES;
  if (raw === undefined || String(raw).trim() === '') return null;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0 || n > MAX_MINUTES) {
    logger.warn('Nexus backupScheduler: NEXUS_BACKUP_INTERVAL_MINUTES inválido; usando configuración en BD.', {
      valor: raw,
      esperadoEnteroMin: 0,
      esperadoEnteroMax: MAX_MINUTES
    });
    return null;
  }
  return n;
}

async function leerBackupConfigDb(db) {
  const rows = await db.any(
    `SELECT clave, valor FROM configuracion WHERE clave IN ($1, $2)`,
    [CFG_AUTO, CFG_INTERVALO_HORAS]
  );
  const map = {};
  rows.forEach((r) => {
    map[r.clave] = r.valor;
  });
  return {
    backup_automatico: map[CFG_AUTO],
    backup_intervalo_horas: map[CFG_INTERVALO_HORAS]
  };
}

/**
 * Interpreta configuración efectiva para el temporizador.
 * Prioridad: NEXUS_BACKUP_INTERVAL_MINUTES (si existe y es válido) > claves BD.
 *
 * @param {object} db
 * @returns {Promise<{
 *   programa_activo: boolean,
 *   efectivo_minutos: number,
 *   desde_entorno: boolean,
 *   bd_backup_automatico: string|null,
 *   bd_backup_intervalo_horas: string|null,
 *   intervalo_minutos_leido_bd: number
 * }>}
 */
async function computeSchedule(db) {
  const envM = parseEnvIntervalMinutes();

  let bdAutomaticoStr = null;
  let bdHorasStr = null;
  try {
    const bd = await leerBackupConfigDb(db);
    bdAutomaticoStr =
      bd.backup_automatico !== undefined ? String(bd.backup_automatico) : null;
    bdHorasStr =
      bd.backup_intervalo_horas !== undefined ? String(bd.backup_intervalo_horas) : null;
  } catch (e) {
    logger.warn('Nexus backupScheduler: no se pudo leer configuracion', { error: e.message });
  }

  let intervaloBdMin = FALLBACK_INTERVALO_HORAS * 60;
  const conv = intervaloHorasBdAMinutos(bdHorasStr);
  if (conv) intervaloBdMin = conv.minutos;

  if (envM !== null) {
    const activo = envM > 0;
    return {
      programa_activo: activo,
      efectivo_minutos: activo ? clampMinutes(envM) : 0,
      desde_entorno: true,
      bd_backup_automatico: bdAutomaticoStr,
      bd_backup_intervalo_horas: bdHorasStr,
      intervalo_minutos_leido_bd: intervaloBdMin
    };
  }

  const autoBd = bdAutomaticoStr == null ? true : isTruthyBackupAuto(bdAutomaticoStr);
  if (!autoBd) {
    return {
      programa_activo: false,
      efectivo_minutos: 0,
      desde_entorno: false,
      bd_backup_automatico: bdAutomaticoStr,
      bd_backup_intervalo_horas: bdHorasStr,
      intervalo_minutos_leido_bd: intervaloBdMin
    };
  }

  return {
    programa_activo: true,
    efectivo_minutos: intervaloBdMin,
    desde_entorno: false,
    bd_backup_automatico: bdAutomaticoStr,
    bd_backup_intervalo_horas: bdHorasStr,
    intervalo_minutos_leido_bd: intervaloBdMin
  };
}

function limpiarTemporizador() {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
  if (initialBackupTimeout) {
    clearTimeout(initialBackupTimeout);
    initialBackupTimeout = null;
  }
}

async function ejecutarTickProgramado() {
  if (runningBackup) await runningBackup.catch(() => {});
  if (runningBackup) return;

  runningBackup = (async () => {
    logger.info('Nexus backupScheduler: iniciando respaldo programado');
    try {
      const r = await SyncService.runFullBackup({ source: 'scheduled' });
      if (!r.ok) {
        logger.warn('Nexus backupScheduler: respaldo programado falló', {
          error: String(r.error || '').split('\n')[0]
        });
      }
    } catch (err) {
      logger.error('Nexus backupScheduler: error inesperado en respaldo programado', {
        error: err.message
      });
    }
  })();
  try {
    await runningBackup;
  } finally {
    runningBackup = null;
  }
}

/**
 * Inicia temporizador periódico según configuración efectiva actual.
 *
 * @param {object} db
 */
async function start(db) {
  limpiarTemporizador();
  let schedule;
  try {
    schedule = await computeSchedule(db);
  } catch (e) {
    logger.warn('Nexus backupScheduler.start: omitido por error computeSchedule', { error: e.message });
    return { activo: false, mensaje: e.message };
  }

  if (!schedule.programa_activo || schedule.efectivo_minutos <= 0) {
    logger.info('Nexus backupScheduler: programa periódico desactivado', {
      desde_entorno: schedule.desde_entorno,
      efectivo_minutos: schedule.efectivo_minutos,
      programa_activo: schedule.programa_activo
    });
    return { activo: false, schedule };
  }

  const ms = schedule.efectivo_minutos * 60 * 1000;
  const primeraEspera = Math.min(ms, 5 * 60 * 1000);

  initialBackupTimeout = setTimeout(() => {
    initialBackupTimeout = null;
    ejecutarTickProgramado()
      .catch((err) => {
        logger.error('Nexus backupScheduler primera corrida programada', { error: err.message });
      })
      .finally(() => {
        intervalTimer = setInterval(() => {
          ejecutarTickProgramado().catch((err) => {
            logger.error('Nexus backupScheduler tick', { error: err.message });
          });
        }, ms);
      });
  }, primeraEspera);

  logger.info('Nexus backupScheduler: primera corrida periódica en segundos', {
    siguiente_en_s: Math.round(primeraEspera / 1000),
    repetir_cada_min: schedule.efectivo_minutos,
    desde_entorno: schedule.desde_entorno
  });

  return { activo: true, schedule };
}

function stop() {
  limpiarTemporizador();
}

async function restart(db) {
  stop();
  return start(db);
}

/**
 * Datos combinados para API (GET /api/configuracion/respaldo).
 *
 * @param {object} db
 */
async function getPublicState(db) {
  const sch = await computeSchedule(db);
  return {
    programa_activo: sch.programa_activo,
    efectivo_minutos: sch.efectivo_minutos,
    desde_entorno: sch.desde_entorno,
    bd: {
      backup_automatico: sch.bd_backup_automatico,
      backup_intervalo_horas: sch.bd_backup_intervalo_horas,
      intervalo_minutos: sch.intervalo_minutos_leido_bd
    },
    rangos_minutos: { min: MIN_MINUTES, max: MAX_MINUTES },
    intervalo_horas_fallback: FALLBACK_INTERVALO_HORAS
  };
}

function intervaloMinutosAHorasTexto(totalMinRounded) {
  const m = Number(totalMinRounded);
  if (!Number.isFinite(m) || m <= 0) return String(FALLBACK_INTERVALO_HORAS);
  const h = m / 60;
  let s = h.toPrecision(14);
  s = parseFloat(s).toString();
  return s;
}

module.exports = {
  computeSchedule,
  start,
  stop,
  restart,
  getPublicState,
  intervaloMinutosAHorasTexto,
  CFG_AUTO,
  CFG_INTERVALO_HORAS,
  MIN_SCHEDULE_MINUTES: MIN_MINUTES,
  MAX_SCHEDULE_MINUTES: MAX_MINUTES
};
