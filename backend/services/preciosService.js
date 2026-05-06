'use strict';

/**
 * Motor de cálculo de precios — Nexus-Core (Venezuela).
 * Cadena fija de redondeos (alineación facturación / UI / Intl 1 decimal en ref. $BCV):
 *   1) precio_efectivo = round(costo * (1 + ganancia%), 2)
 *   2) monto_bs_base = precio_efectivo * tasa_usd — sin redondeo (solo float)
 *   3) precio_usd_bcv (1 decimal) desde el paralelo redondeado a 2 dec, con tasa BCV a 4 dec en aritmética entera
 *   4) precio_bs (2 dec) = redondear(precio_usd_bcv_ref × tasa_bcv), coherente con la ref. $BCV mostrada
 * tasas configuradas como Bs por 1 USD, guardadas en config con 4 decimales.
 */

const { registrarAuditoria } = require('../middleware/audit.middleware');
const { httpError } = require('../utils/asyncHandler');

const TASA_DECIMALES = 4;
const COSTO_DECIMALES = 4;
const GANANCIA_DECIMALES = 2;
const PRECIO_USD_EFECTIVO_DECIMALES = 2;
const PRECIO_BS_PARALELO_DECIMALES = 2;

class PreciosService {
  /**
   * @param {number|string} valor
   * @returns {number}
   */
  static redondearTasa4(valor) {
    const raw =
      typeof valor === 'string' ? valor.trim().replace(/\s/g, '').replace(',', '.') : valor;
    const n = Number(raw);
    if (Number.isNaN(n)) return NaN;
    return Math.round(n * 10000) / 10000;
  }

  /**
   * @param {number} tasaRedondeada4
   * @returns {string}
   */
  static tasaATexto4(tasaRedondeada4) {
    return PreciosService.redondearTasa4(tasaRedondeada4).toFixed(TASA_DECIMALES);
  }

  /**
   * @param {number} tasaBcv Bs por 1 USD BCV
   * @param {number} tasaUsd Bs por 1 USD (mercado)
   */
  static assertTasasPositivas(tasaBcv, tasaUsd) {
    if (!tasaBcv || tasaBcv <= 0 || Number.isNaN(tasaBcv)) {
      throw new Error('La tasa USD BCV (Bs por dólar) debe ser mayor a 0');
    }
    if (!tasaUsd || tasaUsd <= 0 || Number.isNaN(tasaUsd)) {
      throw new Error('La tasa USD (Bs por dólar) debe ser mayor a 0');
    }
  }

  /**
   * Paralelo Bs ya redondeado a 2 dec → precio_usd_bcv (1 dec) y precio_bs (2 dec) sin pérdidas por IEEE 754:
   * tasa_bcv se escala como entero (×10000).
   *
   * @param {number} precioBsParaleloEquiv2d - round(pe * tasa_usd, 2)
   * @param {number} tasaBcv4d - tasa redondeada a 4 dec
   */
  static precioBolivaresRefBcvDesdeParalelo(precioBsParaleloEquiv2d, tasaBcv4d) {
    const bcvScaled = Math.round(tasaBcv4d * 10000);
    const montoBsRed2 =
      Math.round(Number(precioBsParaleloEquiv2d) * 10 ** PRECIO_BS_PARALELO_DECIMALES) /
      10 ** PRECIO_BS_PARALELO_DECIMALES;
    const usdBcvTenths = Math.round((montoBsRed2 * 100000) / bcvScaled);
    const precioUsdBcv = usdBcvTenths / 10;
    const precioBs = Math.round((usdBcvTenths * bcvScaled) / 1000) / 100;
    return { precioUsdBcv, precioBs };
  }

  /**
   * Bolívares (2 dec) desde el total ref. USD BCV (p. ej. suma de subtotales USD BCV con desc. global)
   * × tasa BCV a 4 dec, sin sumar líneas en Bs (evita desvíos de céntimos).
   */
  static totalBolivaresDesdeRefUsdBcv(usdBcvTotal, tasaBcv) {
    const bcv = PreciosService.redondearTasa4(tasaBcv);
    if (!(bcv > 0) || Number.isNaN(bcv)) throw new Error('Tasa BCV inválida');
    const u = Number(usdBcvTotal);
    if (!Number.isFinite(u) || u < 0) throw new Error('Total ref. USD BCV inválido');
    const bcvScaled = Math.round(bcv * 10000);
    return Math.round((u * bcvScaled) / 100) / 100;
  }

