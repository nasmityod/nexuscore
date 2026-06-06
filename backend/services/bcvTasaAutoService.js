'use strict';

/**
 * Sincronización automática de tasa BCV oficial vía dolarapi.
 * ÚNICA salida HTTP permitida además de licenciaService (regla AISLAMIENTO-DE-RED).
 * La tasa publicada por el BCV rige desde las 00:00 del día fecha valor (America/Caracas).
 *
 * Programación: una consulta diaria tras la publicación típica del BCV (~17:30 Caracas)
 * y aplicación a medianoche sin volver a llamar a la API.
 */

const PreciosService = require('./preciosService');
const bcvVigencia = require('../utils/bcvVigenciaVe');
const feriadosBcvVe = require('../utils/feriadosBcvVe');
const { logger } = require('../config/logger');

/** API pública BCV oficial — no requiere credenciales ni variable de entorno */
const DOLARAPI_BCV_OFICIAL_URL = 'https://ve.dolarapi.com/v1/dolares/oficial';

/** Hora local Venezuela para consultar la tasa del día (publicación BCV ~16:00–17:00) */
const CONSULTA_DIARIA_HORA = 17;
const CONSULTA_DIARIA_MINUTO = 30;

const CFG_AUTO = 'tasa_bcv_auto_activo';
const CFG_PENDIENTE_VALOR = 'tasa_bcv_auto_pendiente';
const CFG_PENDIENTE_FECHA = 'tasa_bcv_auto_fecha_valor';
const CFG_ULTIMA_CONSULTA = 'tasa_bcv_auto_ultima_consulta';
const CFG_ULTIMO_APLICADO = 'tasa_bcv_auto_ultima_aplicacion';
const CFG_ULTIMO_ERROR = 'tasa_bcv_auto_ultimo_error';
const CFG_FERIADOS = 'tasa_bcv_feriados_ve';
/** Registro de ajuste automático de USD al ser menor que BCV (aviso al admin en UI) */
const CFG_USD_AJUSTE_TS = 'bcv_auto_usd_ajuste_ts';
const CFG_USD_AJUSTE_DE = 'bcv_auto_usd_ajuste_de';
const CFG_USD_AJUSTE_A = 'bcv_auto_usd_ajuste_a';

let consultaDiariaTimer = null;
let midnightTimer = null;
let runningSync = null;

function isTruthy(raw) {
  const x = String(raw ?? '').trim().toLowerCase();
  return x === 'true' || x === '1' || x === 'yes' || x === 'si' || x === 'sí';
}

function parseAutoEnv() {
  const raw = process.env.NEXUS_TASA_BCV_AUTO;
  if (raw === undefined || String(raw).trim() === '') return null;
  return isTruthy(raw);
}

function etiquetaConsultaDiaria() {
  const h = String(CONSULTA_DIARIA_HORA).padStart(2, '0');
  const m = String(CONSULTA_DIARIA_MINUTO).padStart(2, '0');
  return `${h}:${m} (${bcvVigencia.TZ})`;
}

async function leerClaves(db, claves) {
  const rows = await db.any(`SELECT clave, valor FROM configuracion WHERE clave IN ($1:csv)`, [claves]);
  const map = {};
  rows.forEach((r) => {
    map[r.clave] = r.valor;
  });
  return map;
}

