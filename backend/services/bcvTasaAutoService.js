'use strict';

/**
 * Sincronización automática de tasa BCV oficial y feriados vía API privada (dayzove.lat).
 * ÚNICA salida HTTP permitida además de licenciaService (regla AISLAMIENTO-DE-RED);
 * la red la realiza bcvApiClient. La tasa publicada por el BCV rige desde las 00:00 del
 * día fecha valor (America/Caracas).
 *
 * Programación: una consulta diaria tras la publicación típica del BCV (~17:30 Caracas)
 * y aplicación a medianoche sin volver a llamar a la API. Los feriados se sincronizan
 * desde el servidor (año actual + siguiente) al arrancar, en la consulta diaria y a
 * petición; así, al actualizarlos en el servidor, el sistema los lee y la vigencia legal
 * de la tasa (días no hábiles) queda correcta sin tocar el cliente.
 */

const PreciosService = require('./preciosService');
const bcvApiClient = require('./bcvApiClient');
const bcvVigencia = require('../utils/bcvVigenciaVe');
const feriadosBcvVe = require('../utils/feriadosBcvVe');
const { logger } = require('../config/logger');

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
/** Metadatos de la sincronización de feriados desde el servidor. */
const CFG_FERIADOS_SYNC_TS = 'tasa_bcv_feriados_sync_ts';
const CFG_FERIADOS_FUENTE = 'tasa_bcv_feriados_fuente';
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
    CFG_FERIADOS_SYNC_TS,
    CFG_FERIADOS_FUENTE,
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
    feriados_sync_ts: map[CFG_FERIADOS_SYNC_TS] || null,
    feriados_fuente:
      map[CFG_FERIADOS_FUENTE] || (feriadosDesdeCalendario2026 ? 'local_calendario' : 'manual'),
    calendario_anio: feriadosBcvVe.ANIO_CALENDARIO,
    ...bcvApiClient.describirConexion()
  };
}

/**
 * Consulta la API privada BCV y guarda la tasa pendiente (no aplica hasta fecha valor).
 * @param {object} db
 */
async function consultarApiYGuardarPendiente(db) {
  const tasa = await bcvApiClient.obtenerTasa();

  const promedio = PreciosService.redondearTasa4(tasa.rate);
  if (!promedio || promedio <= 0 || Number.isNaN(promedio)) {
    throw new Error('bcvTasaAutoService: tasa inválida en la respuesta de la API BCV');
  }

  const fechaApi = tasa.effective_date;
  if (!fechaApi) {
    throw new Error('bcvTasaAutoService: fecha valor ausente o inválida en la API BCV');
  }

  // Cargar feriados para validar la fecha valor
  const feriadosRaw = (await leerClaves(db, [CFG_FERIADOS]))[CFG_FERIADOS];
  const feriados = feriadosBcvVe.feriadosEfectivos(feriadosRaw);
  const hoy = bcvVigencia.ymdCaracas();

  // La API entrega la fecha valor (día en que la tasa entra en vigencia, 00:00 Caracas).
  // Si la fecha valor es ESTRICTAMENTE anterior a hoy (dato obsoleto) o cae en día no hábil,
  // se avanza al siguiente día hábil para cumplir la normativa BCV.
  // Si la fecha valor es HOY (tasa ya vigente desde medianoche de hoy), NO se avanza:
  // esa tasa ya debería estar activa y se aplica de inmediato en intentarAplicarPendiente.
  let fechaValor = fechaApi;
  if (fechaValor < hoy || bcvVigencia.esDiaNoHabil(fechaValor, feriados)) {
    fechaValor = bcvVigencia.siguienteDiaHabilDesde(hoy, feriados);
    logger.warn('bcvTasaAutoService: fecha valor de la API no es día hábil futuro; ajustado a siguiente día hábil', {
      fecha_api: fechaApi,
      fecha_valor_ajustada: fechaValor
    });
  }

  await upsertConfig(db, CFG_PENDIENTE_VALOR, PreciosService.tasaATexto4(promedio));
  await upsertConfig(db, CFG_PENDIENTE_FECHA, fechaValor);
  await upsertConfig(db, CFG_ULTIMA_CONSULTA, new Date().toISOString());
  await upsertConfig(db, CFG_ULTIMO_ERROR, '');

  return { promedio, fecha_valor: fechaValor, fecha_api: fechaApi, fuente: tasa.fuente };
}

/**
 * Sincroniza el calendario de feriados desde el servidor (año actual + siguiente) y lo
 * persiste en configuracion.tasa_bcv_feriados_ve. Requiere NEXUS_BCV_API_KEY.
 *
 * Seguridad ante fallos parciales: solo reemplaza los feriados de los años que la API
 * respondió correctamente; los de un año que falló se conservan. Nunca vacía el calendario.
 * @param {object} db
 */