  /**
   * Cadena 2–4 partiendo de un precio de venta USD efectivo ya fijado (p. ej. precio_manual_usd en catálogo).
   * Alineado con frontend/services/preciosClient.js → aplicarCadenaPorPrecioEfectivo.
   */
  static aplicarCadenaPorPrecioEfectivo(precioUsdEfectivo, tasaBcv, tasaUsd) {
    if (
      precioUsdEfectivo === undefined ||
      precioUsdEfectivo === null ||
      Number(precioUsdEfectivo) <= 0
    ) {
      throw new Error('El precio USD efectivo debe ser mayor a 0');
    }
    const bcv = PreciosService.redondearTasa4(tasaBcv);
    const usd = PreciosService.redondearTasa4(tasaUsd);
    PreciosService.assertTasasPositivas(bcv, usd);
    const pe =
      Math.round(Number(precioUsdEfectivo) * 10 ** PRECIO_USD_EFECTIVO_DECIMALES) /
      10 ** PRECIO_USD_EFECTIVO_DECIMALES;
    const montoBsBase = pe * usd;
    const precioBsParaleloEquiv =
      Math.round(montoBsBase * 10 ** PRECIO_BS_PARALELO_DECIMALES) /
      10 ** PRECIO_BS_PARALELO_DECIMALES;
    const { precioUsdBcv, precioBs } = PreciosService.precioBolivaresRefBcvDesdeParalelo(
      precioBsParaleloEquiv,
      bcv
    );
    return {
      precio_usd_efectivo: pe,
      precio_usd_bcv: precioUsdBcv,
      precio_bs: precioBs,
      precio_bs_paralelo_equiv: precioBsParaleloEquiv,
      tasa_bcv: bcv,
      tasa_usd: usd
    };
  }

  /**
   * Total Bs según tasa Calle (Bs/USD), con producto intermedio a 4 decimales y total en 2.
   */
  static totalBsDesdeUsdTasaCalle(totalUsd, tasaUsdCalle) {
    const u = PreciosService.redondearTasa4(totalUsd);
    const t = PreciosService.redondearTasa4(tasaUsdCalle);
    if (!(u >= 0) || Number.isNaN(u)) throw new Error('total_usd inválido');
    if (!(t > 0) || Number.isNaN(t)) throw new Error('tasa USD Calle inválida');
    const intermedio4 = Math.round(u * t * 10000) / 10000;
    return Math.round(intermedio4 * 100) / 100;
  }

  /**
   * Suma pagos del POS en equivalente USD efectivo a tasa Calle.
   *   moneda 'USD'     → monto directo (USD efectivo a tasa paralela)
   *   moneda 'USD_BCV' → monto_bcv × (tasa_bcv / tasa_usd_calle)  [crédito en $ BCV]
   *   moneda 'BS'      → monto_bs  / tasa_usd_calle
   *   Cashea           → montoInicial + montoPrestado (ya en USD efectivo)
   *
   * @param {Array} pagos
   * @param {number} tasaUsdCalle  Bs por 1 USD (mercado paralelo)
   * @param {number} [tasaBcv]     Bs por 1 USD BCV — requerido si hay pagos USD_BCV
   */
  static sumaPagosEquivUsdCalle(pagos, tasaUsdCalle, tasaBcv) {
    const t = PreciosService.redondearTasa4(tasaUsdCalle);
    if (!(t > 0) || Number.isNaN(t)) throw new Error('Tasa USD Calle inválida');
    const arr = Array.isArray(pagos) ? pagos : [];
    let suma = 0;
    for (let i = 0; i < arr.length; i += 1) {
      const p = arr[i];
      if (!p || !p.metodo) continue;
      const metodo = String(p.metodo).toLowerCase();
      if (metodo === 'cashea') {
        const d = p.cashea_desglose;
        if (d && typeof d === 'object') {
          suma += Number(d.montoInicial || 0) + Number(d.montoPrestado || 0);
        } else {
          suma += Number(p.monto) || 0;
        }
        continue;
      }
      const moneda = p.moneda != null ? String(p.moneda).toUpperCase() : '';
      const monto = Number(p.monto) || 0;
      if (moneda === 'USD') {
        suma += monto;
      } else if (moneda === 'USD_BCV') {
        // Crédito pactado en dólares BCV (cadena BCV).
        // USD_BCV × tasa_bcv = Bs BCV ≈ Bs paralelo = USD_efectivo × tasa_usd
        // → USD_efectivo = monto_bcv × tasa_bcv / tasa_usd_calle
        const bcv = PreciosService.redondearTasa4(tasaBcv);
        if (!(bcv > 0) || Number.isNaN(bcv)) {
          throw new Error('Tasa BCV requerida para convertir pago USD_BCV a USD efectivo');
        }
        suma += (monto * bcv) / t;
      } else {
        // BS: monto en bolívares → USD efectivo via tasa calle
        suma += monto / t;
      }
    }
    return Math.round(suma * 10000) / 10000;
  }

