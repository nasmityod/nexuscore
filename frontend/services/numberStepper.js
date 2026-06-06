'use strict';

/**
 * Envuelve inputs type="number" con botones +/− acordes al tema (sin spinners nativos).
 * Idempotente: no vuelve a envolver si ya están en .nexus-num-wrap.
 */
window.NexusNumberStepper = (function () {
  /** Misma lógica que parseMontoUsuario en POS (es-VE: 62.838,38). */
  function parseMontoVe(raw) {
    var t = String(raw == null ? '' : raw).trim().replace(/\s/g, '');
    if (!t) return NaN;
    if (t.indexOf(',') >= 0) {
      t = t.replace(/\./g, '').replace(',', '.');
    } else {
      t = t.replace(',', '.');
      if (/^\d{1,3}(\.\d{3})+$/.test(t)) {
        t = t.replace(/\./g, '');
      }
    }
    return parseFloat(t);
  }

  function formatMontoVe(n) {
    return Number(n || 0).toLocaleString('es-VE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  /**
   * Pegado/blur en campos de monto es-VE (21.069,51). Evita type=number que corrompe el valor.
   */
  function normalizarInputMontoVe(input, opts) {
    if (!input) return;
    opts = opts || {};
    var onInput = typeof opts.onInput === 'function' ? opts.onInput : null;

    function aplicar(raw) {
      var pv = parseMontoVe(raw);
      if (!Number.isFinite(pv) || pv < 0) return false;
      if (opts.allowEmpty !== false && pv === 0) {
        input.value = '';
      } else {
        input.value = formatMontoVe(pv);
      }
      if (onInput) onInput();
      return true;
    }

    input.addEventListener('paste', function (e) {
      var txt = e.clipboardData && e.clipboardData.getData('text/plain');
      if (!txt || !/\S/.test(txt)) return;
      if (!Number.isFinite(parseMontoVe(String(txt).trim()))) return;
      e.preventDefault();
      aplicar(String(txt).trim());
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    input.addEventListener('blur', function () {
      var raw = String(input.value || '').trim();
      if (raw === '') return;
      if (/[.,]$/.test(raw)) return;
      var antes = input.value;
      if (aplicar(raw) && String(input.value) !== String(antes)) {
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  }

  function formatBsVe(n) {
    return Number(n || 0).toLocaleString('es-VE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function formatUsdVe(n) {
    return Number(n || 0).toLocaleString('es-VE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function dispatchBoth(input) {
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Cantidad de decimales del atributo step (p. ej. 0.01 → 2). null si step=any o inválido. */
  function decimalsFromStep(stepStr) {
    if (stepStr == null || stepStr === '' || stepStr === 'any') return null;
    var st = parseFloat(String(stepStr));
    if (Number.isNaN(st) || st <= 0) return null;
    var p = String(stepStr).indexOf('.');
    if (p < 0) return 0;
    return Math.min(8, String(stepStr).length - p - 1);
  }

  function isMontoTextVe(input) {
    return (
      input.classList.contains('cobro-su-pago-input') ||
      input.classList.contains('caja-monto-input')
    );
  }

  function formatOutput(input, next) {
    if (isMontoTextVe(input)) {
      if (!(next > 0)) return '';
      if (input.classList.contains('caja-monto-input')) return formatBsVe(next);
      var mon = input.getAttribute('data-cobro-moneda') || 'BS';
      return mon === 'BS' ? formatBsVe(next) : formatUsdVe(next);
    }
    /** Campo muestra vacío cuando el valor es 0 — el placeholder indica formato (ej. 0,00). */
    if (input.getAttribute('data-num-empty-if-zero') === 'true') {
      if (!(Number.isFinite(next) && next > 0)) return '';
    }
    var dec = decimalsFromStep(input.getAttribute('step'));
    if (dec !== null) {
      return next.toFixed(dec);
    }
    var r = Math.round(next * 1e6) / 1e6;
    if (Math.abs(r - Math.round(r)) < 1e-9) return String(Math.round(r));
    return String(r);
  }

  /**
   * +/- cambian de a 1 unidad entera (10,50 → 11,50), no de a step (p. ej. 0,01).
   */
  function bumpInteger(input, dir) {
    if (!input || input.disabled || input.readOnly) return;
    var raw = String(input.value || '').trim();
    var v = isMontoTextVe(input)
      ? parseMontoVe(raw)
      : parseFloat(raw.replace(',', '.'));
    if (Number.isNaN(v)) v = 0;

    var next = v + (dir > 0 ? 1 : -1);

    if (input.hasAttribute('min') && input.min !== '') {
      var mn = parseFloat(input.min);
      if (!Number.isNaN(mn) && next < mn) next = mn;
    }
    if (input.hasAttribute('max') && input.max !== '') {
      var mx = parseFloat(input.max);
      if (!Number.isNaN(mx) && next > mx) next = mx;
    }

    var out = formatOutput(input, next);
    if (String(input.value) === out) return;
    input.value = out;
    dispatchBoth(input);
  }

  function attachHoldRepeat(b, input, dir) {
    var delayId = null;
    var tickId = null;

    function clearTimers() {
      if (delayId != null) {
        clearTimeout(delayId);
        delayId = null;
      }
      if (tickId != null) {
        clearInterval(tickId);
        tickId = null;
      }
    }

    function start() {
      clearTimers();
      bumpInteger(input, dir);
      delayId = setTimeout(function () {
        delayId = null;
        tickId = setInterval(function () {
          bumpInteger(input, dir);
        }, 75);
      }, 450);
    }

    function end() {
      clearTimers();
    }

    b.addEventListener('mousedown', function (e) {
      e.preventDefault();
      start();
    });
    b.addEventListener('mouseup', end);
    b.addEventListener('mouseleave', end);

    b.addEventListener(
      'touchstart',
      function (e) {
        e.preventDefault();
        start();
      },
      { passive: false }
    );
    b.addEventListener('touchend', end);
    b.addEventListener('touchcancel', end);
  }

  function wrapInput(input) {
    if (!input) return;
    var isMontoText =
      input.type === 'text' &&
      (input.classList.contains('cobro-su-pago-input') || input.classList.contains('caja-monto-input'));
    if (input.type !== 'number' && !isMontoText) return;
    if (input.getAttribute('data-no-nexus-stepper') === 'true') return;
    if (input.closest('.nexus-num-wrap')) return;
    if (input.disabled || input.readOnly) return;

    var wrap = document.createElement('div');
    wrap.className = 'nexus-num-wrap';

    var isCompact =
      input.classList.contains('pos-qty-input') ||
      input.classList.contains('pos-line-disc-input') ||
      input.classList.contains('cobro-su-pago-input');
    if (isCompact) wrap.classList.add('nexus-num-wrap--compact');

    var parent = input.parentNode;
    if (!parent) return;

    var sw = String(input.style.width || '').trim();
    var inlinePx = null;
    if (sw && sw !== '100%' && /px/i.test(sw)) {
      var ip = parseFloat(sw);
      if (!Number.isNaN(ip) && ip > 0 && ip < 220) inlinePx = ip;
    }

    var measuredCompact = 0;
    if (isCompact && !inlinePx) {
      measuredCompact = parseFloat(window.getComputedStyle(input).width) || 0;
    }

    parent.insertBefore(wrap, input);
    wrap.appendChild(input);

    if (inlinePx) {
      wrap.style.width = Math.ceil(inlinePx + 44) + 'px';
      wrap.style.maxWidth = '100%';
    } else if (isCompact && measuredCompact > 0) {
      wrap.style.width = Math.ceil(measuredCompact + 40) + 'px';
      wrap.style.maxWidth = '100%';
    } else {
      wrap.style.width = '100%';
    }

    input.style.width = '';
    input.style.flex = '1';
    input.style.minWidth = '0';

    var btns = document.createElement('div');
    btns.className = 'nexus-num-btns';

    function makeBtn(label, aria, dir) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'nexus-num-btn' + (dir > 0 ? ' nexus-num-btn--up' : ' nexus-num-btn--down');
      b.setAttribute('aria-label', aria);
      b.title = aria;
      b.textContent = label;
      attachHoldRepeat(b, input, dir);
      return b;
    }

    btns.appendChild(makeBtn('+', 'Aumentar', 1));
    btns.appendChild(makeBtn('\u2212', 'Disminuir', -1));
    wrap.appendChild(btns);
  }

  function init(root) {
    var el = root && root.nodeType === 1 ? root : document;
    el.querySelectorAll('input[type="number"]').forEach(function (inp) {
      wrapInput(inp);
    });
    el.querySelectorAll('input[type="text"].cobro-su-pago-input, input[type="text"].caja-monto-input').forEach(function (inp) {
      wrapInput(inp);
    });
  }

  return { init: init, parseMontoVe: parseMontoVe, formatMontoVe: formatMontoVe, normalizarInputMontoVe: normalizarInputMontoVe };
})();