async function sincronizarFeriados(db) {
  if (!bcvApiClient.tieneApiKey()) {
    return { omitido: true, motivo: 'sin_api_key' };
  }

  const hoy = bcvVigencia.ymdCaracas();
  const anioActual = Number(hoy.slice(0, 4));
  const anios = [anioActual, anioActual + 1];

  const set = new Set();
  const aniosOk = new Set();
  const detalle = [];
  let algunaOk = false;

  for (const anio of anios) {
    try {
      const r = await bcvApiClient.obtenerFeriados(anio);
      r.fechas.forEach((f) => set.add(f));
      aniosOk.add(anio);
      algunaOk = true;
      detalle.push({ anio, cantidad: r.fechas.length });
    } catch (err) {
      detalle.push({ anio, error: err && err.message ? err.message : String(err) });
      logger.warn('bcvTasaAutoService: fallo al sincronizar feriados de un año', {
        anio,
        error: err && err.message ? err.message : String(err)
      });
    }
  }

  if (!algunaOk) {
    throw new Error('bcvTasaAutoService: no se pudieron sincronizar los feriados desde la API');
  }

  // Conservar feriados existentes de años cuya consulta NO tuvo éxito (no perder histórico).
  const existentes = feriadosBcvVe.feriadosEfectivos(
    (await leerClaves(db, [CFG_FERIADOS]))[CFG_FERIADOS]
  );
  existentes.forEach((f) => {
    const y = Number(String(f).slice(0, 4));
    if (!aniosOk.has(y)) set.add(f);
  });

  const lista = [...set].sort();
  if (lista.length === 0) {
    logger.warn('bcvTasaAutoService: la sincronización de feriados quedó vacía; se conserva el calendario actual');
    return { ok: true, total: 0, sin_cambios: true, anios: detalle };
  }

  await upsertConfig(db, CFG_FERIADOS, JSON.stringify(lista));
  await upsertConfig(db, CFG_FERIADOS_SYNC_TS, new Date().toISOString());
  await upsertConfig(db, CFG_FERIADOS_FUENTE, 'api');

  logger.info('bcvTasaAutoService: feriados sincronizados desde la API', {
    total: lista.length,
    anios: detalle
  });
  return { ok: true, total: lista.length, anios: detalle };
}

/** Sincroniza feriados sin propagar errores (uso en arranque / ciclo diario). */
async function sincronizarFeriadosSeguro(db) {
  try {
    return await sincronizarFeriados(db);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logger.warn('bcvTasaAutoService: sincronización de feriados falló', { error: msg });
    return { error: msg };
  }
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
    fuente: 'dayzove',
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

  // Refrescar feriados antes de validar la fecha valor (la vigencia depende de ellos).
  await sincronizarFeriadosSeguro(db);

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

  const conKey = bcvApiClient.tieneApiKey();
  if (!conKey) {
    logger.warn(
      'bcvTasaAutoService: sin NEXUS_BCV_API_KEY; los feriados usarán el calendario local y la tasa el endpoint público. Define la clave para sincronizar feriados del servidor.',
      bcvApiClient.describirConexion()
    );
  }

  const estado = await leerEstado(db);
  if (!estado.activo) {
    // Aunque la tasa automática esté apagada, sincronizar feriados al arrancar (si hay clave):
    // afectan la vigencia legal de la tasa incluso cuando se actualiza manualmente.
    if (conKey) {
      setTimeout(() => {
        sincronizarFeriadosSeguro(db).catch(() => {});
      }, 20 * 1000);
    }
    logger.info('bcvTasaAutoService: sincronización BCV automática desactivada');
    return { activo: false, api: bcvApiClient.describirConexion() };
  }

  // En primera instalación (sin consulta previa) ejecutar el ciclo completo de inmediato
  // para reemplazar la tasa semilla obsoleta antes de esperar el ciclo diario de las 17:30.
  const esInstalacionInicial = !estado.ultima_consulta;
  const delayArranqueMs = esInstalacionInicial ? 15 * 1000 : 2 * 60 * 1000;

  setTimeout(() => {
    if (!runningSync) {
      const tarea = async () => {
        // Feriados primero (afectan la vigencia), luego la tasa.
        await sincronizarFeriadosSeguro(db);
        return esInstalacionInicial
          ? ejecutarCicloInicial(db)
          : ejecutarAplicacionMedianoche(db);
      };
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
    instalacion_inicial: esInstalacionInicial,
    ...bcvApiClient.describirConexion()
  });

  return { activo: true, consulta_diaria_hora: etiquetaConsultaDiaria(), api: bcvApiClient.describirConexion() };
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

/** Sincroniza solo los feriados desde el servidor (sin tocar la tasa). */
async function sincronizarFeriadosManual(db) {
  const resultado = await sincronizarFeriados(db);
  const estado = await leerEstado(db);
  return { resultado, estado };
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
    // Edición desde el formulario: el calendario pasa a ser una corrección manual
    // (la sincronización desde el servidor lo volverá a marcar como 'api').
    await upsertConfig(db, CFG_FERIADOS_FUENTE, 'manual');
  }
  void usuarioId;
  await restart(db);
  return leerEstado(db);
}

module.exports = {
  CFG_AUTO,
  CFG_FERIADOS,
  CFG_FERIADOS_SYNC_TS,
  CFG_FERIADOS_FUENTE,
  CONSULTA_DIARIA_HORA,
  CONSULTA_DIARIA_MINUTO,
  leerEstado,
  consultarApiYGuardarPendiente,
  intentarAplicarPendiente,
  ejecutarCiclo,
  ejecutarCicloInicial,
  sincronizarManual,
  sincronizarFeriados,
  sincronizarFeriadosManual,
  setActivo,
  start,
  stop,
  restart
};