  static calcularPrecios(costo_usd, ganancia_pct, tasa_bcv, tasa_usd) {
    if (costo_usd === undefined || costo_usd === null || Number(costo_usd) <= 0) {
      throw new Error('El costo USD debe ser mayor a 0');
    }
    if (ganancia_pct === undefined || ganancia_pct === null || Number(ganancia_pct) < 0) {
      throw new Error('La ganancia no puede ser negativa');
    }

    const bcv = PreciosService.redondearTasa4(tasa_bcv);
    const usd = PreciosService.redondearTasa4(tasa_usd);
    PreciosService.assertTasasPositivas(bcv, usd);

    const costo = Math.round(Number(costo_usd) * 10 ** COSTO_DECIMALES) / 10 ** COSTO_DECIMALES;
    const ganancia =
      Math.round(Number(ganancia_pct) * 10 ** GANANCIA_DECIMALES) / 10 ** GANANCIA_DECIMALES;

    const precio_usd_efectivo =
      Math.round(costo * (1 + ganancia / 100) * 10 ** PRECIO_USD_EFECTIVO_DECIMALES) /
      10 ** PRECIO_USD_EFECTIVO_DECIMALES;

    /** Paso 2: equivalencia paralela sin redondeo intermedio. */
    const monto_bs_base = precio_usd_efectivo * usd;

    /** Referencia paralela (solo uso informativo; punto de partida de la cadena BCV). */
    const precio_bs_paralelo_equiv =
      Math.round(monto_bs_base * 10 ** PRECIO_BS_PARALELO_DECIMALES) /
      10 ** PRECIO_BS_PARALELO_DECIMALES;

    const { precioUsdBcv: precio_usd_bcv, precioBs: precio_bs } =
      PreciosService.precioBolivaresRefBcvDesdeParalelo(precio_bs_paralelo_equiv, bcv);

    const factor_bcv =
      Math.round((usd / bcv) * 10 ** TASA_DECIMALES) / 10 ** TASA_DECIMALES;

    const margen_usd =
      Math.round((precio_usd_efectivo - costo) * 10 ** PRECIO_USD_EFECTIVO_DECIMALES) /
      10 ** PRECIO_USD_EFECTIVO_DECIMALES;
    const margen_pct_real =
      costo > 0 ? Math.round((margen_usd / costo) * 10000) / 100 : 0;

    return {
      costo_usd: costo,
      ganancia_pct: ganancia,
      tasa_bcv: bcv,
      tasa_usd: usd,
      factor_conversion: factor_bcv,

      precio_usd_efectivo,
      precio_usd_bcv,
      precio_bs,
      precio_bs_paralelo_equiv,

      meta: {
        monto_bs_base_paralela: monto_bs_base
      },

      margen_usd,
      margen_pct_real,

      display: {
        usd_efectivo: `$${precio_usd_efectivo.toFixed(2)}`,
        usd_bcv: `$${precio_usd_bcv.toFixed(1)} (USD BCV ref.)`,
        bs: `Bs. ${precio_bs.toLocaleString('es-VE', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        })}`,
        margen: `${margen_pct_real.toFixed(2)}%`
      }
    };
  }