async function upsertConfig(db, clave, valor) {
  await db.none(
    `INSERT INTO configuracion (clave, valor, categoria)
     VALUES ($1, $2, 'moneda')
     ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
    [clave, valor == null ? '' : String(valor)]
  );
}

/**
 * @param {object} db
 */
async function leerEstado(db) {
  const map = await leerClaves(db, [
    CFG_AUTO,
    CFG_PENDIENTE_VALOR,
    CFG_PENDIENTE_FECHA,
    CFG_ULTIMA_CONSULTA,
    CFG_ULTIMO_APLICADO,
    CFG_ULTIMO_ERROR,
    CFG_FERIADOS,
    'tasa_bcv',
    CFG_USD_AJUSTE_TS,
    CFG_USD_AJUSTE_DE,
    CFG_USD_AJUSTE_A
  ]);

  const envAuto = parseAutoEnv();
  const autoBd = map[CFG_AUTO];
  const activo = envAuto !== null ? envAuto : autoBd == null ? true : isTruthy(autoBd);

  const feriados = feriadosBcvVe.feriadosEfectivos(map[CFG_FERIADOS]);
  const feriadosDesdeCalendario2026 = feriadosBcvVe.feriadosDbEstaVacio(map[CFG_FERIADOS]);
  const fechaValor = map[CFG_PENDIENTE_FECHA]
    ? bcvVigencia.parseFechaValorApi(map[CFG_PENDIENTE_FECHA])
    : null;
  const pendienteValor = map[CFG_PENDIENTE_VALOR]
    ? PreciosService.redondearTasa4(map[CFG_PENDIENTE_VALOR])
    : null;

  const vigencia =
    fechaValor && pendienteValor
      ? bcvVigencia.debeAplicarTasaPendiente(fechaValor, feriados)
      : { aplicar: false, motivo: 'sin_pendiente' };

  let diaRef = null;
  let congelada = false;
  try {
    const hoy = bcvVigencia.ymdCaracas();
    diaRef = bcvVigencia.diaHabilReferenciaTransaccion(hoy, feriados);
    congelada = hoy !== diaRef;
  } catch {
    /* noop */
  }

  return {
    activo,
    desde_entorno_auto: envAuto !== null,
    consulta_diaria_hora: etiquetaConsultaDiaria(),
    tasa_bcv_actual: map.tasa_bcv ? PreciosService.redondearTasa4(map.tasa_bcv) : null,
    pendiente: pendienteValor,
    pendiente_fecha_valor: fechaValor,
    pendiente_puede_aplicar: vigencia.aplicar,
    pendiente_motivo: vigencia.motivo,
    hoy_caracas: bcvVigencia.ymdCaracas(),
    dia_habil_referencia: diaRef,
    tasa_congelada_fin_semana_feriado: congelada,
    ultima_consulta: map[CFG_ULTIMA_CONSULTA] || null,
    ultima_aplicacion: map[CFG_ULTIMO_APLICADO] || null,
    ultimo_error: map[CFG_ULTIMO_ERROR] || null,
    usd_ajuste_ts: map[CFG_USD_AJUSTE_TS] || null,
    usd_ajuste_de: map[CFG_USD_AJUSTE_DE] ? parseFloat(map[CFG_USD_AJUSTE_DE]) : null,
    usd_ajuste_a: map[CFG_USD_AJUSTE_A] ? parseFloat(map[CFG_USD_AJUSTE_A]) : null,
    feriados: [...feriados].sort(),
    feriados_cantidad: feriados.size,
    feriados_bd_vacio: feriadosDesdeCalendario2026,
    calendario_anio: feriadosBcvVe.ANIO_CALENDARIO,
    api_url: DOLARAPI_BCV_OFICIAL_URL
  };
}

/**
 * Consulta dolarapi y guarda tasa pendiente (no aplica hasta fecha valor).
 * @param {object} db
 */
async function consultarApiYGuardarPendiente(db) {
  const url = DOLARAPI_BCV_OFICIAL_URL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  let payload;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) {
      throw new Error(`bcvTasaAutoService: HTTP ${res.status} al consultar tasa oficial`);
    }
    payload = await res.json();
  } finally {
    clearTimeout(timeout);
  }

  const promedio = PreciosService.redondearTasa4(payload && payload.promedio);
  if (!promedio || promedio <= 0 || Number.isNaN(promedio)) {
    throw new Error('bcvTasaAutoService: promedio inválido en respuesta de dolarapi');
  }

  const fechaApi = bcvVigencia.parseFechaValorApi(
    payload && (payload.fechaActualizacion || payload.fecha_actualizacion)
  );
  if (!fechaApi) {
    throw new Error('bcvTasaAutoService: fechaActualizacion ausente o inválida en dolarapi');
  }

  // Cargar feriados para validar la fecha valor
  const feriadosRaw = (await leerClaves(db, [CFG_FERIADOS]))[CFG_FERIADOS];
  const feriados = feriadosBcvVe.feriadosEfectivos(feriadosRaw);
  const hoy = bcvVigencia.ymdCaracas();

  // La API devuelve fechaActualizacion = fecha valor (día en que la tasa entra en vigencia).
  // Si la fecha valor es ESTRICTAMENTE anterior a hoy (dato obsoleto) o cae en día no hábil,
  // se avanza al siguiente día hábil para cumplir la normativa BCV.
  // Si la fecha valor es HOY (tasa ya vigente desde medianoche de hoy), NO se avanza:
  // esa tasa ya debería estar activa y se aplica de inmediato en intentarAplicarPendiente.
  let fechaValor = fechaApi;
  if (fechaValor < hoy || bcvVigencia.esDiaNoHabil(fechaValor, feriados)) {
    fechaValor = bcvVigencia.siguienteDiaHabilDesde(hoy, feriados);
    logger.warn('bcvTasaAutoService: fechaActualizacion API no es día hábil futuro; ajustado a siguiente día hábil', {
      fecha_api: fechaApi,
      fecha_valor_ajustada: fechaValor
    });
  }

  await upsertConfig(db, CFG_PENDIENTE_VALOR, PreciosService.tasaATexto4(promedio));
  await upsertConfig(db, CFG_PENDIENTE_FECHA, fechaValor);
  await upsertConfig(db, CFG_ULTIMA_CONSULTA, new Date().toISOString());
  await upsertConfig(db, CFG_ULTIMO_ERROR, '');

  return { promedio, fecha_valor: fechaValor, fecha_api: fechaApi, fuente: payload.fuente || 'oficial' };
}

/**
 * Aplica la tasa pendiente si ya corresponde por fecha valor (medianoche Caracas).
 * @param {object} db
 * @param {{ forzarInstalacionInicial?: boolean }} [opts]
 *   forzarInstalacionInicial=true salta la verificación de fecha valor; se usa solo en
 *   el ciclo inicial de primera instalación para reemplazar la tasa semilla obsoleta.
 */
async function intentarAplicarPendiente(db, { forzarInstalacionInicial = false } = {}) {
  const map = await leerClaves(db, [
    CFG_PENDIENTE_VALOR,
    CFG_PENDIENTE_FECHA,
    CFG_FERIADOS,
    'tasa_bcv',
    'tasa_usd'
  ]);

  const fechaValor = bcvVigencia.parseFechaValorApi(map[CFG_PENDIENTE_FECHA]);
  const pendiente = map[CFG_PENDIENTE_VALOR]
    ? PreciosService.redondearTasa4(map[CFG_PENDIENTE_VALOR])
    : null;

  if (!fechaValor || !pendiente || pendiente <= 0) {
    return { aplicado: false, motivo: 'sin_pendiente' };
  }

  const feriados = feriadosBcvVe.feriadosEfectivos(map[CFG_FERIADOS]);
  const vigencia = bcvVigencia.debeAplicarTasaPendiente(fechaValor, feriados);
  if (!vigencia.aplicar && !forzarInstalacionInicial) {
    return { aplicado: false, motivo: vigencia.motivo, fecha_valor: fechaValor };
  }

  const actual = map.tasa_bcv ? PreciosService.redondearTasa4(map.tasa_bcv) : null;
  if (actual != null && Math.abs(actual - pendiente) < 0.00005) {
    await upsertConfig(db, CFG_ULTIMO_APLICADO, new Date().toISOString());
    return { aplicado: false, motivo: 'ya_activa', tasa_bcv: actual };
  }

  const prevUsd =
    map.tasa_usd != null ? PreciosService.redondearTasa4(map.tasa_usd) : null;

  if (!prevUsd || prevUsd <= 0) {
    throw new Error(
      'bcvTasaAutoService: configure tasa USD antes de aplicar tasa BCV automática'
    );
  }

  const usdSeraAjustado = prevUsd < pendiente;
  if (usdSeraAjustado) {
    logger.warn('bcvTasaAutoService: tasa USD menor que BCV; se ajustará al aplicar BCV', {
      tasa_usd: prevUsd,
      bcv: pendiente
    });
  }

  const result = await PreciosService.actualizarTasaBcvAutomatica(db, pendiente, {
    fecha_valor: fechaValor,
    fuente: 'dolarapi',
    tasa_usd_previa: prevUsd
  });

  await upsertConfig(db, CFG_ULTIMO_APLICADO, new Date().toISOString());
  await upsertConfig(db, CFG_ULTIMO_ERROR, '');

  if (usdSeraAjustado) {
    await upsertConfig(db, CFG_USD_AJUSTE_TS, new Date().toISOString());
    await upsertConfig(db, CFG_USD_AJUSTE_DE, String(prevUsd));
    await upsertConfig(db, CFG_USD_AJUSTE_A, String(result.tasa_usd != null ? result.tasa_usd : pendiente));
  }

  return {
    aplicado: true,
    tasa_bcv: result.tasa_bcv,
    fecha_valor: fechaValor
  };
}

async function ejecutarConsultaDiaria(db) {
  const estado = await leerEstado(db);
  if (!estado.activo) return { omitido: true };

  const feriados = feriadosBcvVe.feriadosEfectivos(
    (await leerClaves(db, [CFG_FERIADOS]))[CFG_FERIADOS]
  );
  const hoy = bcvVigencia.ymdCaracas();
  if (!bcvVigencia.esDiaPosiblePublicacionBcv(hoy, feriados)) {
    logger.info('bcvTasaAutoService: sin consulta API (día no hábil / fin de semana)', {
      hoy
    });
    return { omitido: true, motivo: 'dia_sin_publicacion_bcv' };
  }

  try {
    const consulta = await consultarApiYGuardarPendiente(db);
    logger.info('bcvTasaAutoService: consulta diaria API completada', {
      promedio: consulta.promedio,
      fecha_valor: consulta.fecha_valor
    });
    return { consulta };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    await upsertConfig(db, CFG_ULTIMO_ERROR, msg.slice(0, 500));
    logger.warn('bcvTasaAutoService: fallo consulta diaria API', { error: msg });
    return { error: msg };
  }
}

/** Consulta API; en manual también intenta aplicar si ya es día fecha valor (medianoche cumplida). */
async function ejecutarCiclo(db) {
  const consulta = await ejecutarConsultaDiaria(db);
  let aplicacion = null;
  try {
    aplicacion = await intentarAplicarPendiente(db);
    if (aplicacion.aplicado) {
      logger.info('bcvTasaAutoService: tasa BCV aplicada (sincronización manual o arranque)', {
        tasa_bcv: aplicacion.tasa_bcv,
        fecha_valor: aplicacion.fecha_valor
      });
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    await upsertConfig(db, CFG_ULTIMO_ERROR, msg.slice(0, 500));
    logger.error('bcvTasaAutoService: fallo al aplicar en ciclo completo', { error: msg });
  }
  return { ...consulta, aplicacion };
}

async function ejecutarAplicacionMedianoche(db) {
  const estado = await leerEstado(db);
  if (!estado.activo) return { omitido: true };

  try {
    const aplicacion = await intentarAplicarPendiente(db);
    if (aplicacion.aplicado) {
      logger.info('bcvTasaAutoService: tasa BCV aplicada a medianoche', {
        tasa_bcv: aplicacion.tasa_bcv,
        fecha_valor: aplicacion.fecha_valor
      });
    }
    return { aplicacion };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    await upsertConfig(db, CFG_ULTIMO_ERROR, msg.slice(0, 500));
    logger.error('bcvTasaAutoService: fallo aplicación medianoche', { error: msg });
    throw err;
  }
}

/**
 * Ciclo inicial de primera instalación: consulta la API sin restricción de día hábil
 * y aplica la tasa de inmediato (saltando la espera hasta medianoche del día fecha valor).
 * Reemplaza la tasa semilla obsoleta con la tasa más reciente del BCV al arrancar.
 * @param {object} db
 */
async function ejecutarCicloInicial(db) {
  let resultadoConsulta = null;
  try {
    resultadoConsulta = await consultarApiYGuardarPendiente(db);
    logger.info('bcvTasaAutoService: consulta inicial (primera instalación) completada', {
      promedio: resultadoConsulta.promedio,
      fecha_valor: resultadoConsulta.fecha_valor
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    await upsertConfig(db, CFG_ULTIMO_ERROR, msg.slice(0, 500));
    logger.warn('bcvTasaAutoService: fallo en consulta inicial; la tasa semilla permanece hasta el ciclo diario', {
      error: msg
    });
    return { error: msg };
  }

  try {
    const aplicacion = await intentarAplicarPendiente(db, { forzarInstalacionInicial: true });
    if (aplicacion.aplicado) {
      logger.info('bcvTasaAutoService: tasa BCV inicial aplicada (primera instalación)', {
        tasa_bcv: aplicacion.tasa_bcv,
        fecha_valor: aplicacion.fecha_valor
      });
    }
    return { consulta: resultadoConsulta, aplicacion };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    await upsertConfig(db, CFG_ULTIMO_ERROR, msg.slice(0, 500));
    logger.error('bcvTasaAutoService: fallo al aplicar tasa inicial', { error: msg });
    return { consulta: resultadoConsulta, error_aplicacion: msg };
  }
}

function limpiarTemporizadores() {
  if (consultaDiariaTimer) {
    clearTimeout(consultaDiariaTimer);
    consultaDiariaTimer = null;
  }
  if (midnightTimer) {
    clearTimeout(midnightTimer);
    midnightTimer = null;
  }
}

function programarConsultaDiaria(db) {
  const ms = bcvVigencia.msHastaProximaHoraCaracas(CONSULTA_DIARIA_HORA, CONSULTA_DIARIA_MINUTO, 0);
  consultaDiariaTimer = setTimeout(() => {
    consultaDiariaTimer = null;
    if (!runningSync) {
      runningSync = ejecutarConsultaDiaria(db)
        .catch((e) => logger.error('bcvTasaAutoService consulta diaria', { error: e.message }))
        .finally(() => {
          runningSync = null;
        });
    }
    programarConsultaDiaria(db);
  }, ms);
}

function programarMedianoche(db) {
  const ms = bcvVigencia.msHastaProximaMedianocheCaracas();
  midnightTimer = setTimeout(() => {
    midnightTimer = null;
    const job = ejecutarAplicacionMedianoche(db).catch((e) =>
      logger.error('bcvTasaAutoService medianoche', { error: e.message })
    );
    if (!runningSync) {
      runningSync = job.finally(() => {
        runningSync = null;
      });
    } else {
      job.catch(() => {});
    }
    programarMedianoche(db);
  }, ms);
}

/**
 * @param {object} db
 */
async function start(db) {
  limpiarTemporizadores();

  const estado = await leerEstado(db);
  if (!estado.activo) {
    logger.info('bcvTasaAutoService: sincronización BCV automática desactivada');
    return { activo: false };
  }

  // En primera instalación (sin consulta previa) ejecutar el ciclo completo de inmediato
  // para reemplazar la tasa semilla obsoleta antes de esperar el ciclo diario de las 17:30.
  const esInstalacionInicial = !estado.ultima_consulta;
  const delayArranqueMs = esInstalacionInicial ? 15 * 1000 : 2 * 60 * 1000;

  setTimeout(() => {
    if (!runningSync) {
      const tarea = esInstalacionInicial
        ? () => ejecutarCicloInicial(db)
        : () => ejecutarAplicacionMedianoche(db);
      runningSync = tarea()
        .catch((e) => logger.error('bcvTasaAutoService arranque', { error: e.message }))
        .finally(() => {
          runningSync = null;
        });
    }
  }, delayArranqueMs);

  programarConsultaDiaria(db);
  programarMedianoche(db);

  logger.info('bcvTasaAutoService: programador iniciado (consulta 1×/día, aplicación a medianoche)', {
    consulta_diaria: etiquetaConsultaDiaria(),
    instalacion_inicial: esInstalacionInicial
  });

  return { activo: true, consulta_diaria_hora: etiquetaConsultaDiaria() };
}

function stop() {
  limpiarTemporizadores();
}

async function restart(db) {
  stop();
  return start(db);
}

async function sincronizarManual(db) {
  if (runningSync) await runningSync.catch(() => {});
  const r = await ejecutarCiclo(db);
  return leerEstado(db).then((estado) => ({ ...r, estado }));
}

async function setActivo(db, activo, feriadosJson, usuarioId) {
  await upsertConfig(db, CFG_AUTO, activo ? 'true' : 'false');
  if (feriadosJson !== undefined) {
    let texto = '[]';
    if (Array.isArray(feriadosJson)) {
      texto = JSON.stringify(feriadosJson);
    } else if (typeof feriadosJson === 'string') {
      const t = feriadosJson.trim();
      if (t === '' || t === '[]') {
        texto = feriadosBcvVe.jsonFeriados2026();
      } else {
        feriadosBcvVe.feriadosEfectivos(t);
        texto = t;
      }
    }
    await upsertConfig(db, CFG_FERIADOS, texto);
  }
  void usuarioId;
  await restart(db);
  return leerEstado(db);
}

module.exports = {
  CFG_AUTO,
  CFG_FERIADOS,
  DOLARAPI_BCV_OFICIAL_URL,
  CONSULTA_DIARIA_HORA,
  CONSULTA_DIARIA_MINUTO,
  leerEstado,
  consultarApiYGuardarPendiente,
  intentarAplicarPendiente,
  ejecutarCiclo,
  ejecutarCicloInicial,
  sincronizarManual,
  setActivo,
  start,
  stop,
  restart
};
