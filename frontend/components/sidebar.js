'use strict';

(function () {
  const NS = 'http://www.w3.org/2000/svg';

  function svg(pathD, label) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('class', 'sidebar-nav-icon');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', pathD);
    s.appendChild(p);
    return s;
  }

  function brandLogoSvg() {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('class', 'sidebar-brand-logo');
    s.setAttribute('viewBox', '0 0 48 48');
    s.setAttribute('fill', 'none');
    s.setAttribute('aria-hidden', 'true');

    function line(x1, y1, x2, y2, w) {
      const el = document.createElementNS(NS, 'line');
      el.setAttribute('x1', x1);
      el.setAttribute('y1', y1);
      el.setAttribute('x2', x2);
      el.setAttribute('y2', y2);
      el.setAttribute('stroke', 'currentColor');
      el.setAttribute('stroke-width', w);
      el.setAttribute('stroke-linecap', 'round');
      s.appendChild(el);
    }

    const poly = document.createElementNS(NS, 'polygon');
    poly.setAttribute('points', '24,6 38,14 38,30 24,38 10,30 10,14');
    poly.setAttribute('stroke', 'currentColor');
    poly.setAttribute('stroke-width', '2.5');
    poly.setAttribute('stroke-linejoin', 'round');
    poly.setAttribute('fill', 'none');
    s.appendChild(poly);

    line('38', '14', '46', '8', '2.5');
    line('24', '38', '24', '46', '2.5');
    line('10', '14', '2', '8', '2.5');

    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('cx', '24');
    circle.setAttribute('cy', '22');
    circle.setAttribute('r', '3');
    circle.setAttribute('fill', 'currentColor');
    s.appendChild(circle);

    line('24', '14', '24', '19', '1.5');
    return s;
  }

  const ICONS = {
    dashboard: svg('M4 6h6v8H4zM14 6h6v5h-6zM14 15h6v3h-6zM4 18h6v-2H4z'),
    pos: svg('M3 5h18v14H3zM7 9h6M7 13h4'),
    inventario: svg('M4 7h16v12H4zM8 3h8v4H8z'),
    ventas: svg('M7 7h14M7 12h14M7 17h10M4 7h1M4 12h1M4 17h1'),
    clientes: svg('M12 11a4 4 0 100-8 4 4 0 000 8zM4 21v-2a6 6 0 0112 0v2'),
    cartera:  svg('M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4'),
    proveedores: svg('M3 21h18M5 21V7l8-4 8 4v14M9 21v-6h6v6'),
    caja: svg('M4 8h16v10H4zM8 8V6a4 4 0 118 0v2'),
    compras: svg('M6 2L3 6v14h18V6l-3-4zM3 6h18M12 11v6m-3-3h6'),
    reportes: svg('M4 19V5M4 19h16M8 17V9m4 8V7m4 10v-4'),
    configuracion: svg('M12 15a3 3 0 100-6 3 3 0 000 6zM2 12h3m17 0h-3M12 2v3m0 17v-3'),
    usuarios:      svg('M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75'),
    cashea:        svg('M2 8h20v12H2zM6 12h4M14 12h4M6 16h2M14 16h2')
  };

  function renderSidebar(container) {
    if (!container) return;

    const routes = (window.NexusRouter && window.NexusRouter.routes) || [];
    const aside = document.createElement('aside');
    aside.className = 'sidebar';
    aside.setAttribute('aria-label', 'Navegación principal');

    const brandContainer = document.createElement('div');
    brandContainer.className = 'sidebar-brand';

    const brandLogo = brandLogoSvg();

    const brandTextBlock = document.createElement('div');
    brandTextBlock.className = 'sidebar-brand-text';

    const brandTitle = document.createElement('span');
    brandTitle.className = 'sidebar-brand-title';
    brandTitle.textContent = 'Nexus Core';

    const brandSub = document.createElement('span');
    brandSub.className = 'sidebar-brand-sub';
    brandSub.textContent = 'ERP · POS';

    brandTextBlock.appendChild(brandTitle);
    brandTextBlock.appendChild(brandSub);
    brandContainer.appendChild(brandLogo);
    brandContainer.appendChild(brandTextBlock);
    aside.appendChild(brandContainer);

    const nav = document.createElement('nav');
    const ul = document.createElement('ul');
    ul.className = 'sidebar-nav';

    // Agrupación visual por sección. Cualquier ruta no listada se incluye al
    // final de su grupo o en "Otros" si no aparece en GROUPS.
    const GROUPS = [
      { label: 'Operación',    ids: ['dashboard', 'pos', 'caja'] },
      { label: 'Catálogo',     ids: ['inventario', 'compras', 'proveedores'] },
      { label: 'Comercial',    ids: ['ventas', 'clientes', 'cartera', 'cashea'] },
      { label: 'Análisis', ids: ['reportes'] },
      { label: 'Sistema',      ids: ['usuarios', 'configuracion'] }
    ];

    const ROUTE_PERM = {
      dashboard: 'dashboard',
      pos: 'pos_sales',
      inventario: 'inventario_ver',
      ventas: 'ventas_ver',
      clientes: 'clientes_ver',
      cartera:  'clientes_ver',
      proveedores: 'proveedores_all',
      caja: 'caja_operar',
      compras: 'compras_all',
      reportes: 'reportes_all',
      configuracion: 'config_read',
      usuarios:      'usuarios_all',
      cashea:        'pos_sales'
    };

    function routeAllowed(routeId) {
      if (!window.NexusAuth || typeof window.NexusAuth.getAccessToken !== 'function') return true;
      if (!window.NexusAuth.getAccessToken()) return true;
      if (typeof window.NexusAuth.can !== 'function') return true;
      var k = ROUTE_PERM[routeId];
      if (!k) return true;
      return window.NexusAuth.can(k);
    }

    function appendItem(r) {
      const li = document.createElement('li');
      li.className = 'sidebar-nav-item';
      const a = document.createElement('a');
      a.className = 'sidebar-nav-link';
      a.href = '#/' + r.hash;
      const ic = ICONS[r.id] || ICONS.dashboard;
      a.appendChild(ic.cloneNode(true));
      const span = document.createElement('span');
      if (
        r.id === 'cashea' &&
        window.NexusCasheaBrand &&
        typeof window.NexusCasheaBrand.labelHtml === 'function'
      ) {
        span.innerHTML = window.NexusCasheaBrand.labelHtml(r.title, 16, 16);
      } else {
        span.textContent = r.title;
      }
      a.appendChild(span);
      li.appendChild(a);
      ul.appendChild(li);
    }

    function appendGroupLabel(text) {
      const li = document.createElement('li');
      li.className = 'sidebar-nav-group-label';
      li.setAttribute('aria-hidden', 'true');
      li.textContent = text;
      ul.appendChild(li);
    }

    const placed = new Set();
    GROUPS.forEach((g) => {
      const items = g.ids
        .map((id) => routes.find((r) => r.id === id))
        .filter((r) => r && r.hash !== 'login' && routeAllowed(r.id));
      if (!items.length) return;
      appendGroupLabel(g.label);
      items.forEach((r) => {
        appendItem(r);
        placed.add(r.id);
      });
    });

    const leftovers = routes.filter(
      (r) => r.hash !== 'login' && !placed.has(r.id) && routeAllowed(r.id)
    );
    if (leftovers.length) {
      appendGroupLabel('Otros');
      leftovers.forEach(appendItem);
    }

    nav.appendChild(ul);
    aside.appendChild(nav);

    const foot = document.createElement('div');
    foot.className = 'sidebar-footer';
    if (window.nexusCore) {
      foot.textContent = 'Nexus Core v' + (window._APP_VERSION || '1.0.0') +
        ' · Electron ' + window.nexusCore.versions.electron;
      // Cargar versión real de forma asíncrona
      if (window.nexusCore.getVersion) {
        window.nexusCore.getVersion().then(function (v) {
          if (v) { window._APP_VERSION = v; foot.textContent = 'Nexus Core v' + v + ' · Electron ' + window.nexusCore.versions.electron; }
        }).catch(function () {});
      }
    } else {
      foot.textContent = 'Nexus Core · Modo Navegador';
    }
    aside.appendChild(foot);

    container.appendChild(aside);
  }

  window.NexusComponents = window.NexusComponents || {};
  window.NexusComponents.renderSidebar = renderSidebar;
})();