  /**
   * @returns {Promise<{ bcv: number, tasa_bcv: number, tasa_usd: number }>}
   */
  static async obtenerTasasActuales(db) {
    const rows = await db.any(
      `SELECT clave, valor FROM configuracion
       WHERE clave IN ('tasa_bcv', 'tasa_usd', 'tasa_paralela')`
    );
    const tasas = {};
    rows.forEach((r) => {
      tasas[r.clave] = parseFloat(String(r.valor).replace(',', '.'));
    });

    const tasaUsdVal =
      tasas.tasa_usd !== undefined && !Number.isNaN(tasas.tasa_usd)
        ? tasas.tasa_usd
        : tasas.tasa_paralela;

    if (
      tasas.tasa_bcv === undefined ||
      tasaUsdVal === undefined ||
      Number.isNaN(tasas.tasa_bcv) ||
      Number.isNaN(tasaUsdVal)
    ) {
      throw new Error('Tasas no configuradas. Ve a Configuración → Moneda y Tasas.');
    }

    const bcv = PreciosService.redondearTasa4(tasas.tasa_bcv);
    const usd = PreciosService.redondearTasa4(tasaUsdVal);
    PreciosService.assertTasasPositivas(bcv, usd);

    return {
      bcv,
      tasa_bcv: bcv,
      tasa_usd: usd
    };
  }

  /**
   * Porcentaje IVA de ventas según configuracion.impuesto_iva (2 decimales).
   */
  static async leerImpuestoIvaPorcentaje(dbOrT) {
    const row = await dbOrT.oneOrNone(
      `SELECT valor FROM configuracion WHERE clave = 'impuesto_iva'`
    );
    const raw = row ? parseFloat(String(row.valor).replace(/\s/g, '').replace(',', '.')) : 0;
    if (Number.isNaN(raw) || raw < 0) return 0;
    return Math.round(raw * 100) / 100;
  }

  /**
   * Lee tasas en BD sin exigir que existan todas (para auditoría antes de guardar).
   * @returns {Promise<{ tasa_bcv: number|null, tasa_usd: number|null }>}
   */
  static async leerTasasPreviasConfig(t) {
    const rows = await t.any(
      `SELECT clave, valor FROM configuracion
       WHERE clave IN ('tasa_bcv', 'tasa_usd', 'tasa_paralela')`
    );
    const map = {};
    rows.forEach((r) => {
      map[r.clave] = r.valor;
    });
    const num = (v) => {
      if (v == null || v === '') return null;
      const n = PreciosService.redondearTasa4(v);
      return Number.isNaN(n) || n <= 0 ? null : n;
    };
    const bcv = num(map.tasa_bcv);
    const usd =
      num(map.tasa_usd) != null ? num(map.tasa_usd) : num(map.tasa_paralela);
    return { tasa_bcv: bcv, tasa_usd: usd };
  }

  /**
   * @param {number|string} nueva_tasa_bcv
   * @param {number|string} nueva_tasa_usd
   */
  static async actualizarTasas(db, nueva_tasa_bcv, nueva_tasa_usd, usuario_id, ip_address = null) {
    const bcv_4d = PreciosService.redondearTasa4(nueva_tasa_bcv);
    const usd_4d = PreciosService.redondearTasa4(nueva_tasa_usd);

    if (Number.isNaN(bcv_4d) || Number.isNaN(usd_4d)) {
      throw httpError(400, 'Las tasas deben ser números válidos');
    }

    try {
      PreciosService.assertTasasPositivas(bcv_4d, usd_4d);
    } catch (e) {
      throw httpError(400, e.message);
    }

    if (usd_4d < bcv_4d) {
      throw httpError(400, 'El tipo USD no puede ser menor que el tipo USD BCV');
    }

    const textoBcv = PreciosService.tasaATexto4(bcv_4d);
    const textoUsd = PreciosService.tasaATexto4(usd_4d);

    await db.tx(async (t) => {
      const prev = await PreciosService.leerTasasPreviasConfig(t);
      const datosPrev = { tasa_bcv: prev.tasa_bcv, tasa_usd: prev.tasa_usd };

      await t.none(
        `INSERT INTO configuracion (clave, valor, categoria)
         VALUES ('tasa_bcv', $1, 'moneda')
         ON CONFLICT (clave) DO UPDATE
         SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
        [textoBcv]
      );
      await t.none(
        `INSERT INTO configuracion (clave, valor, categoria)
         VALUES ('tasa_usd', $1, 'moneda')
         ON CONFLICT (clave) DO UPDATE
         SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
        [textoUsd]
      );
      await t.result(
        `UPDATE configuracion SET valor = $1, actualizado_en = NOW() WHERE clave = 'tasa_paralela'`,
        [textoUsd]
      );

      await registrarAuditoria(t, {
        usuario_id,
        accion: 'ACTUALIZAR_TASAS',
        tabla_afectada: 'configuracion',
        registro_id: null,
        datos_anteriores: datosPrev,
        datos_nuevos: { tasa_bcv: bcv_4d, tasa_usd: usd_4d },
        ip_address
      });
    });

    return {
      tasa_bcv: bcv_4d,
      tasa_usd: usd_4d,
      tasa_bcv_texto: textoBcv,
      tasa_usd_texto: textoUsd
    };
  }

