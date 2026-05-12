'use strict';

(function () {
  var state = {
    productos: [], categorias: [],
    filtro: 'todos', busqueda: '', tasas: { bcv: 489.5547, usd: 625.0 },
    paginaActual: 1, porPagina: 50,
    editandoId: null
  };

  function apiBase() {
    return String(window.NEXUS_API_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
  }
  function apiFetch(path, init) {
    var url = path.indexOf('http') === 0 ? path : apiBase() + path;
    if (window.NexusAuth && window.NexusAuth.authFetch) return window.NexusAuth.authFetch(url, init);
    return fetch(url, init);
  }
  function toast(msg, tipo) {
    if (window.NexusComponents && window.NexusComponents.showToast) window.NexusComponents.showToast(msg, tipo || 'info');
  }
  function n(v) { return Number(v) || 0; }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function fUsd(v) { return n(v).toFixed(2); }
  function fBs(v) { return n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function f4(v) { return n(v).toFixed(4); }

  function fUsdBcv(v) { return n(v).toFixed(1); }

  function canDo(perm) {
    if (!window.NexusAuth || typeof window.NexusAuth.getUser !== 'function') return false;
    var u = window.NexusAuth.getUser();
    if (!u) return false;
    var p = u.permisos || {};
    return p.all === true || p[perm] === true;
  }

  /** Alineado con navbar: mismas tasas que ves arriba (inputs) o localStorage. */
  function round4t(nv) {
    if (window.PreciosServiceClient && window.PreciosServiceClient.redondearTasa4) {
      return window.PreciosServiceClient.redondearTasa4(nv);
    }
    var x = Number(nv);
    if (Number.isNaN(x)) return NaN;
    return Math.round(x * 10000) / 10000;
  }

  function tasasEfectivas() {
    var bcvEl = document.getElementById('navbar-tasa-bcv');
    var usdEl = document.getElementById('navbar-tasa-usd');
    if (bcvEl && usdEl) {
      var bcv = parseFloat(String(bcvEl.value).replace(',', '.'));
      var usd = parseFloat(String(usdEl.value).replace(',', '.'));
      if (!Number.isNaN(bcv) && bcv > 0 && !Number.isNaN(usd) && usd > 0) {
        return { bcv: round4t(bcv), usd: round4t(usd) };
      }
    }
    if (window.NexusComponents && window.NexusComponents.loadTasasLocal) {
      return window.NexusComponents.loadTasasLocal();
    }
    return state.tasas;
  }

  function sincronizarStateTasasDesdeOrigen() {
    var t = tasasEfectivas();
    state.tasas = { bcv: t.bcv, usd: t.usd };
  }

  function calcPrecios(costo, margen, tasas) {
    if (!costo || costo <= 0) return null;
    if (!window.PreciosServiceClient || !tasas || !tasas.bcv || !tasas.usd) return null;
    try {
      var pr = window.PreciosServiceClient.calcularPrecios(costo, margen, tasas.bcv, tasas.usd);
      return {
        precio_usd: pr.precio_usd_efectivo,
        precio_usd_bcv: pr.precio_usd_bcv,
        precio_bs: pr.precio_bs,
        precio_bs_paralelo_equiv: pr.precio_bs_paralelo_equiv,
        margen_usd: pr.margen_usd
      };
    } catch (_e) {
      return null;
    }
  }

  // ─── Cargar datos base ────────────────────────────────────────────────────
  function cargarTasas() {
    function applyRatesFromMemory() {
      if (window.NexusComponents && window.NexusComponents.loadTasasLocal) {
        var t = window.NexusComponents.loadTasasLocal();
        state.tasas = { bcv: t.bcv, usd: t.usd };
      }
    }
    applyRatesFromMemory();
    if (!window.NexusComponents || typeof window.NexusComponents.hydrateTasasDesdeServidorSilent !== 'function') {
      sincronizarStateTasasDesdeOrigen();
      return Promise.resolve();
    }
    return window.NexusComponents.hydrateTasasDesdeServidorSilent().then(function () {
      applyRatesFromMemory();
      sincronizarStateTasasDesdeOrigen();
    });
  }

  function cargarCategorias() {
    return apiFetch('/api/inventario/categorias')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (d) { state.categorias = d || []; })
      .catch(function () {});
  }

  function cargarProductos(host) {
    var q = '?activo=true&limit=500';
    if (state.busqueda) q += '&q=' + encodeURIComponent(state.busqueda);
    if (state.filtro === 'stock_bajo') q += '&stock_alerta=bajo';
    if (state.filtro === 'agotados')   q += '&stock_alerta=agotados';
    if (state.filtro === 'inactivos')  q = '?activo=false&limit=500';

    return apiFetch('/api/productos' + q)
      .then(function (r) { return r.ok ? r.json() : { data: [] }; })
      .then(function (d) {
        state.productos = d.data || (Array.isArray(d) ? d : []);
        renderTabla(host);
      })
      .catch(function () { toast('No se pudieron cargar los productos', 'error'); });
  }

  // ─── Render tabla ─────────────────────────────────────────────────────────
  function renderTabla(host) {
    var tbody = host.querySelector('#inv-tbody');
    var emptyEl = host.querySelector('#inv-empty');
    if (!tbody) return;

    var lista = state.productos;
    if (!lista.length) {
      tbody.innerHTML = '';
      if (emptyEl) emptyEl.style.display = '';
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    tbody.innerHTML = lista.map(function (p) {
      var costo  = n(p.costo_usd);
      var margen = n(p.margen_ganancia_pct);
      var stock  = n(p.stock_actual);
      var minStock = n(p.stock_minimo);
      var precios = calcPrecios(costo, margen, tasasEfectivas());
      var stockClass = stock <= 0 ? 'inv-row-agotado' : (stock <= minStock ? 'inv-row-bajo' : '');
      var stockBadge = stock <= 0
        ? '<span style="color:#ef4444;font-weight:700">AGOTADO</span>'
        : (stock <= minStock
          ? '<span style="color:#f59e0b;font-weight:700">BAJO</span>'
          : '<span style="color:#10b981">' + esc(String(stock)) + '</span>');

      return '<tr class="' + stockClass + '" data-id="' + p.id + '">' +
        '<td><strong>' + esc(p.nombre) + '</strong>' +
        (function () {
          var cod = p.codigo_barras || p.codigo_interno;
          var sub = '';
          if (p.codigo_barras && p.codigo_interno) {
            sub = esc(p.codigo_barras) + ' · SKU ' + esc(p.codigo_interno);
          } else if (cod) {
            sub = esc(cod);
          }
          return sub ? '<br><small style="color:var(--text-secondary)">' + sub + '</small>' : '';
        })() + '</td>' +
        '<td style="text-align:center">' + stockBadge + '<br><small style="color:var(--text-secondary)">mín: ' + esc(String(minStock)) + '</small></td>' +
        '<td style="text-align:right"><strong>$' + fUsd(costo) + '</strong></td>' +
        '<td style="text-align:right">' + n(margen).toFixed(1) + '%</td>' +
        '<td style="text-align:right;color:#3b82f6;font-weight:600">$' + (precios ? fUsd(precios.precio_usd) : '—') + '</td>' +
        '<td style="text-align:right;color:#6366f1">$' + (precios ? fUsdBcv(precios.precio_usd_bcv) : '—') + '</td>' +
        '<td style="text-align:right;color:#10b981">Bs. ' + (precios ? fBs(precios.precio_bs) : '—') + '</td>' +
        '<td class="inv-actions-cell">' +
        '<div class="inv-row-actions">' +
        (canDo('inventario_edit')
          ? '<button type="button" class="inv-btn inv-btn-edit" onclick="InventarioPage.editarProducto(' + p.id + ')" title="Editar producto">✏️ Editar</button>' +
            '<button type="button" class="inv-btn inv-btn-delete" onclick="InventarioPage.eliminarProducto(' + p.id + ',\'' + esc(p.nombre) + '\')" title="Eliminar producto">🗑️</button>'
          : '<button type="button" class="inv-btn inv-btn-edit" style="opacity:0.5;cursor:default" disabled title="Sin permiso para editar">✏️ Editar</button>'
        ) +
        '</div></td></tr>';
    }).join('');
  }

  function toggleGrupoStock(host, modoEdicion) {
    var gn = host.querySelector('#grupo-stock-nuevo');
    var ge = host.querySelector('#grupo-stock-editar');
    if (gn) gn.style.display = modoEdicion ? 'none' : '';
    if (ge) ge.style.display = modoEdicion ? '' : 'none';
  }

  function actualizarVistaStockBulto(host) {
    var vista = host.querySelector('#prod-stock-total-vista');
    if (!vista) return;
    var b = Math.max(0, parseInt(getValue(host, '#prod-stock-bultos'), 10) || 0);
    var u = Math.max(0, parseInt(getValue(host, '#prod-unidades-bulto'), 10) || 0);
    var c = Math.max(0, parseInt(getValue(host, '#prod-stock-cantidad'), 10) || 0);
    var upb = Math.max(1, u);
    var total = b * upb + c;
    vista.textContent = 'Total: ' + total + ' unidades';
  }

  function enfocarCampoProducto(host, sel) {
    var el = host.querySelector(sel);
    if (!el) return;
    try {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (_e) {
      el.focus();
    }
  }

  // ─── Formulario producto (una sola vista) ─────────────────────────────────
  function abrirWizard(host, productoId) {
    state.editandoId = productoId || null;
    var modal = host.querySelector('#modal-producto');
    if (!modal) return;

    modal.style.display = 'flex';

    if (productoId) {
      toggleGrupoStock(host, true);
      apiFetch('/api/productos/' + productoId)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (p) {
          if (!p) return;
          setValue(host, '#prod-nombre',    p.nombre || '');
          setValue(host, '#prod-barras',    p.codigo_barras || '');
          setValue(host, '#prod-codigo-interno', p.codigo_interno || '');
          setValue(host, '#prod-stock', String(enteroParaInput(p.stock_actual, 0)));
          setValue(host, '#prod-stock-min', String(Math.max(0, enteroParaInput(p.stock_minimo, 1))));
          setValue(host, '#prod-costo',    decimalParaInput(p.costo_usd, 4, ''));
          setValue(host, '#prod-ganancia', decimalParaInput(p.margen_ganancia_pct, 2, '30'));

          var catSel = host.querySelector('#prod-categoria');
          if (catSel && p.categoria_id) catSel.value = String(p.categoria_id);

          recalcularPreciosVista(host);

          var titulo = host.querySelector('#wizard-titulo');
          if (titulo) titulo.textContent = '✏️ Editar: ' + p.nombre;
        }).catch(function () {});
    } else {
      toggleGrupoStock(host, false);
      limpiarWizard(host);
      var titulo = host.querySelector('#wizard-titulo');
      if (titulo) titulo.textContent = '➕ Nuevo Producto';
      setTimeout(function () {
        var el = host.querySelector('#prod-nombre');
        if (el) try { el.focus(); } catch (_e) {}
      }, 0);
    }

    // Poblar selects
    poblarSelectCategorias(host);
  }

  function limpiarWizard(host) {
    ['#prod-nombre','#prod-barras','#prod-codigo-interno','#prod-stock','#prod-stock-min',
     '#prod-costo','#prod-ganancia']
      .forEach(function (sel) { setValue(host, sel, ''); });
    setValue(host, '#prod-stock-bultos', '');
    setValue(host, '#prod-unidades-bulto', '1');
    setValue(host, '#prod-stock-cantidad', '');
    actualizarVistaStockBulto(host);
    recalcularPreciosVista(host);
  }

  function setValue(host, sel, val) {
    var el = host.querySelector(sel);
    if (el) el.value = String(val);
  }

  /** Campos tipo entero cuando el API trae DECIMAL (evita ver 100,0000 en el input). */
  function enteroParaInput(raw, siInvalido) {
    var x = Math.round(parseNumFormulario(raw));
    return Number.isFinite(x) ? x : siInvalido;
  }

  /** Parseo flexible (API o copia/pega con coma decimal sin punto). */
  function parseNumFormulario(raw) {
    if (raw == null || raw === '') return NaN;
    if (typeof raw === 'number') return raw;
    var s = String(raw).trim().replace(/\s/g, '');
    if (s.indexOf(',') !== -1 && s.indexOf('.') === -1) s = s.replace(',', '.');
    return parseFloat(s);
  }

  /** Redondea y quita ceros sobrantes para <input type="number"> (valor interno con punto). */
  function decimalParaInput(raw, maxDec, siInvalido) {
    var x = parseNumFormulario(raw);
    if (!Number.isFinite(x)) return siInvalido;
    var m = Math.pow(10, maxDec);
    x = Math.round(x * m) / m;
    return String(parseFloat(x.toFixed(maxDec)));
  }

  function getValue(host, sel) {
    var el = host.querySelector(sel);
    return el ? el.value.trim() : '';
  }

  /** Lee un input numérico (acepta coma decimal si el usuario la escribe). */
  function getNumCampo(host, sel) {
    return parseNumFormulario(getValue(host, sel));
  }

  function poblarSelectCategorias(host) {
    var sel = host.querySelector('#prod-categoria');
    if (!sel) return;
    sel.innerHTML = '<option value="">Seleccionar categoría...</option>' +
      state.categorias.map(function (c) {
        return '<option value="' + c.id + '">' + esc(c.nombre) + '</option>';
      }).join('');
  }

  function recalcularPreciosVista(host) {
    var costo  = getNumCampo(host, '#prod-costo') || 0;
    var margen = getNumCampo(host, '#prod-ganancia');
    if (isNaN(margen)) margen = 0;
    var resEl  = host.querySelector('#precios-resultado');
    if (!resEl) return;

    if (costo <= 0) { resEl.style.display = 'none'; return; }
    resEl.style.display = '';

    var tAct = tasasEfectivas();
    var precios = calcPrecios(costo, margen, tAct);
    if (!precios) { resEl.style.display = 'none'; return; }

    function setResEl(sel, txt) { var el = resEl.querySelector(sel); if (el) el.textContent = txt; }
    setResEl('#res-precio-usd',     '$' + fUsd(precios.precio_usd));
    setResEl('#res-precio-usd-bcv', '$' + fUsdBcv(precios.precio_usd_bcv));
    setResEl('#res-precio-bs',      'Bs. ' + fBs(precios.precio_bs));
    setResEl('#res-margen-usd',     '$' + fUsd(precios.margen_usd) + ' / unidad');
    setResEl('#res-tasa-bcv',       f4(tAct.bcv));
    setResEl('#res-tasa-paralela',  f4(tAct.usd));
  }

  function guardarProducto(host) {
    var nombre  = getValue(host, '#prod-nombre');
    var costo   = getNumCampo(host, '#prod-costo');
    var margen  = getNumCampo(host, '#prod-ganancia');

    if (!nombre) {
      toast('El nombre del producto es obligatorio', 'error');
      enfocarCampoProducto(host, '#prod-nombre');
      return;
    }
    if (isNaN(costo) || costo <= 0) {
      toast('El costo en USD debe ser mayor a 0', 'error');
      enfocarCampoProducto(host, '#prod-costo');
      return;
    }
    if (isNaN(margen) || margen < 0) {
      toast('El porcentaje de ganancia no puede ser negativo', 'error');
      enfocarCampoProducto(host, '#prod-ganancia');
      return;
    }

    var payload = {
      nombre:             nombre,
      codigo_barras:      getValue(host, '#prod-barras') || null,
      codigo_interno:     getValue(host, '#prod-codigo-interno') || null,
      categoria_id:       getValue(host, '#prod-categoria') || null,
      stock_minimo:       Math.round(parseFloat(getValue(host, '#prod-stock-min')) || 1),
      costo_usd:          costo,
      margen_ganancia_pct: margen
    };

    if (state.editandoId) {
      payload.stock_actual = Math.round(parseFloat(getValue(host, '#prod-stock')) || 0);
    } else {
      payload.stock_bultos = Math.max(0, parseInt(getValue(host, '#prod-stock-bultos'), 10) || 0);
      payload.unidades_por_bulto = Math.max(1, parseInt(getValue(host, '#prod-unidades-bulto'), 10) || 1);
      payload.stock_cantidad = Math.max(0, parseInt(getValue(host, '#prod-stock-cantidad'), 10) || 0);
    }

    var btnGuardar = host.querySelector('#btn-guardar-producto');
    if (btnGuardar) { btnGuardar.disabled = true; btnGuardar.textContent = '⏳ Guardando...'; }

    var method = state.editandoId ? 'PATCH' : 'POST';
    var url    = state.editandoId ? '/api/productos/' + state.editandoId : '/api/productos';

    apiFetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Error al guardar');
        return d;
      });
    }).then(function () {
      toast(state.editandoId ? '✓ Producto actualizado correctamente' : '✓ Producto creado correctamente', 'success');
      cerrarModal(host);
      cargarProductos(host);
    }).catch(function (e) {
      toast(e.message || 'No se pudo guardar el producto', 'error');
    }).finally(function () {
      if (btnGuardar) { btnGuardar.disabled = false; btnGuardar.textContent = '✓ Guardar producto'; }
    });
  }

  function cerrarModal(host) {
    var modal = host.querySelector('#modal-producto');
    if (modal) modal.style.display = 'none';
    state.editandoId = null;
  }

  function abrirModalNuevaCategoria(host) {
    var modal = host.querySelector('#modal-nueva-categoria');
    var inp = host.querySelector('#input-nueva-categoria-nombre');
    if (!modal || !inp) return;
    inp.value = '';
    modal.style.display = 'flex';
    setTimeout(function () {
      try {
        inp.focus();
      } catch (_e) {}
    }, 0);
  }

  function cerrarModalNuevaCategoria(host) {
    var modal = host.querySelector('#modal-nueva-categoria');
    if (modal) modal.style.display = 'none';
  }

  function confirmarNuevaCategoria(host) {
    var inp = host.querySelector('#input-nueva-categoria-nombre');
    if (!inp) return;
    var nombre = String(inp.value || '').trim();
    if (!nombre) {
      toast('Escribe un nombre para la categoría', 'info');
      try { inp.focus(); } catch (_e) {}
      return;
    }
    var btn = host.querySelector('#btn-confirmar-nueva-categoria');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Creando...'; }
    apiFetch('/api/inventario/categorias', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: nombre })
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Error al crear categoría');
        return d;
      });
    }).then(function (cat) {
      state.categorias.push(cat);
      poblarSelectCategorias(host);
      var selCat = host.querySelector('#prod-categoria');
      if (selCat) selCat.value = String(cat.id);
      toast('✓ Categoría "' + cat.nombre + '" creada', 'success');
      cerrarModalNuevaCategoria(host);
    }).catch(function (err) {
      toast(err.message || 'Error al crear categoría', 'error');
    }).finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Crear categoría'; }
    });
  }

  // ─── Ajuste masivo ────────────────────────────────────────────────────────
  function abrirAjusteMasivo(host) {
    var modal = host.querySelector('#modal-ajuste-masivo');
    if (modal) {
      modal.style.display = 'flex';
      // Poblar categorías
      var catSel = modal.querySelector('#ajuste-categoria');
      if (catSel) {
        catSel.innerHTML = state.categorias.map(function (c) {
          return '<option value="' + c.id + '">' + esc(c.nombre) + '</option>';
        }).join('');
      }
    }
  }

  function cargarPreviewAjuste(host) {
    var modal = host.querySelector('#modal-ajuste-masivo');
    if (!modal) return;
    var scope    = modal.querySelector('#ajuste-scope').value;
    var catId    = modal.querySelector('#ajuste-categoria').value;
    var tipo     = (modal.querySelector('[data-tipo-activo]') || modal.querySelector('.btn-ajuste-tipo.activo') || { dataset: { tipo: 'nuevo_fijo' } }).dataset.tipo;
    var valor    = modal.querySelector('#ajuste-valor').value;
    var preview  = modal.querySelector('#ajuste-preview');
    var btnAplicar = modal.querySelector('#btn-aplicar-ajuste');
    var countEl  = modal.querySelector('#ajuste-count');

    if (!valor || parseFloat(valor) < 0) {
      if (preview) preview.style.display = 'none';
      if (btnAplicar) btnAplicar.disabled = true;
      return;
    }

    var q = '?scope=' + scope + '&tipo=' + tipo + '&valor=' + encodeURIComponent(valor);
    if (scope === 'categoria' && catId) q += '&categoria_id=' + catId;

    apiFetch('/api/inventario/preview-ajuste' + q)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !preview) return;
        preview.style.display = '';
        if (countEl) countEl.textContent = d.total || 0;
        if (btnAplicar) btnAplicar.disabled = !d.total;

        // Mostrar muestra de precios
        var muestra = (d.preview || []).slice(0, 5);
        preview.innerHTML = '<p style="font-size:.85rem;margin-bottom:.5rem;color:var(--text-secondary)">Vista previa (' + d.total + ' productos):</p>' +
          '<table style="width:100%;font-size:.8rem;border-collapse:collapse">' +
          '<tr><th style="text-align:left;padding:.3rem">Producto</th><th>Antes</th><th>Después</th><th>Diferencia</th></tr>' +
          muestra.map(function (p) {
            var dif = p.precio_usd_nuevo - p.precio_usd_antes;
            return '<tr style="border-bottom:1px solid var(--border-subtle)">' +
              '<td style="padding:.3rem">' + esc(p.nombre) + '</td>' +
              '<td style="text-align:right">$' + fUsd(p.precio_usd_antes) + '</td>' +
              '<td style="text-align:right;color:#10b981">$' + fUsd(p.precio_usd_nuevo) + '</td>' +
              '<td style="text-align:right;color:' + (dif >= 0 ? '#10b981' : '#ef4444') + '">' +
              (dif >= 0 ? '+' : '') + fUsd(dif) + '</td></tr>';
          }).join('') + '</table>';
      }).catch(function () {});
  }

  function aplicarAjusteMasivo(host) {
    var modal = host.querySelector('#modal-ajuste-masivo');
    if (!modal) return;
    var scope    = modal.querySelector('#ajuste-scope').value;
    var catId    = modal.querySelector('#ajuste-categoria').value;
    var tipoEl   = modal.querySelector('.btn-ajuste-tipo.activo') || { dataset: { tipo: 'nuevo_fijo' } };
    var tipo     = tipoEl.dataset.tipo;
    var valor    = parseFloat(modal.querySelector('#ajuste-valor').value);
    var countEl  = modal.querySelector('#ajuste-count');
    var count    = countEl ? parseInt(countEl.textContent) : 0;

    if (isNaN(valor) || valor < 0) { toast('Ingresa un valor válido', 'error'); return; }

    var confirmMsg = '¿Seguro que quieres cambiar el precio de ' + count + ' productos? Esta acción afectará todos los precios de venta.';
    if (!confirm(confirmMsg)) return;

    var payload = { scope, tipo, valor };
    if (scope === 'categoria' && catId) payload.categoria_id = catId;

    var btn = modal.querySelector('#btn-aplicar-ajuste');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Aplicando...'; }

    apiFetch('/api/inventario/ajuste-masivo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Error al aplicar ajuste');
        return d;
      });
    }).then(function (d) {
      toast('✓ ' + d.message, 'success');
      modal.style.display = 'none';
      cargarProductos(host);
    }).catch(function (e) {
      toast(e.message || 'Error al aplicar ajuste masivo', 'error');
    }).finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = '✓ Aplicar a <span id="ajuste-count">' + count + '</span> productos'; }
    });
  }

  // ─── Importar desde Excel ─────────────────────────────────────────────────
  function abrirModalImportar(host) {
    var modal = host.querySelector('#modal-importar');
    if (!modal) return;
    resetImportarModal(host);
    modal.style.display = 'flex';
  }

  function resetImportarModal(host) {
    var modal = host.querySelector('#modal-importar');
    if (!modal) return;
    var panelInicio    = modal.querySelector('#imp-panel-inicio');
    var panelProgreso  = modal.querySelector('#imp-panel-progreso');
    var panelResultado = modal.querySelector('#imp-panel-resultado');
    if (panelInicio)    panelInicio.style.display    = '';
    if (panelProgreso)  panelProgreso.style.display  = 'none';
    if (panelResultado) panelResultado.style.display = 'none';
    var inp = modal.querySelector('#imp-archivo');
    if (inp) inp.value = '';
    var info = modal.querySelector('#imp-archivo-info');
    if (info) info.style.display = 'none';
    var btn = modal.querySelector('#btn-iniciar-importacion');
    if (btn) btn.disabled = true;
  }

  function descargarPlantilla(host) {
    var url = apiBase() + '/api/productos/importar/plantilla';
    apiFetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('No se pudo descargar la plantilla');
        return r.blob();
      })
      .then(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'plantilla-importacion-productos.xlsx';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
      })
      .catch(function (e) { toast(e.message || 'Error al descargar plantilla', 'error'); });
  }

  function iniciarImportacion(host) {
    var modal = host.querySelector('#modal-importar');
    if (!modal) return;
    var inp = modal.querySelector('#imp-archivo');
    if (!inp || !inp.files || !inp.files[0]) {
      toast('Selecciona un archivo .xlsx primero', 'info');
      return;
    }
    var archivo = inp.files[0];

    var panelInicio    = modal.querySelector('#imp-panel-inicio');
    var panelProgreso  = modal.querySelector('#imp-panel-progreso');
    if (panelInicio)   panelInicio.style.display   = 'none';
    if (panelProgreso) panelProgreso.style.display = '';

    var fd = new FormData();
    fd.append('archivo', archivo);

    apiFetch('/api/productos/importar', {
      method: 'POST',
      body: fd,
    })
      .then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error(d.error || 'Error en la importación');
          return d;
        });
      })
      .then(function (resultado) {
        if (panelProgreso) panelProgreso.style.display = 'none';
        mostrarResultadoImportacion(host, resultado);
        if (resultado.importados > 0) cargarProductos(host);
      })
      .catch(function (e) {
        if (panelProgreso) panelProgreso.style.display = 'none';
        if (panelInicio)   panelInicio.style.display   = '';
        toast(e.message || 'Error al importar', 'error');
      });
  }

  function mostrarResultadoImportacion(host, r) {
    var modal = host.querySelector('#modal-importar');
    if (!modal) return;
    var panelResultado = modal.querySelector('#imp-panel-resultado');
    if (!panelResultado) return;
    panelResultado.style.display = '';

    // Tarjetas resumen
    var resumen = modal.querySelector('#imp-resumen');
    if (resumen) {
      resumen.innerHTML =
        tarjetaResumen('✅ Importados', r.importados, '#10b981') +
        tarjetaResumen('⚠️ Omitidos', r.omitidos, r.omitidos > 0 ? '#f59e0b' : '#6b7280') +
        tarjetaResumen('📊 Total filas', r.total, '#3b82f6');
    }

    // Tabla detalle
    var tbody = modal.querySelector('#imp-detalle-tbody');
    if (!tbody) return;
    var filas = r.filas || [];
    if (!filas.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:1rem;color:var(--text-secondary)">Sin filas procesadas</td></tr>';
      return;
    }
    tbody.innerHTML = filas.map(function (f) {
      var estadoHtml, detalleHtml;
      if (f.estado === 'importado') {
        estadoHtml = '<span style="color:#10b981;font-weight:700">✅ OK</span>';
        detalleHtml = f.codigo_interno
          ? '<span style="color:var(--text-muted)">SKU: ' + esc(f.codigo_interno) + '</span>'
          : '';
      } else if (f.estado === 'error') {
        estadoHtml = '<span style="color:#ef4444;font-weight:700">❌ Error</span>';
        detalleHtml = esc(f.razon || '');
      } else {
        estadoHtml = '<span style="color:#f59e0b;font-weight:700">— Omitido</span>';
        detalleHtml = esc(f.razon || '');
      }
      return '<tr style="border-bottom:1px solid var(--border-subtle)">' +
        '<td style="text-align:center;padding:.4rem .6rem;color:var(--text-muted)">' + esc(String(f.fila || '')) + '</td>' +
        '<td style="padding:.4rem .6rem;font-weight:' + (f.estado === 'importado' ? '600' : 'normal') + '">' + esc(f.nombre || '—') + '</td>' +
        '<td style="text-align:center;padding:.4rem .6rem">' + estadoHtml + '</td>' +
        '<td style="padding:.4rem .6rem;color:var(--text-secondary)">' + detalleHtml + '</td>' +
        '</tr>';
    }).join('');
  }

  function tarjetaResumen(label, valor, color) {
    return '<div style="flex:1;min-width:120px;background:var(--bg-tertiary);border:1px solid var(--border-primary);border-radius:var(--radius-md);padding:.75rem;text-align:center">' +
      '<div style="font-size:1.5rem;font-weight:700;color:' + color + '">' + String(valor) + '</div>' +
      '<div style="font-size:.78rem;color:var(--text-secondary);margin-top:.2rem">' + label + '</div>' +
      '</div>';
  }

  // ─── Eliminar producto ────────────────────────────────────────────────────
  function eliminarProducto(id, nombre) {
    if (!confirm('¿Seguro que quieres eliminar "' + nombre + '"? Esto no se puede deshacer.')) return;
    apiFetch('/api/productos/' + id, { method: 'DELETE' })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || 'Error'); });
        toast('✓ Producto eliminado', 'success');
        state.productos = state.productos.filter(function (p) { return p.id !== id; });
        if (window.InventarioPage._host) renderTabla(window.InventarioPage._host);
      })
      .catch(function (e) { toast(e.message || 'No se pudo eliminar el producto', 'error'); });
  }

  // ─── Mount ────────────────────────────────────────────────────────────────
  window.InventarioPage = {
    _host: null,
    mount: function (host) {
      this._host = host;

      Promise.all([cargarTasas(), cargarCategorias()])
        .then(function () { cargarProductos(host); });

      // Búsqueda
      var searchInput = host.querySelector('#inv-buscar');
      if (searchInput) {
        var debounce;
        searchInput.addEventListener('input', function () {
          clearTimeout(debounce);
          debounce = setTimeout(function () {
            state.busqueda = searchInput.value.trim();
            state.paginaActual = 1;
            cargarProductos(host);
          }, 320);
        });
      }

      // Filtros rápidos
      host.querySelectorAll('[data-filtro]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          state.filtro = btn.dataset.filtro;
          state.paginaActual = 1;
          host.querySelectorAll('[data-filtro]').forEach(function (b) { b.classList.toggle('active', b === btn); });
          cargarProductos(host);
        });
      });

      // Botón nuevo producto
      var btnNuevo = host.querySelector('#btn-nuevo-producto');
      if (btnNuevo) btnNuevo.addEventListener('click', function () { abrirWizard(host, null); });

      // Ajuste masivo
      var btnAjuste = host.querySelector('#btn-ajuste-masivo');
      if (btnAjuste) btnAjuste.addEventListener('click', function () { abrirAjusteMasivo(host); });

      // Exportar Excel
      var btnExcel = host.querySelector('#btn-exportar-excel');
      if (btnExcel) {
        btnExcel.addEventListener('click', function () {
          var url = apiBase() + '/api/reportes/excel/control-precios';
          apiFetch(url)
            .then(function (r) {
              if (!r.ok) throw new Error('Error al exportar');
              return r.blob();
            })
            .then(function (blob) {
              var a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = 'inventario-' + new Date().toISOString().slice(0, 10) + '.xlsx';
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(a.href);
            })
            .catch(function (err) {
              console.error('Export error:', err);
              alert('No se pudo exportar el Excel. Verifique sus permisos.');
            });
        });
      }

      ['#prod-costo', '#prod-ganancia'].forEach(function (sel) {
        var el = host.querySelector(sel);
        if (el) el.addEventListener('input', function () { recalcularPreciosVista(host); });
      });

      ['#prod-stock-bultos', '#prod-unidades-bulto', '#prod-stock-cantidad'].forEach(function (sel) {
        var el = host.querySelector(sel);
        if (el) el.addEventListener('input', function () { actualizarVistaStockBulto(host); });
      });

      // Guardar producto
      var btnGuardar = host.querySelector('#btn-guardar-producto');
      if (btnGuardar) btnGuardar.addEventListener('click', function () { guardarProducto(host); });

      // Cerrar modales
      host.querySelectorAll('[data-cerrar-modal]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var modalId = btn.dataset.cerrarModal;
          var modal = host.querySelector('#' + modalId) || host.querySelector('.modal-overlay');
          if (modal) modal.style.display = 'none';
          if (modalId === 'modal-producto') state.editandoId = null;
        });
      });

      // Tipos de ajuste
      host.querySelectorAll('.btn-ajuste-tipo').forEach(function (btn) {
        btn.addEventListener('click', function () {
          host.querySelectorAll('.btn-ajuste-tipo').forEach(function (b) {
            b.classList.remove('activo');
            b.removeAttribute('data-tipo-activo');
          });
          btn.classList.add('activo');
          btn.setAttribute('data-tipo-activo', '');
          cargarPreviewAjuste(host);
        });
      });

      // Preview ajuste masivo
      ['#ajuste-scope','#ajuste-categoria','#ajuste-valor'].forEach(function (sel) {
        var el = host.querySelector(sel);
        if (el) el.addEventListener('change', function () { cargarPreviewAjuste(host); });
        if (el) el.addEventListener('input',  function () { cargarPreviewAjuste(host); });
      });

      // Confirmar ajuste masivo
      var btnAplicarAjuste = host.querySelector('#btn-aplicar-ajuste');
      if (btnAplicarAjuste) btnAplicarAjuste.addEventListener('click', function () { aplicarAjusteMasivo(host); });

      // Importar Excel
      var btnImportar = host.querySelector('#btn-importar-excel');
      if (btnImportar) btnImportar.addEventListener('click', function () { abrirModalImportar(host); });

      var btnPlantilla = host.querySelector('#btn-descargar-plantilla');
      if (btnPlantilla) btnPlantilla.addEventListener('click', function () { descargarPlantilla(host); });

      var btnIniciarImp = host.querySelector('#btn-iniciar-importacion');
      if (btnIniciarImp) btnIniciarImp.addEventListener('click', function () { iniciarImportacion(host); });

      var btnNuevaImp = host.querySelector('#btn-imp-nueva');
      if (btnNuevaImp) btnNuevaImp.addEventListener('click', function () { resetImportarModal(host); });

      var impArchivo = host.querySelector('#imp-archivo');
      if (impArchivo) {
        impArchivo.addEventListener('change', function () {
          var archivo = impArchivo.files && impArchivo.files[0];
          var info = host.querySelector('#imp-archivo-info');
          var btn = host.querySelector('#btn-iniciar-importacion');
          if (archivo) {
            var kb = (archivo.size / 1024).toFixed(1);
            if (info) {
              info.textContent = '📄 ' + archivo.name + '  ·  ' + kb + ' KB';
              info.style.display = '';
            }
            if (btn) btn.disabled = false;
          } else {
            if (info) info.style.display = 'none';
            if (btn) btn.disabled = true;
          }
        });
      }

      var self = this;
      if (self._delegadoCrearCategoria) {
        host.removeEventListener('click', self._delegadoCrearCategoria);
      }
      self._delegadoCrearCategoria = function (e) {
        var t = e.target;
        if (!t || !t.closest) return;
        if (t.closest('#btn-crear-categoria')) {
          e.preventDefault();
          e.stopPropagation();
          abrirModalNuevaCategoria(host);
          return;
        }
        if (t.closest('#btn-confirmar-nueva-categoria')) {
          e.preventDefault();
          e.stopPropagation();
          confirmarNuevaCategoria(host);
        }
      };
      host.addEventListener('click', self._delegadoCrearCategoria);

      var inpNuevaCat = host.querySelector('#input-nueva-categoria-nombre');
      if (inpNuevaCat) {
        inpNuevaCat.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            confirmarNuevaCategoria(host);
          }
        });
      }

    },
    editarProducto: function (id) { abrirWizard(this._host, id); },
    eliminarProducto: function (id, nombre) { eliminarProducto(id, nombre); }
  };

  function refrescarInventarioPorTasas() {
    sincronizarStateTasasDesdeOrigen();
    var h = window.InventarioPage && window.InventarioPage._host;
    if (!h || (typeof document !== 'undefined' && document.body && !document.body.contains(h))) return;
    recalcularPreciosVista(h);
    renderTabla(h);
  }

  window.addEventListener('nexus:tasas', refrescarInventarioPorTasas);
  if (typeof document !== 'undefined') {
    document.addEventListener('input', function (ev) {
      var t = ev.target;
      if (!t || !t.id) return;
      if (t.id === 'navbar-tasa-bcv' || t.id === 'navbar-tasa-usd') refrescarInventarioPorTasas();
    });
  }
})();
