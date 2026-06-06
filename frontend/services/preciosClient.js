'use strict';

/**
 * Espejo de backend/services/preciosService.js para el navegador.
 * tasa_bcv = USD BCV (Bs/USD). tasa_usd = tasa USD mercado (Bs/USD).
 */
(function () {
  var COSTO_DECIMALES = 4;
  var GANANCIA_DECIMALES = 2;
  var PRECIO_USD_EFECTIVO_DECIMALES = 2;
  var PRECIO_BS_USD_DECIMALES = 2;
  var TASA_DECIMALES = 4;

  function redondearTasa4(valor) {
    var num =
      typeof valor === 'string'
        ? Number(String(valor).trim().replace(/\s/g, '').replace(',', '.'))
        : Number(valor);
    if (Number.isNaN(num)) return NaN;
    return Math.round(num * 10000) / 10000;
  }

  function assertTasasPositivas(tasaBcv, tasaUsd) {
    if (!tasaBcv || tasaBcv <= 0 || Number.isNaN(tasaBcv)) {
      throw new Error('La tasa USD BCV (Bs por dólar) debe ser mayor a 0');
    }
    if (!tasaUsd || tasaUsd <= 0 || Number.isNaN(tasaUsd)) {
      throw new Error('La tasa USD (Bs por dólar) debe ser mayor a 0');
    }
  }

  /** bs_usd round(pe*tasa_usd, 2) → ref. USD BCV (2 decimales) y Bs con tasa_bcv escalada ×10000 (coherencia con backend). */
  function precioBolivaresRefBcvDesdeBsUsd(bsUsdEquiv2d, tasaBcv4d) {
    var bcvScaled = Math.round(tasaBcv4d * 10000);
    var montoBsRed2 =
      Math.round(Number(bsUsdEquiv2d) * Math.pow(10, PRECIO_BS_USD_DECIMALES)) /
      Math.pow(10, PRECIO_BS_USD_DECIMALES);
    var usdBcvCents = Math.round((montoBsRed2 * 1000000) / bcvScaled);
    var precioUsdBcv = usdBcvCents / 100;
    var precioBs = Math.round((usdBcvCents * bcvScaled) / 10000) / 100;
    return { precioUsdBcv: precioUsdBcv, precioBs: precioBs };
  }

  function totalBolivaresDesdeRefUsdBcv(usdBcvTotal, tasaBcv) {
    var bcv = redondearTasa4(tasaBcv);
    if (!(bcv > 0) || Number.isNaN(bcv)) throw new Error('Tasa BCV inválida');
    var u = Number(usdBcvTotal);
    if (!Number.isFinite(u) || u < 0) throw new Error('Total ref. USD BCV inválido');
    var bcvScaled = Math.round(bcv * 10000);
    return Math.round((u * bcvScaled) / 100) / 100;
  }

  /**
   * Pasos 2–4 partiendo del precio de venta en USD efectivo ya fijado (POS manual, vistas).
   * NEXUS-DUAL: contraparte en backend/services/preciosService.js → aplicarCadenaPorPrecioEfectivo.
   *
   * @param {number} precioUsdEfectivo
   * @param {number} tasaBcv
   * @param {number} tasaUsd
   * @param {{ precisionPe?: 2|4 }} [opcs] - precisionPe:4 para precio_manual_usd de 4 decimales;
   *   omitir o pasar 2 para comportamiento clásico (pe redondeado a centavo USD).
   */
  function aplicarCadenaPorPrecioEfectivo(precioUsdEfectivo, tasaBcv, tasaUsd, opcs) {
    if (precioUsdEfectivo === undefined || precioUsdEfectivo === null || Number(precioUsdEfectivo) <= 0) {
      throw new Error('El precio USD efectivo debe ser mayor a 0');
    }
    var bcv = redondearTasa4(tasaBcv);
    var usd = redondearTasa4(tasaUsd);
    assertTasasPositivas(bcv, usd);
    var precDec = (opcs && opcs.precisionPe) ? opcs.precisionPe : PRECIO_USD_EFECTIVO_DECIMALES;
    var pe =
      Math.round(Number(precioUsdEfectivo) * Math.pow(10, precDec)) /
      Math.pow(10, precDec);
    var montoBsBase = pe * usd;
    var bsUsdEquiv =
      Math.round(montoBsBase * Math.pow(10, PRECIO_BS_USD_DECIMALES)) /
      Math.pow(10, PRECIO_BS_USD_DECIMALES);
    var chain = precioBolivaresRefBcvDesdeBsUsd(bsUsdEquiv, bcv);
    var precioUsdBcv = chain.precioUsdBcv;
    var precioBs = chain.precioBs;
    return {
      precio_usd_efectivo: pe,
      precio_usd_bcv: precioUsdBcv,
      precio_bs: precioBs,
      bs_usd_equiv: bsUsdEquiv,
      tasa_bcv: bcv,
      tasa_usd: usd
    };
  }

  /**
   * USD físico a 4 decimales que, procesado con aplicarCadenaPorPrecioEfectivo({ precisionPe:4 }),
   * produce exactamente `objetivo_bcv` en precio_usd_bcv — sin saltos de redondeo.
   * NEXUS-DUAL: contraparte en backend/services/preciosService.js → precioManualUsdDesdeBcvObjetivo.
   *
   * @param {number} objetivo_bcv  precio en ref. $ BCV deseado
   * @param {number} tasa_bcv      Bs por 1 USD BCV
   * @param {number} tasa_usd      Bs por 1 USD físico
   * @returns {number} precio_manual_usd a 4 decimales
   */
  function precioManualUsdDesdeBcvObjetivo(objetivo_bcv, tasa_bcv, tasa_usd) {
    var bcv = redondearTasa4(tasa_bcv);
    var usd = redondearTasa4(tasa_usd);
    assertTasasPositivas(bcv, usd);
    var obj = Number(objetivo_bcv);
    if (!Number.isFinite(obj) || obj <= 0) {
      throw new Error('preciosClient precioManualUsdDesdeBcvObjetivo: objetivo_bcv inválido');
    }
    return Math.round((obj * bcv / usd) * 10000) / 10000;
  }

  /**
   * NEXUS-DUAL: contraparte en backend/services/preciosService.js → tienePrecioManualActivo.
   */
  function tienePrecioManualActivo(precio_manual_usd) {
    if (precio_manual_usd == null || String(precio_manual_usd).trim() === '') return false;
    var n = parseFloat(String(precio_manual_usd).replace(/\s/g, '').replace(',', '.'));
    return !Number.isNaN(n) && n > 0;
  }

  function calcularPrecios(costoUsd, gananciaPct, tasaBcv, tasaUsd) {
    if (costoUsd === undefined || costoUsd === null || Number(costoUsd) <= 0) {
      throw new Error('El costo USD debe ser mayor a 0');
    }
    if (gananciaPct === undefined || gananciaPct === null || Number(gananciaPct) < 0) {
      throw new Error('La ganancia no puede ser negativa');
    }

    var bcv = redondearTasa4(tasaBcv);
    var usd = redondearTasa4(tasaUsd);
    assertTasasPositivas(bcv, usd);

    var costo = Math.round(Number(costoUsd) * Math.pow(10, COSTO_DECIMALES)) / Math.pow(10, COSTO_DECIMALES);
    var ganancia =
      Math.round(Number(gananciaPct) * Math.pow(10, GANANCIA_DECIMALES)) / Math.pow(10, GANANCIA_DECIMALES);

    var precioUsdEfectivo =
      Math.round(costo * (1 + ganancia / 100) * Math.pow(10, PRECIO_USD_EFECTIVO_DECIMALES)) /
      Math.pow(10, PRECIO_USD_EFECTIVO_DECIMALES);

    var montoBsBase = precioUsdEfectivo * usd;

    var bsUsdEquiv =
      Math.round(montoBsBase * Math.pow(10, PRECIO_BS_USD_DECIMALES)) /
      Math.pow(10, PRECIO_BS_USD_DECIMALES);

    var chain2 = precioBolivaresRefBcvDesdeBsUsd(bsUsdEquiv, bcv);
    var precioUsdBcv = chain2.precioUsdBcv;
    var precioBs = chain2.precioBs;

    var factorBcv =
      Math.round((usd / bcv) * Math.pow(10, TASA_DECIMALES)) / Math.pow(10, TASA_DECIMALES);

    var margenUsd =
      Math.round((precioUsdEfectivo - costo) * Math.pow(10, PRECIO_USD_EFECTIVO_DECIMALES)) /
      Math.pow(10, PRECIO_USD_EFECTIVO_DECIMALES);
    var margenPctReal = costo > 0 ? Math.round((margenUsd / costo) * 10000) / 100 : 0;

    return {
      precio_usd_efectivo: precioUsdEfectivo,
      precio_usd_bcv: precioUsdBcv,
      precio_bs: precioBs,
      bs_usd_equiv: bsUsdEquiv,
      meta: { monto_bs_base_usd: montoBsBase },
      tasa_bcv: bcv,
      tasa_usd: usd,
      factor_conversion: factorBcv,
      margen_usd: margenUsd,
      margen_pct_real: margenPctReal,
      display: {
        usd_efectivo: '$' + precioUsdEfectivo.toFixed(2),
        usd_bcv: '$' + precioUsdBcv.toFixed(2) + ' (USD BCV ref.)',
        bs:
          'Bs. ' +
          precioBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      }
    };
  }

  /**
   * Encuentra el % de ganancia (pasos 0,01 %) que reproduce la cadena calcularPrecios
   * y acerca al máximo el precio_usd_bcv (ref. 2 decimales) al objetivo.
   * NEXUS-DUAL: contraparte en backend/services/preciosService.js (misma lógica).
   *
   * @returns {{
   *   ganancia_pct:number,
   *   exacto:boolean,
   *   precio_usd_bcv:number,
   *   precio_usd_efectivo:number,
   *   preview: object
   * }}
   */
  function gananciaPctDesdePrecioUsdBcvObjetivo(costoUsd, precioUsdBcvObjetivo, tasaBcv, tasaUsd) {
    var bcv = redondearTasa4(tasaBcv);
    var usd = redondearTasa4(tasaUsd);
    assertTasasPositivas(bcv, usd);
    var costo =
      Math.round(Number(costoUsd) * Math.pow(10, COSTO_DECIMALES)) / Math.pow(10, COSTO_DECIMALES);
    if (!(costo > 0)) {
      throw new Error(
        'preciosClient gananciaPctDesdePrecioUsdBcvObjetivo: costoUsd debe ser mayor a 0'
      );
    }
    var rawObj = Number(precioUsdBcvObjetivo);
    if (!Number.isFinite(rawObj) || rawObj <= 0) {
      throw new Error(
        'preciosClient gananciaPctDesdePrecioUsdBcvObjetivo: precioUsdBcvObjetivo inválido'
      );
    }
    var objetivo = Math.round(rawObj * 100) / 100;

    function precioBcvDeGananciaCent(gCent) {
      var g = gCent / 100;
      return calcularPrecios(costo, g, bcv, usd).precio_usd_bcv;
    }

    var minBcv = precioBcvDeGananciaCent(0);
    if (minBcv > objetivo) {
      throw new Error(
        'preciosClient gananciaPctDesdePrecioUsdBcvObjetivo: el $BCV ref. objetivo es menor al mínimo con 0% de ganancia (' +
          minBcv.toFixed(2) +
          ')'
      );
    }

    var hi = 1;
    var guard = 0;
    while (precioBcvDeGananciaCent(hi) < objetivo && hi < 50000000 && guard < 40) {
      hi *= 2;
      guard += 1;
    }
    if (precioBcvDeGananciaCent(hi) < objetivo) {
      throw new Error(
        'preciosClient gananciaPctDesdePrecioUsdBcvObjetivo: no hay ganancia suficiente para alcanzar ese $BCV ref.'
      );
    }

    var lo = 0;
    var right = hi;
    while (lo < right) {
      var mid = Math.floor((lo + right) / 2);
      if (precioBcvDeGananciaCent(mid) < objetivo) lo = mid + 1;
      else right = mid;
    }
    var iCeil = lo;
    var iFloor = Math.max(0, iCeil - 1);
    var bcvCeil = precioBcvDeGananciaCent(iCeil);
    var bcvFloor = precioBcvDeGananciaCent(iFloor);
    var diffCeil = Math.abs(bcvCeil - objetivo);
    var diffFloor = Math.abs(bcvFloor - objetivo);
    var pickCent = diffFloor <= diffCeil ? iFloor : iCeil;
    var gananciaPct = pickCent / 100;
    var preview = calcularPrecios(costo, gananciaPct, bcv, usd);
    var exacto = Math.round(preview.precio_usd_bcv * 100) === Math.round(objetivo * 100);

    return {
      ganancia_pct: gananciaPct,
      exacto: exacto,
      precio_usd_bcv: preview.precio_usd_bcv,
      precio_usd_efectivo: preview.precio_usd_efectivo,
      preview: preview
    };
  }

  /**
   * Calcula el % de ganancia necesario para que precio_usd_efectivo sea exactamente
   * `precioUsdFisicoObjetivo`.
   * Fórmula inversa: margen% = ((precioUsd / costo) - 1) * 100
   * NEXUS-DUAL: contraparte en backend/services/preciosService.js → gananciaPctDesdePrecioUsdFisicoObjetivo.
   *
   * @param {number} costo - Costo en USD
   * @param {number} precioUsdFisicoObjetivo - Precio de venta deseado en USD físico
   * @returns {number|null} porcentaje de ganancia, o null si los parámetros son inválidos
   */
  function gananciaPctDesdePrecioUsdFisicoObjetivo(costo, precioUsdFisicoObjetivo) {
    if (!costo || costo <= 0 || !precioUsdFisicoObjetivo || precioUsdFisicoObjetivo <= 0) return null;
    return ((precioUsdFisicoObjetivo / costo) - 1) * 100;
  }

  /**
   * % de ganancia (pasos 0,01 %) que reproduce exactamente precio_usd_efectivo objetivo.
   * NEXUS-DUAL: contraparte en backend/services/preciosService.js → gananciaPctDesdePrecioUsdFisicoObjetivoExacto.
   */
  function gananciaPctDesdePrecioUsdFisicoObjetivoExacto(
    costoUsd,
    precioUsdFisicoObjetivo,
    tasaBcv,
    tasaUsd
  ) {
    var bcv = redondearTasa4(tasaBcv);
    var usd = redondearTasa4(tasaUsd);
    assertTasasPositivas(bcv, usd);
    var costo =
      Math.round(Number(costoUsd) * Math.pow(10, COSTO_DECIMALES)) / Math.pow(10, COSTO_DECIMALES);
    if (!(costo > 0)) {
      throw new Error(
        'preciosClient gananciaPctDesdePrecioUsdFisicoObjetivoExacto: costoUsd debe ser mayor a 0'
      );
    }
    var rawObj = Number(precioUsdFisicoObjetivo);
    if (!Number.isFinite(rawObj) || rawObj <= 0) {
      throw new Error(
        'preciosClient gananciaPctDesdePrecioUsdFisicoObjetivoExacto: precioUsdFisicoObjetivo inválido'
      );
    }
    var objetivo =
      Math.round(rawObj * Math.pow(10, PRECIO_USD_EFECTIVO_DECIMALES)) /
      Math.pow(10, PRECIO_USD_EFECTIVO_DECIMALES);

    function precioUsdDeGananciaCent(gCent) {
      var g = gCent / 100;
      return calcularPrecios(costo, g, bcv, usd).precio_usd_efectivo;
    }

    var minUsd = precioUsdDeGananciaCent(0);
    if (minUsd > objetivo) {
      throw new Error(
        'preciosClient gananciaPctDesdePrecioUsdFisicoObjetivoExacto: el USD objetivo es menor al mínimo con 0% de ganancia (' +
          minUsd.toFixed(2) +
          ')'
      );
    }

    var hi = 1;
    var guard = 0;
    while (precioUsdDeGananciaCent(hi) < objetivo && hi < 50000000 && guard < 40) {
      hi *= 2;
      guard += 1;
    }
    if (precioUsdDeGananciaCent(hi) < objetivo) {
      throw new Error(
        'preciosClient gananciaPctDesdePrecioUsdFisicoObjetivoExacto: no hay ganancia suficiente para alcanzar ese USD objetivo'
      );
    }

    var lo = 0;
    var right = hi;
    while (lo < right) {
      var mid = Math.floor((lo + right) / 2);
      if (precioUsdDeGananciaCent(mid) < objetivo) lo = mid + 1;
      else right = mid;
    }
    var iCeil = lo;
    var iFloor = Math.max(0, iCeil - 1);
    var usdCeil = precioUsdDeGananciaCent(iCeil);
    var usdFloor = precioUsdDeGananciaCent(iFloor);
    var diffCeil = Math.abs(usdCeil - objetivo);
    var diffFloor = Math.abs(usdFloor - objetivo);
    var pickCent = diffFloor <= diffCeil ? iFloor : iCeil;
    var gananciaPct = pickCent / 100;
    var preview = calcularPrecios(costo, gananciaPct, bcv, usd);
    var exacto =
      Math.round(preview.precio_usd_efectivo * 100) === Math.round(objetivo * 100);

    return {
      ganancia_pct: gananciaPct,
      exacto: exacto,
      precio_usd_efectivo: preview.precio_usd_efectivo,
      precio_usd_bcv: preview.precio_usd_bcv,
      preview: preview
    };
  }

  /**
   * Convierte un costo expresado en $BCV a su equivalente en USD físico.
   * costo_usd = costoBcv × (tasaBcv / tasaUsd)
   * NEXUS-DUAL: contraparte en backend/services/preciosService.js → costoUsdDesdeCostoBcv.
   *
   * @param {number} costoBcv - Costo expresado en dólares BCV
   * @param {number} tasaBcv  - Tasa BCV en Bs/USD
   * @param {number} tasaUsd  - Tasa USD en Bs/USD
   * @returns {number|null} costo equivalente en USD físico, o null si los parámetros son inválidos
   */
  function costoUsdDesdeCostoBcv(costoBcv, tasaBcv, tasaUsd) {
    var bcv = redondearTasa4(tasaBcv);
    var usd = redondearTasa4(tasaUsd);
    if (!bcv || bcv <= 0 || Number.isNaN(bcv)) return null;
    if (!usd || usd <= 0 || Number.isNaN(usd)) return null;
    var cb = Number(costoBcv);
    if (!cb || cb <= 0 || !Number.isFinite(cb)) return null;
    return Math.round((cb * bcv) / usd * 10000) / 10000;
  }

  /** Modo monetario operativo cacheado por el navbar en localStorage. */
  function getModoMonedaLocal() {
    try {
      var m = (typeof localStorage !== 'undefined') ? localStorage.getItem('nexus_modo_moneda') : null;
      return m === 'solo_bcv' ? 'solo_bcv' : 'multimoneda';
    } catch (e) {
      return 'multimoneda';
    }
  }

  /**
   * NEXUS-DUAL: contraparte de resolverTasasOperativas en backend/services/preciosService.js.
   * En modo solo_bcv (localStorage `nexus_modo_moneda`) iguala tasa_usd = tasa_bcv ANTES de
   * cualquier cálculo. La cadena de precios no cambia: solo se unifican las tasas de entrada.
   * Acepta { bcv, usd } y/o { tasa_bcv, tasa_usd }; retorna copia con ambas convenciones.
   *
   * Test de equivalencia (solo_bcv): con tasa_bcv = tasa_usd = 89.50, costo_usd = 1.2 y
   * margen = 30 %, calcularPrecios() produce el MISMO precio_usd_bcv y precio_bs que el
   * backend (preciosService.calcularPrecios) con esos mismos inputs unificados.
   *
   * @param {{bcv?:number, usd?:number, tasa_bcv?:number, tasa_usd?:number}} tasas
   * @returns {{bcv:number, usd:number, tasa_bcv:number, tasa_usd:number}}
   */
  function resolverTasasOperativas(tasas) {
    var t = tasas || {};
    var bcv = redondearTasa4(t.bcv != null ? t.bcv : t.tasa_bcv);
    var usd = redondearTasa4(t.usd != null ? t.usd : t.tasa_usd);
    if (getModoMonedaLocal() === 'solo_bcv' && bcv > 0) {
      usd = bcv;
    }
    return { bcv: bcv, usd: usd, tasa_bcv: bcv, tasa_usd: usd };
  }

  window.PreciosServiceClient = {
    redondearTasa4: redondearTasa4,
    calcularPrecios: calcularPrecios,
    aplicarCadenaPorPrecioEfectivo: aplicarCadenaPorPrecioEfectivo,
    totalBolivaresDesdeRefUsdBcv: totalBolivaresDesdeRefUsdBcv,
    gananciaPctDesdePrecioUsdBcvObjetivo: gananciaPctDesdePrecioUsdBcvObjetivo,
    gananciaPctDesdePrecioUsdFisicoObjetivo: gananciaPctDesdePrecioUsdFisicoObjetivo,
    gananciaPctDesdePrecioUsdFisicoObjetivoExacto: gananciaPctDesdePrecioUsdFisicoObjetivoExacto,
    costoUsdDesdeCostoBcv: costoUsdDesdeCostoBcv,
    precioManualUsdDesdeBcvObjetivo: precioManualUsdDesdeBcvObjetivo,
    tienePrecioManualActivo: tienePrecioManualActivo,
    getModoMonedaLocal: getModoMonedaLocal,
    resolverTasasOperativas: resolverTasasOperativas
  };
})();
