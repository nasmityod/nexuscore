'use strict';

/**
 * Prueba unitaria de la máquina de estados del ticket marquee del POS.
 * Replica la lógica de frontend/pages/pos/pos.js sin DOM.
 */

const assert = require('assert');

function createMarqueeTicketController(options) {
  const MARQUEE_TICKET_DRAFT = 'BORRADOR';
  const MARQUEE_TICKET_COMPLETED_MS =
    options && options.completedMs != null ? options.completedMs : 5000;

  let mode = 'draft';
  let revertTimer = null;
  const dom = {
    text: MARQUEE_TICKET_DRAFT,
    completedClass: false,
    title: ''
  };

  function clearRevertTimer() {
    if (revertTimer) {
      clearTimeout(revertTimer);
      revertTimer = null;
    }
  }

  function setDraft() {
    clearRevertTimer();
    mode = 'draft';
    dom.text = MARQUEE_TICKET_DRAFT;
    dom.completedClass = false;
    dom.title = 'Venta en curso — aún sin número de factura';
  }

  function showCompleted(numeroVenta) {
    clearRevertTimer();
    mode = 'completed';
    const label =
      numeroVenta != null && String(numeroVenta).trim()
        ? String(numeroVenta).trim()
        : '—';
    dom.text = label;
    dom.completedClass = true;
    dom.title = 'Venta registrada: ' + label;
    revertTimer = setTimeout(function () {
      revertTimer = null;
      if (mode === 'completed') {
        setDraft();
      }
    }, MARQUEE_TICKET_COMPLETED_MS);
  }

  function onAddProductToCart() {
    if (mode === 'completed') {
      setDraft();
    }
  }

  function destroy() {
    clearRevertTimer();
  }

  return {
    dom,
    getMode: function () {
      return mode;
    },
    setDraft,
    showCompleted,
    onAddProductToCart,
    destroy
  };
}

/** Simula el orden post-cobro de pos.js: vaciar carrito → luego mostrar número. */
function simulatePostCobroSuccess(created) {
  const cart = [{ producto_id: 1 }];
  const ventaId = created && created.id != null ? created.id : null;
  if (ventaId == null) {
    return { cart, marquee: 'BORRADOR', error: 'sin_id' };
  }
  const numeroVentaMarquee =
    created && created.numero_venta
      ? String(created.numero_venta)
      : '#' + String(ventaId);
  cart.length = 0;
  const c = createMarqueeTicketController({ completedMs: 5000 });
  c.showCompleted(numeroVentaMarquee);
  return {
    cart,
    marquee: c.dom.text,
    mode: c.getMode(),
    numeroVentaMarquee,
    controller: c
  };
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

async function runTests() {
  const results = [];

  async function test(name, fn) {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log('  OK  ' + name);
    } catch (err) {
      results.push({ name, ok: false, err: err && err.message ? err.message : String(err) });
      console.error('  FAIL ' + name);
      console.error('       ' + (err && err.message ? err.message : err));
    }
  }

  console.log('test-pos-marquee-ticket');

  await test('inicia en BORRADOR', function () {
    const c = createMarqueeTicketController({ completedMs: 50 });
    assert.strictEqual(c.getMode(), 'draft');
    assert.strictEqual(c.dom.text, 'BORRADOR');
    assert.strictEqual(c.dom.completedClass, false);
    c.destroy();
  });

  await test('muestra numero_venta al completar', function () {
    const c = createMarqueeTicketController({ completedMs: 50 });
    c.showCompleted('VEN-2026-000042');
    assert.strictEqual(c.getMode(), 'completed');
    assert.strictEqual(c.dom.text, 'VEN-2026-000042');
    assert.strictEqual(c.dom.completedClass, true);
    assert.strictEqual(c.dom.title, 'Venta registrada: VEN-2026-000042');
    c.destroy();
  });

  await test('vuelve a BORRADOR tras timeout', async function () {
    const c = createMarqueeTicketController({ completedMs: 25 });
    c.showCompleted('VEN-2026-000001');
    await delay(45);
    assert.strictEqual(c.getMode(), 'draft');
    assert.strictEqual(c.dom.text, 'BORRADOR');
    assert.strictEqual(c.dom.completedClass, false);
    c.destroy();
  });

  await test('agregar producto durante completed revierte a BORRADOR', function () {
    const c = createMarqueeTicketController({ completedMs: 5000 });
    c.showCompleted('VEN-2026-000099');
    c.onAddProductToCart();
    assert.strictEqual(c.getMode(), 'draft');
    assert.strictEqual(c.dom.text, 'BORRADOR');
    c.destroy();
  });

  await test('segundo completed cancela timer anterior', async function () {
    const c = createMarqueeTicketController({ completedMs: 30 });
    c.showCompleted('VEN-2026-000001');
    c.showCompleted('VEN-2026-000002');
    assert.strictEqual(c.dom.text, 'VEN-2026-000002');
    await delay(55);
    assert.strictEqual(c.getMode(), 'draft');
    c.destroy();
  });

  await test('numero vacio usa guion', function () {
    const c = createMarqueeTicketController({ completedMs: 50 });
    c.showCompleted('   ');
    assert.strictEqual(c.dom.text, '—');
    c.destroy();
  });

  await test('destroy limpia timer pendiente', async function () {
    const c = createMarqueeTicketController({ completedMs: 80 });
    c.showCompleted('VEN-2026-000010');
    c.destroy();
    await delay(100);
    assert.strictEqual(c.getMode(), 'completed');
    assert.strictEqual(c.dom.text, 'VEN-2026-000010');
  });

  await test('fallback #id cuando falta numero_venta', function () {
    const ventaId = 123;
    const created = { id: ventaId };
    const label =
      created && created.numero_venta
        ? String(created.numero_venta)
        : '#' + String(ventaId);
    assert.strictEqual(label, '#123');
  });

  await test('post-cobro vacia carrito antes de mostrar numero', function () {
    const r = simulatePostCobroSuccess({ id: 55, numero_venta: 'VEN-2026-000055' });
    assert.strictEqual(r.cart.length, 0);
    assert.strictEqual(r.marquee, 'VEN-2026-000055');
    assert.strictEqual(r.mode, 'completed');
    r.controller.destroy();
  });

  await test('post-cobro con idempotent_replay incluye numero_venta', function () {
    const r = simulatePostCobroSuccess({
      id: 88,
      numero_venta: 'VEN-2026-000088',
      idempotent_replay: true
    });
    assert.strictEqual(r.numeroVentaMarquee, 'VEN-2026-000088');
    assert.strictEqual(r.marquee, 'VEN-2026-000088');
    r.controller.destroy();
  });

  await test('error sin id no muestra numero ni vacia carrito en simulacion', function () {
    const r = simulatePostCobroSuccess({ numero_venta: 'VEN-2026-000001' });
    assert.strictEqual(r.error, 'sin_id');
    assert.strictEqual(r.cart.length, 1);
    assert.strictEqual(r.marquee, 'BORRADOR');
  });

  const failed = results.filter(function (r) {
    return !r.ok;
  });
  if (failed.length) {
    console.log('\n' + failed.length + ' prueba(s) fallaron.');
    process.exit(1);
  }
  console.log('\n' + results.length + ' pruebas OK.');
}

runTests().catch(function (err) {
  console.error(err);
  process.exit(1);
});
