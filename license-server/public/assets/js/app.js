'use strict';

/**
 * app.js — Lógica del panel: autenticación, enrutado por hash y vistas
 * (Panel, Licencias, Clientes, Vencimientos, Servidor). Orquesta Api + UI.
 */

const App = (() => {
  const state = {
    licenses: [],
    stats: {},
    loaded: false,
    serverHost: ''
  };

  // ── Rutas ──────────────────────────────────────────────────────────────
  const ROUTES = {
    dashboard:    { title: 'Panel',         render: renderDashboard },
    licencias:    { title: 'Licencias',     render: renderLicencias },
    clientes:     { title: 'Clientes',      render: renderClientes },
    vencimientos: { title: 'Vencimientos',  render: renderVencimientos },
    servidor:     { title: 'Servidor',      render: renderServidor }
  };

  const $ = (sel) => document.querySelector(sel);
  const content = () => $('#content');

  // ── Arranque / sesión ───────────────────────────────────────────────────
  async function init() {
    bindGlobal();
    try {
      const s = await Api.session();
      if (s.authenticated) { enterApp(); } else { showLogin(); }
    } catch (_e) {
      showLogin();
    }
  }

  function showLogin() {
    $('#appShell').classList.add('hidden');
    $('#loginScreen').classList.remove('hidden');
    const inp = $('#loginPassword');
    inp.value = '';
    setTimeout(() => inp.focus(), 50);
  }

  async function doLogin(e) {
    e.preventDefault();
    const pwd = $('#loginPassword').value;
    const errEl = $('#loginError');
    errEl.textContent = '';
    if (!pwd) { errEl.textContent = 'Ingresa la contraseña.'; return; }
    const btn = $('#loginForm button');
    btn.disabled = true; btn.textContent = 'Verificando…';
    try {
      await Api.login(pwd);
      enterApp();
    } catch (err) {
      errEl.textContent = err.message || 'No se pudo iniciar sesión.';
    } finally {
      btn.disabled = false; btn.textContent = 'Entrar';
    }
  }

  async function doLogout() {
    try { await Api.logout(); } catch (_e) { /* idempotente */ }
    state.loaded = false;
    showLogin();
  }

  function enterApp() {
    $('#loginScreen').classList.add('hidden');
    $('#appShell').classList.remove('hidden');
    if (!location.hash) location.hash = '#/dashboard';
    else renderRoute();
    refreshData(true);
    pollHealth();
  }

  // ── Datos ────────────────────────────────────────────────────────────────
  async function refreshData(silent) {
    try {
      const r = await Api.listLicenses();
      state.licenses = r.licenses || [];
      state.stats = r.stats || {};
      state.loaded = true;
      renderRoute();
    } catch (err) {
      if (!silent) UI.toast(err.message, 'err');
    }
  }

  async function pollHealth() {
    const pill = $('#serverPill');
    const txt = $('#serverPillText');
    try {
      const h = await Api.health();
      state.serverHost = h.serverHost || '';
      if (h.server && h.server.ok) {
        pill.className = 'server-pill up';
        txt.textContent = 'Servidor en línea';
      } else {
        pill.className = 'server-pill down';
        txt.textContent = 'Servidor sin responder';
      }
    } catch (_e) {
      pill.className = 'server-pill down';
      txt.textContent = 'Sin conexión';
    }
  }

  // ── Enrutado ───────────────────────────────────────────────────────────
  function currentRoute() {
    const r = (location.hash || '').replace(/^#\/?/, '').split('/')[0];
    return ROUTES[r] ? r : 'dashboard';
  }

  function renderRoute() {
    if ($('#appShell').classList.contains('hidden')) return;
    const r = currentRoute();
    const route = ROUTES[r];
    $('#pageTitle').textContent = route.title;
    document.querySelectorAll('.nav-item').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-route') === r);
    });
    closeSidebar();
    route.render();
  }

  // ════════════ VISTA: PANEL ════════════
  async function renderDashboard() {
    content().innerHTML = UI.spinner('Cargando panel…');
    let d;
    try { d = await Api.stats(); }
    catch (err) { content().innerHTML = errorState(err.message); return; }

    const s = d.stats || {};
    const dv = d.derived || {};
    const kpis = [
      ['accent', s.total || 0, 'Licencias'],
      ['ok', s.active || 0, 'Activas'],
      ['warn', s.suspended || 0, 'Suspendidas'],
      ['danger', (s.expired || 0) + (s.revoked || 0), 'Vencidas / revocadas'],
      ['info', dv.distinctCustomers || 0, 'Clientes'],
      ['', dv.totalActivations || 0, 'Equipos activos']
    ];

    const soon = d.expiringSoon || [];
    const recent = d.recent || [];

    content().innerHTML = `
      <div class="view">
        <div class="kpi-grid">
          ${kpis.map(([c, v, l]) => `
            <div class="kpi ${c}">
              <div class="kpi-value">${v}</div>
              <div class="kpi-label">${l}</div>
            </div>`).join('')}
        </div>

        <div class="grid-2">
          <div class="panel">
            <div class="panel-head">
              <h3>Por vencer (${dv.expiringSoonThreshold || 30} días)</h3>
              <button class="btn btn-sm btn-ghost" data-action="nav" data-route="vencimientos">Ver todos</button>
            </div>
            <div class="panel-body">
              ${soon.length ? `<div class="mini-list">${soon.map(miniExpiring).join('')}</div>`
                : `<div class="empty-state">Nada por vencer pronto. 👍</div>`}
            </div>
          </div>

          <div class="panel">
            <div class="panel-head">
              <h3>Licencias recientes</h3>
              <button class="btn btn-sm btn-ghost" data-action="nav" data-route="licencias">Ver todas</button>
            </div>
            <div class="panel-body">
              ${recent.length ? `<div class="mini-list">${recent.map(miniRecent).join('')}</div>`
                : `<div class="empty-state">Aún no has creado licencias.</div>`}
            </div>
          </div>
        </div>

        <div style="margin-top:20px;display:flex;gap:12px;flex-wrap:wrap;">
          <button class="btn btn-primary" data-action="open-create">+ Nueva licencia</button>
          <button class="btn" data-action="open-create" data-preset="trial">Crear prueba rápida</button>
          <button class="btn btn-ghost" data-action="refresh">↻ Actualizar</button>
        </div>
      </div>`;
  }

  function miniExpiring(l) {
    return `<div class="mini-row clickable" data-action="open-detail" data-key="${UI.esc(l.key)}">
      <div class="l">
        <div class="t">${UI.esc(l.customerName)}</div>
        <div class="s">${UI.esc(l.key)}</div>
      </div>
      <div style="text-align:right;">
        ${UI.badge(l.daysRemaining <= 7 ? 'red' : 'yellow', UI.relDays(l.daysRemaining))}
        <div class="s mono" style="margin-top:4px;color:var(--text-secondary)">${UI.fmtDate(l.expiresAt)}</div>
      </div>
    </div>`;
  }

  function miniRecent(l) {
    return `<div class="mini-row clickable" data-action="open-detail" data-key="${UI.esc(l.key)}">
      <div class="l">
        <div class="t">${UI.esc(l.customerName)}</div>
        <div class="s">${UI.esc(l.key)}</div>
      </div>
      <div style="text-align:right;display:flex;gap:6px;align-items:center;">
        ${UI.typeBadge(l.type)}
        ${UI.statusBadge(l)}
      </div>
    </div>`;
  }

  // ════════════ VISTA: LICENCIAS ════════════
  function renderLicencias() {
    content().innerHTML = `
      <div class="view">
        <div class="section-head">
          <div>
            <h2>Licencias</h2>
            <p class="section-sub">${state.licenses.length} en total · clic en una fila para gestionarla</p>
          </div>
          <div style="display:flex;gap:10px;">
            <button class="btn btn-primary" data-action="open-create">+ Nueva</button>
            <button class="btn btn-ghost" data-action="refresh">↻</button>
          </div>
        </div>

        <div class="toolbar">
          <input class="search" id="lqSearch" placeholder="Buscar por licencia, cliente o email…" />
          <select id="lqStatus">
            <option value="">Todos los estados</option>
            <option value="active">Activas</option>
            <option value="suspended">Suspendidas</option>
            <option value="revoked">Revocadas</option>
          </select>
          <select id="lqType">
            <option value="">Todos los tipos</option>
            <option value="subscription">Suscripción</option>
            <option value="permanent">Permanente</option>
            <option value="trial">Prueba</option>
          </select>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Licencia</th>
                <th class="hide-sm">Cliente</th>
                <th>Tipo</th>
                <th>Estado</th>
                <th class="hide-sm">Vence</th>
                <th class="num">Equipos</th>
              </tr>
            </thead>
            <tbody id="licRows"></tbody>
          </table>
        </div>
      </div>`;

    const rerender = () => renderLicenseRows();
    $('#lqSearch').addEventListener('input', rerender);
    $('#lqStatus').addEventListener('change', rerender);
    $('#lqType').addEventListener('change', rerender);
    renderLicenseRows();
  }

  function filteredLicenses() {
    const q = ($('#lqSearch') ? $('#lqSearch').value : '').trim().toLowerCase();
    const fs = $('#lqStatus') ? $('#lqStatus').value : '';
    const ft = $('#lqType') ? $('#lqType').value : '';
    return state.licenses.filter((l) => {
      if (fs && l.status !== fs) return false;
      if (ft && l.type !== ft) return false;
      if (q) {
        const hay = [l.key, l.customerName, l.customerEmail].map((x) => String(x || '').toLowerCase()).join(' ');
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function renderLicenseRows() {
    const rows = filteredLicenses();
    const tbody = $('#licRows');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Ninguna licencia coincide con el filtro.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map((l) => `
      <tr class="clickable" data-action="open-detail" data-key="${UI.esc(l.key)}">
        <td class="cell-key">${UI.esc(l.key)}</td>
        <td class="hide-sm cell-strong">${UI.esc(l.customerName || '—')}</td>
        <td>${UI.typeBadge(l.type)}</td>
        <td>${UI.statusBadge(l)}</td>
        <td class="hide-sm mono">${UI.esc(UI.expiryText(l))}</td>
        <td class="num">${l.activationCount || 0}/${l.maxActivations || 1}</td>
      </tr>`).join('');
  }

  // ════════════ VISTA: CLIENTES ════════════
  function renderClientes() {
    const map = new Map();
    for (const l of state.licenses) {
      const k = (l.customerEmail || l.customerName || '—').toLowerCase();
      if (!map.has(k)) map.set(k, { name: l.customerName || '—', email: l.customerEmail || '', licenses: [], activations: 0, active: 0 });
      const c = map.get(k);
      c.licenses.push(l);
      c.activations += l.activationCount || 0;
      if (l.status === 'active' && !l.expired) c.active += 1;
    }
    const clients = [...map.values()].sort((a, b) => b.licenses.length - a.licenses.length);

    content().innerHTML = `
      <div class="view">
        <div class="section-head">
          <div>
            <h2>Clientes</h2>
            <p class="section-sub">${clients.length} cliente(s) · agrupados por correo o nombre</p>
          </div>
          <button class="btn btn-ghost" data-action="refresh">↻</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th class="hide-sm">Email</th>
                <th class="num">Licencias</th>
                <th class="num">Activas</th>
                <th class="num hide-sm">Equipos</th>
              </tr>
            </thead>
            <tbody>
              ${clients.length ? clients.map((c) => `
                <tr class="clickable" data-action="open-client" data-client="${UI.esc((c.email || c.name).toLowerCase())}">
                  <td class="cell-strong">${UI.esc(c.name)}</td>
                  <td class="hide-sm mono">${UI.esc(c.email || '—')}</td>
                  <td class="num">${c.licenses.length}</td>
                  <td class="num">${c.active}</td>
                  <td class="num hide-sm">${c.activations}</td>
                </tr>`).join('')
                : `<tr class="empty-row"><td colspan="5">Aún no hay clientes.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function openClient(clientKey) {
    const list = state.licenses.filter((l) => (l.customerEmail || l.customerName || '—').toLowerCase() === clientKey);
    if (!list.length) return;
    const c = list[0];
    UI.openModal(`
      <div class="modal wide">
        <div class="modal-head">
          <h2>${UI.esc(c.customerName || 'Cliente')}</h2>
          <button class="modal-close" data-action="close-modal">✕</button>
        </div>
        <div class="modal-body">
          <dl class="dl">
            <dt>Email</dt><dd class="mono">${UI.esc(c.customerEmail || '—')}</dd>
            <dt>Licencias</dt><dd>${list.length}</dd>
          </dl>
          <div class="subhead">Licencias del cliente</div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Licencia</th><th>Tipo</th><th>Estado</th><th class="hide-sm">Vence</th></tr></thead>
              <tbody>
                ${list.map((l) => `
                  <tr class="clickable" data-action="open-detail" data-key="${UI.esc(l.key)}">
                    <td class="cell-key">${UI.esc(l.key)}</td>
                    <td>${UI.typeBadge(l.type)}</td>
                    <td>${UI.statusBadge(l)}</td>
                    <td class="hide-sm mono">${UI.esc(UI.expiryText(l))}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot"><button class="btn" data-action="close-modal">Cerrar</button></div>
      </div>`);
  }

  // ════════════ VISTA: VENCIMIENTOS ════════════
  function renderVencimientos() {
    const now = Date.now();
    const list = state.licenses
      .filter((l) => l.type !== 'permanent' && l.expiresAt)
      .map((l) => ({ ...l, _t: Date.parse(l.expiresAt) || 0 }))
      .sort((a, b) => a._t - b._t);

    content().innerHTML = `
      <div class="view">
        <div class="section-head">
          <div>
            <h2>Vencimientos</h2>
            <p class="section-sub">Licencias con fecha de vencimiento, ordenadas por proximidad</p>
          </div>
          <button class="btn btn-ghost" data-action="refresh">↻</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Licencia</th>
                <th class="hide-sm">Cliente</th>
                <th>Estado</th>
                <th>Vence</th>
                <th class="num">Restante</th>
              </tr>
            </thead>
            <tbody>
              ${list.length ? list.map((l) => {
                const dr = l.daysRemaining;
                const drCls = dr == null ? 'neutral' : (dr < 0 ? 'red' : (dr <= 7 ? 'red' : (dr <= 30 ? 'yellow' : 'green')));
                return `<tr class="clickable" data-action="open-detail" data-key="${UI.esc(l.key)}">
                  <td class="cell-key">${UI.esc(l.key)}</td>
                  <td class="hide-sm cell-strong">${UI.esc(l.customerName || '—')}</td>
                  <td>${UI.statusBadge(l)}</td>
                  <td class="mono">${UI.fmtDate(l.expiresAt)}</td>
                  <td class="num">${UI.badge(drCls, dr == null ? '—' : dr + 'd')}</td>
                </tr>`;
              }).join('')
              : `<tr class="empty-row"><td colspan="5">No hay licencias con vencimiento.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  // ════════════ VISTA: SERVIDOR ════════════
  async function renderServidor() {
    content().innerHTML = UI.spinner('Consultando servidor…');
    let h;
    try { h = await Api.health(); }
    catch (err) { content().innerHTML = errorState(err.message); return; }

    const ok = h.server && h.server.ok;
    content().innerHTML = `
      <div class="view">
        <div class="section-head"><div><h2>Servidor de licencias</h2>
          <p class="section-sub">Estado del backend desplegado en Vercel</p></div>
          <button class="btn btn-ghost" data-action="reload-server">↻ Re-verificar</button>
        </div>
        <div class="panel" style="max-width:560px;">
          <div class="panel-body">
            <dl class="dl">
              <dt>Estado</dt><dd>${ok ? UI.badge('green', 'En línea') : UI.badge('red', 'No responde')}</dd>
              <dt>Host</dt><dd class="mono">${UI.esc(h.serverHost || '—')}</dd>
              <dt>Versión</dt><dd class="mono">${UI.esc((h.server && h.server.version) || '—')}</dd>
              <dt>Base de datos</dt><dd>${(h.server && h.server.kv === 'ok') ? UI.badge('green', 'KV operativa') : UI.badge('red', (h.server && h.server.kv) || 'desconocida')}</dd>
            </dl>
            <hr class="divider" />
            <p class="hint">El panel se comunica con el servidor mediante un proxy seguro: la clave de
            administración vive sólo en el servidor del panel y nunca llega a este navegador.</p>
          </div>
        </div>
      </div>`;
  }

  function errorState(msg) {
    return `<div class="view"><div class="panel"><div class="empty-state">
      <div style="font-size:22px;margin-bottom:8px;color:var(--badge-red-text)">No se pudo cargar</div>
      <div class="muted">${UI.esc(msg || 'Error desconocido')}</div>
      <div style="margin-top:16px;"><button class="btn" data-action="refresh">Reintentar</button></div>
    </div></div></div>`;
  }

  // ════════════ MODAL: CREAR ════════════
  function openCreate(preset) {
    const isTrial = preset === 'trial';
    UI.openModal(`
      <div class="modal">
        <div class="modal-head">
          <h2>Nueva licencia</h2>
          <button class="modal-close" data-action="close-modal">✕</button>
        </div>
        <div class="modal-body">
          <label for="cType">Tipo de licencia</label>
          <select id="cType">
            <option value="subscription" ${!isTrial ? 'selected' : ''}>Suscripción · con vencimiento</option>
            <option value="permanent">Permanente · sin vencimiento</option>
            <option value="trial" ${isTrial ? 'selected' : ''}>Prueba · gratuita por días</option>
          </select>
          <div class="row2">
            <div><label for="cName">Cliente</label><input id="cName" placeholder="Nombre del negocio" /></div>
            <div><label for="cEmail">Email</label><input id="cEmail" placeholder="correo@cliente.com" /></div>
          </div>
          <div class="row2">
            <div id="cDurWrap">
              <label id="cDurLabel" for="cDur">Duración (días)</label>
              <input id="cDur" class="mono" type="number" min="1" value="${isTrial ? 15 : 365}" />
            </div>
            <div><label for="cMax">Máx. equipos</label><input id="cMax" class="mono" type="number" min="1" max="100" value="1" /></div>
          </div>
          <label for="cFeatures">Funcionalidades (opcional, separadas por coma)</label>
          <input id="cFeatures" placeholder="pos, reportes, multimoneda" />
          <label for="cNotes">Notas internas (opcional)</label>
          <textarea id="cNotes" placeholder="Referencia, contacto, condiciones…"></textarea>
        </div>
        <div class="modal-foot">
          <button class="btn" data-action="close-modal">Cancelar</button>
          <button class="btn btn-primary" data-action="submit-create">Crear licencia</button>
        </div>
      </div>`);

    const sync = () => {
      const t = $('#cType').value;
      $('#cDurWrap').style.display = t === 'permanent' ? 'none' : '';
      $('#cDurLabel').textContent = t === 'trial' ? 'Días de prueba' : 'Duración (días)';
    };
    $('#cType').addEventListener('change', sync);
    sync();
  }

  async function submitCreate() {
    const type = $('#cType').value;
    const dur = Number($('#cDur') ? $('#cDur').value : 0) || null;
    const payload = {
      type,
      customerName: $('#cName').value.trim(),
      customerEmail: $('#cEmail').value.trim(),
      maxActivations: Number($('#cMax').value) || 1,
      features: $('#cFeatures').value.split(',').map((s) => s.trim()).filter(Boolean),
      notes: $('#cNotes').value.trim()
    };
    if (type === 'trial') payload.trialDays = dur;
    else if (type === 'subscription') payload.durationDays = dur;

    if ((type === 'subscription' || type === 'trial') && (!dur || dur <= 0)) {
      UI.toast('Indica una duración en días válida.', 'err');
      return;
    }

    const btn = document.querySelector('[data-action="submit-create"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Creando…'; }
    try {
      const r = await Api.createLicense(payload);
      await refreshData(true);
      showCreatedKey(r.license.key);
    } catch (err) {
      UI.toast(err.message, 'err');
      if (btn) { btn.disabled = false; btn.textContent = 'Crear licencia'; }
    }
  }

  function showCreatedKey(key) {
    UI.openModal(`
      <div class="modal">
        <div class="modal-head"><h2>Licencia creada</h2><button class="modal-close" data-action="close-modal">✕</button></div>
        <div class="modal-body">
          <p class="muted">Entrega esta clave al cliente. La activará en su equipo desde Nexus Core:</p>
          <div class="keybox">${UI.esc(key)}</div>
          <button class="btn btn-block" data-action="copy-key" data-key="${UI.esc(key)}">Copiar al portapapeles</button>
        </div>
        <div class="modal-foot">
          <button class="btn" data-action="close-modal">Listo</button>
          <button class="btn btn-primary" data-action="open-detail" data-key="${UI.esc(key)}">Ver detalle</button>
        </div>
      </div>`);
  }

  // ════════════ MODAL: DETALLE ════════════
  async function openDetail(key) {
    UI.openModal(`<div class="modal"><div class="modal-body">${UI.spinner('Cargando licencia…')}</div></div>`);
    let d;
    try { d = (await Api.getLicense(key)).license; }
    catch (err) { UI.closeModal(); UI.toast(err.message, 'err'); return; }

    const acts = Object.values(d.activations || {});
    const actsHtml = acts.length ? acts.map((a) => `
      <div class="act-item">
        <div>
          <div class="name">${UI.esc(a.machineName || 'Equipo sin nombre')}</div>
          <div class="meta">${UI.esc((a.hwidHash || '').slice(0, 20))}… · v${UI.esc(a.appVersion || '?')} · ${UI.fmtDate(a.activatedAt)}</div>
        </div>
        <button class="btn btn-danger btn-sm" data-action="revoke-act" data-key="${UI.esc(d.key)}" data-hwid="${UI.esc(a.hwidHash)}">Liberar</button>
      </div>`).join('') : `<p class="muted">Sin equipos activados todavía.</p>`;

    const venc = d.type === 'permanent'
      ? '∞ permanente'
      : (d.activatedAt ? `${UI.fmtDate(d.expiresAt)} · ${UI.relDays(d.daysRemaining)}` : 'al activar el cliente');

    UI.openModal(`
      <div class="modal wide">
        <div class="modal-head"><h2>Detalle de licencia</h2><button class="modal-close" data-action="close-modal">✕</button></div>
        <div class="modal-body">
          <div class="keybox">${UI.esc(d.key)}
            <div style="margin-top:8px;"><button class="btn btn-sm" data-action="copy-key" data-key="${UI.esc(d.key)}">Copiar</button></div>
          </div>
          <dl class="dl">
            <dt>Cliente</dt><dd class="cell-strong">${UI.esc(d.customerName || '—')}</dd>
            <dt>Email</dt><dd class="mono">${UI.esc(d.customerEmail || '—')}</dd>
            <dt>Tipo</dt><dd>${UI.typeBadge(d.type)}</dd>
            <dt>Estado</dt><dd>${UI.statusBadge(d)} ${d.statusReason ? `<span class="muted">· ${UI.esc(d.statusReason)}</span>` : ''}</dd>
            <dt>Creada</dt><dd class="mono">${UI.fmtDateTime(d.createdAt)}</dd>
            <dt>Activada</dt><dd class="mono">${d.activatedAt ? UI.fmtDateTime(d.activatedAt) : 'no activada'}</dd>
            <dt>Vence</dt><dd class="mono">${UI.esc(venc)}</dd>
            <dt>Equipos</dt><dd class="mono">${d.activationCount}/${d.maxActivations}</dd>
            <dt>Funciones</dt><dd>${(d.features || []).map(UI.esc).join(', ') || '—'}</dd>
            <dt>Notas</dt><dd>${UI.esc(d.notes || '—')}</dd>
          </dl>
          <div class="subhead">Equipos activados (${acts.length})</div>
          <div class="act-list">${actsHtml}</div>
        </div>
        <div class="modal-foot split">
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${d.status !== 'active' ? `<button class="btn btn-success btn-sm" data-action="set-status" data-key="${UI.esc(d.key)}" data-status="active">Reactivar</button>` : ''}
            ${d.status !== 'suspended' ? `<button class="btn btn-warning btn-sm" data-action="set-status" data-key="${UI.esc(d.key)}" data-status="suspended">Pausar</button>` : ''}
            ${d.status !== 'revoked' ? `<button class="btn btn-danger btn-sm" data-action="set-status" data-key="${UI.esc(d.key)}" data-status="revoked">Revocar</button>` : ''}
          </div>
          ${d.type !== 'permanent' ? `<button class="btn btn-sm" data-action="open-extend" data-key="${UI.esc(d.key)}">Sumar tiempo…</button>` : ''}
        </div>
      </div>`);
  }

  // ════════════ ACCIONES SOBRE LICENCIA ════════════
  function openStatusReason(key, status) {
    const labels = { suspended: 'Pausar licencia', revoked: 'Revocar licencia', active: 'Reactivar licencia' };
    const danger = status === 'revoked';
    UI.openModal(`
      <div class="modal">
        <div class="modal-head"><h2>${labels[status] || 'Cambiar estado'}</h2><button class="modal-close" data-action="close-modal">✕</button></div>
        <div class="modal-body">
          <p class="muted">Licencia <span class="mono">${UI.esc(key)}</span>.
          ${status === 'active' ? 'Volverá a validar en el próximo chequeo del cliente.' : 'El cliente se bloqueará en su próxima verificación en línea.'}</p>
          ${status !== 'active' ? `<label for="srReason">Motivo (opcional)</label><input id="srReason" placeholder="Falta de pago, fin de prueba…" />` : ''}
        </div>
        <div class="modal-foot">
          <button class="btn" data-action="close-modal">Cancelar</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-action="confirm-status" data-key="${UI.esc(key)}" data-status="${UI.esc(status)}">Confirmar</button>
        </div>
      </div>`);
  }

  async function confirmStatus(key, status) {
    const reason = $('#srReason') ? $('#srReason').value.trim() : '';
    const btn = document.querySelector('[data-action="confirm-status"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Aplicando…'; }
    try {
      await Api.setStatus(key, status, reason);
      UI.toast('Estado actualizado.');
      await refreshData(true);
      openDetail(key);
    } catch (err) {
      UI.toast(err.message, 'err');
      if (btn) { btn.disabled = false; btn.textContent = 'Confirmar'; }
    }
  }

  function openExtend(key) {
    UI.openModal(`
      <div class="modal">
        <div class="modal-head"><h2>Sumar tiempo</h2><button class="modal-close" data-action="close-modal">✕</button></div>
        <div class="modal-body">
          <p class="muted">Extiende el vencimiento de <span class="mono">${UI.esc(key)}</span>.
          Si ya venció, se renueva desde hoy; si está vigente, conserva el tiempo restante.</p>
          <label for="exDays">Días adicionales</label>
          <input id="exDays" class="mono" type="number" min="1" value="30" />
          <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
            ${[30, 90, 180, 365].map((n) => `<button class="btn btn-sm" data-action="ex-preset" data-days="${n}">+${n}</button>`).join('')}
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" data-action="close-modal">Cancelar</button>
          <button class="btn btn-primary" data-action="confirm-extend" data-key="${UI.esc(key)}">Sumar tiempo</button>
        </div>
      </div>`);
  }

  async function confirmExtend(key) {
    const n = Number($('#exDays').value) || 0;
    if (n <= 0) { UI.toast('Indica un número de días válido.', 'err'); return; }
    const btn = document.querySelector('[data-action="confirm-extend"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Aplicando…'; }
    try {
      await Api.extend(key, n);
      UI.toast(`Licencia extendida ${n} día(s).`);
      await refreshData(true);
      openDetail(key);
    } catch (err) {
      UI.toast(err.message, 'err');
      if (btn) { btn.disabled = false; btn.textContent = 'Sumar tiempo'; }
    }
  }

  function openRevokeAct(key, hwid) {
    UI.openModal(`
      <div class="modal">
        <div class="modal-head"><h2>Liberar equipo</h2><button class="modal-close" data-action="close-modal">✕</button></div>
        <div class="modal-body">
          <p class="muted">El equipo dejará de estar activado y deberá volver a activar la licencia
          <span class="mono">${UI.esc(key)}</span>. Útil al cambiar de máquina.</p>
        </div>
        <div class="modal-foot">
          <button class="btn" data-action="close-modal">Cancelar</button>
          <button class="btn btn-danger" data-action="confirm-revoke-act" data-key="${UI.esc(key)}" data-hwid="${UI.esc(hwid)}">Liberar equipo</button>
        </div>
      </div>`);
  }

  async function confirmRevokeAct(key, hwid) {
    const btn = document.querySelector('[data-action="confirm-revoke-act"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Liberando…'; }
    try {
      await Api.revokeActivation(key, hwid);
      UI.toast('Equipo liberado.');
      await refreshData(true);
      openDetail(key);
    } catch (err) {
      UI.toast(err.message, 'err');
      if (btn) { btn.disabled = false; btn.textContent = 'Liberar equipo'; }
    }
  }

  // ════════════ SIDEBAR (móvil) ════════════
  function openSidebar() { $('#sidebar').classList.add('open'); addBackdrop(); }
  function closeSidebar() {
    $('#sidebar').classList.remove('open');
    const b = document.querySelector('.sidebar-backdrop');
    if (b) b.remove();
  }
  function addBackdrop() {
    if (document.querySelector('.sidebar-backdrop')) return;
    const b = document.createElement('div');
    b.className = 'sidebar-backdrop';
    b.addEventListener('click', closeSidebar);
    document.body.appendChild(b);
  }

  // ════════════ DISPATCHER GLOBAL ════════════
  const ACTIONS = {
    'nav': (el) => { location.hash = '#/' + el.getAttribute('data-route'); },
    'refresh': () => refreshData(false),
    'reload-server': () => renderServidor(),
    'open-create': (el) => openCreate(el.getAttribute('data-preset')),
    'submit-create': () => submitCreate(),
    'open-detail': (el) => openDetail(el.getAttribute('data-key')),
    'open-client': (el) => openClient(el.getAttribute('data-client')),
    'copy-key': (el) => UI.copy(el.getAttribute('data-key')),
    'close-modal': () => UI.closeModal(),
    'set-status': (el) => openStatusReason(el.getAttribute('data-key'), el.getAttribute('data-status')),
    'confirm-status': (el) => confirmStatus(el.getAttribute('data-key'), el.getAttribute('data-status')),
    'open-extend': (el) => openExtend(el.getAttribute('data-key')),
    'ex-preset': (el) => { const i = $('#exDays'); if (i) i.value = el.getAttribute('data-days'); },
    'confirm-extend': (el) => confirmExtend(el.getAttribute('data-key')),
    'revoke-act': (el) => openRevokeAct(el.getAttribute('data-key'), el.getAttribute('data-hwid')),
    'confirm-revoke-act': (el) => confirmRevokeAct(el.getAttribute('data-key'), el.getAttribute('data-hwid'))
  };

  function bindGlobal() {
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const action = el.getAttribute('data-action');
      if (ACTIONS[action]) { e.preventDefault(); ACTIONS[action](el); }
    });

    document.querySelectorAll('.nav-item').forEach((el) => {
      el.addEventListener('click', () => { location.hash = '#/' + el.getAttribute('data-route'); });
    });

    $('#loginForm').addEventListener('submit', doLogin);
    $('#logoutBtn').addEventListener('click', doLogout);
    $('#newLicenseBtn').addEventListener('click', () => openCreate());
    $('#menuToggle').addEventListener('click', openSidebar);

    window.addEventListener('hashchange', renderRoute);
    window.addEventListener('nx:unauthorized', () => {
      state.loaded = false;
      UI.closeModal();
      showLogin();
      UI.toast('Tu sesión expiró. Inicia sesión de nuevo.', 'info');
    });
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
