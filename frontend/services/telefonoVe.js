'use strict';

(function () {
  var PREFIXOS_MOVIL_VE = [
    '0412', '0414', '0416', '0424', '0426', '0212', '0234', '0235', '0237', '0238', '0239',
    '0240', '0241', '0242', '0243', '0244', '0245', '0246', '0247', '0248', '0249',
    '0251', '0252', '0253', '0254', '0255', '0256', '0257', '0258', '0259',
    '0261', '0262', '0263', '0264', '0265', '0266', '0267', '0268', '0269',
    '0271', '0272', '0273', '0274', '0275', '0276', '0277', '0278',
    '0281', '0282', '0283', '0285', '0286', '0287', '0288', '0289',
    '0291', '0292', '0293', '0294', '0295',
  ];
  var SET_PREFIXOS = {};
  PREFIXOS_MOVIL_VE.forEach(function (p) {
    SET_PREFIXOS[p] = true;
  });

  var LONGITUD_TOTAL = 11;

  function soloDigitos(str) {
    return String(str || '').replace(/\D/g, '');
  }

  /**
   * @returns {{ ok: boolean, normalizado: string|null, mensaje?: string }}
   */
  function validarOpcional(valor) {
    if (valor === undefined || valor === null || String(valor).trim() === '') {
      return { ok: true, normalizado: null };
    }
    var d = soloDigitos(valor);
    if (d.length !== LONGITUD_TOTAL) {
      return {
        ok: false,
        normalizado: null,
        mensaje:
          'El celular debe tener exactamente 11 dígitos (código de operadora 4 + número 7).',
      };
    }
    var pref = d.slice(0, 4);
    if (!SET_PREFIXOS[pref]) {
      return {
        ok: false,
        normalizado: null,
        mensaje:
          'Prefijo de celular no válido en Venezuela. Use un código de operadora autorizado.',
      };
    }
    return { ok: true, normalizado: d };
  }

  /** Solo dígitos, máximo 11 (para inputs). */
  function filtrarInput(el) {
    if (!el || el.tagName !== 'INPUT') return;
    var d = soloDigitos(el.value).slice(0, LONGITUD_TOTAL);
    el.value = d;
  }

  /** Asocia filtrado en tiempo real y maxlength. */
  function enlazarInput(el) {
    if (!el || el.tagName !== 'INPUT') return;
    el.setAttribute('inputmode', 'numeric');
    el.setAttribute('maxlength', String(LONGITUD_TOTAL));
    el.setAttribute('autocomplete', 'tel-national');
    var fn = function () {
      filtrarInput(el);
    };
    el.addEventListener('input', fn);
    el.addEventListener('blur', fn);
    fn();
  }

  window.NexusTelefonoVe = {
    LONGITUD_TOTAL: LONGITUD_TOTAL,
    PREFIXOS_MOVIL_VE: PREFIXOS_MOVIL_VE.slice(),
    soloDigitos: soloDigitos,
    validarOpcional: validarOpcional,
    filtrarInput: filtrarInput,
    enlazarInput: enlazarInput,
  };
})();