  static async calcularPreciosConTasasActuales(db, costo_usd, ganancia_pct) {
    const { bcv, tasa_usd } = await PreciosService.obtenerTasasActuales(db);
    return PreciosService.calcularPrecios(costo_usd, ganancia_pct, bcv, tasa_usd);
  }

  static async previewCambioTasa(db, nueva_tasa_bcv, nueva_tasa_usd) {
    const actuales = await PreciosService.obtenerTasasActuales(db);

    const bcvNueva = PreciosService.redondearTasa4(nueva_tasa_bcv);
    const usdNueva = PreciosService.redondearTasa4(nueva_tasa_usd);

    if (Number.isNaN(bcvNueva) || Number.isNaN(usdNueva)) {
      throw new Error('Las tasas propuestas no son válidas');
    }
    PreciosService.assertTasasPositivas(bcvNueva, usdNueva);
    if (usdNueva < bcvNueva) {
      throw new Error('El tipo USD propuesto no puede ser menor que el tipo USD BCV');
    }

    const productos = await db.any(
      `SELECT id, nombre, costo_usd, margen_ganancia_pct
       FROM productos WHERE activo = TRUE`
    );

    return productos.map((p) => {
      const costo = parseFloat(p.costo_usd);
      const margen = parseFloat(p.margen_ganancia_pct);

      if (!costo || costo <= 0 || Number.isNaN(costo)) {
        return {
          aviso: true,
          producto_id: p.id,
          nombre: p.nombre,
          razon: 'costo_usd_invalido',
          precio_bs_actual: null,
          precio_bs_nuevo: null,
          diferencia_bs: null,
          diferencia_pct: null
        };
      }

      let preciosAntes;
      let preciosNuevos;
      try {
        preciosAntes = PreciosService.calcularPrecios(
          costo,
          Number.isNaN(margen) ? 0 : margen,
          actuales.bcv,
          actuales.tasa_usd
        );
        preciosNuevos = PreciosService.calcularPrecios(
          costo,
          Number.isNaN(margen) ? 0 : margen,
          bcvNueva,
          usdNueva
        );
      } catch (e) {
        return {
          error: true,
          producto_id: p.id,
          nombre: p.nombre,
          mensaje: e.message
        };
      }

      const precio_bs_actual = preciosAntes.precio_bs;
      const precio_bs_nuevo = preciosNuevos.precio_bs;
      const diferencia_bs = Math.round((precio_bs_nuevo - precio_bs_actual) * 100) / 100;
      let diferencia_pct;
      if (precio_bs_actual > 0) {
        diferencia_pct = (((precio_bs_nuevo / precio_bs_actual) - 1) * 100).toFixed(2);
      } else {
        diferencia_pct = null;
      }

      return {
        producto_id: p.id,
        nombre: p.nombre,
        precio_bs_actual,
        precio_bs_nuevo,
        diferencia_bs,
        diferencia_pct,
        precio_usd_efectivo: preciosNuevos.precio_usd_efectivo,
        precio_usd_bcv: preciosNuevos.precio_usd_bcv,
        tasas_previas: { tasa_bcv: actuales.bcv, tasa_usd: actuales.tasa_usd },
        tasas_propuestas: { tasa_bcv: bcvNueva, tasa_usd: usdNueva }
      };
    });
  }
}

module.exports = PreciosService;
