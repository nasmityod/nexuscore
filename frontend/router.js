'use strict';

/**
 * Router SPA por hash (#/ruta) — sin recarga completa; compatible con Electron file://
 */
window.NexusRouter = (function () {
  const routes = [
    { id: 'login', hash: 'login', title: 'Acceso', html: 'pages/login/login.html' },
    { id: 'dashboard', hash: 'dashboard', title: 'Dashboard', html: 'pages/dashboard/dashboard.html' },
    { id: 'pos', hash: 'pos', title: 'Punto de venta', html: 'pages/pos/pos.html' },
    { id: 'inventario', hash: 'inventario', title: 'Inventario', html: 'pages/inventario/inventario.html' },
    { id: 'ventas', hash: 'ventas', title: 'Ventas', html: 'pages/ventas/ventas.html' },
    { id: 'clientes', hash: 'clientes', title: 'Clientes', html: 'pages/clientes/clientes.html' },
    { id: 'cartera', hash: 'cartera', title: 'Cartera / Cobrar', html: 'pages/cartera/cartera.html' },
    { id: 'proveedores', hash: 'proveedores', title: 'Proveedores', html: 'pages/proveedores/proveedores.html' },
    { id: 'caja', hash: 'caja', title: 'Caja', html: 'pages/caja/caja.html' },
    { id: 'compras', hash: 'compras', title: 'Compras', html: 'pages/compras/compras.html' },
    { id: 'reportes', hash: 'reportes', title: 'Reportes y Análisis', html: 'pages/reportes/reportes.html' },
    { id: 'configuracion', hash: 'configuracion', title: 'Configuración', html: 'pages/configuracion/configuracion.html' },
    { id: 'usuarios', hash: 'usuarios', title: 'Usuarios', html: 'pages/usuarios/usuarios.html' },
    { id: 'cashea', hash: 'cashea', title: 'Cashea', html: 'pages/cashea/cashea.html' }
  ];

  const byHash = {};
  routes.forEach((r) => {
    byHash[r.hash] = r;
  });

  /** Permiso mínimo por vista (alineado con sidebar). */
  const ROUTE_PERM = {
    dashboard: 'dashboard',
    pos: 'pos_sales',
    inventario: 'inventario_ver',
    ventas: 'ventas_ver',
    clientes: 'clientes_ver',
    cartera: 'clientes_ver',
    proveedores: 'proveedores_all',
    caja: 'caja_operar',
    compras: 'compras_all',
    reportes: 'reportes_all',
    configuracion: 'config_read',
    usuarios: 'usuarios_all',
    cashea:   'pos_sales'
  };

  function getRouteFromHash() {
    let h = (window.location.hash || '').replace(/^#/, '');
    if (h.startsWith('/')) h = h.slice(1);
    const part = h.split('/')[0];
    if (!part || part === '') return byHash.dashboard || routes[1];
    return byHash[part] || byHash.dashboard || routes[1];
  }

  const pageMounts = {
    login: () => window.LoginPage,
    dashboard: () => window.DashboardPage,
    pos: () => window.PosPage,
    inventario: () => window.InventarioPage,
    ventas: () => window.VentasPage,
    clientes: () => window.ClientesPage,
    cartera:  () => window.CarteraPage,
    proveedores: () => window.ProveedoresPage,
    caja: () => window.CajaPage,
    compras: () => window.ComprasPage,
    reportes: () => window.ReportesPage,
    configuracion: () => window.ConfiguracionPage,
    usuarios:      () => window.UsuariosPage,
    cashea:        () => window.CasheaPage
  };

  function dispatchPartialScripts(container) {
    const scripts = container.querySelectorAll('script[data-page-inline]');
    scripts.forEach((old) => {
      const s = document.createElement('script');
      [...old.attributes].forEach((a) => {
        if (a.name !== 'data-page-inline') s.setAttribute(a.name, a.value);
      });
      s.textContent = old.textContent;
      old.parentNode.replaceChild(s, old);
    });
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  function updateGuestShell(route) {
    const root = document.getElementById('layout-root');
    if (!root) return;
    const isGuest = !tokenPresent() && route && route.hash === 'login';
    root.classList.toggle('layout-guest', isGuest);
  }

  function tokenPresent() {
    return !!(window.NexusAuth && typeof window.NexusAuth.getAccessToken === 'function' && window.NexusAuth.getAccessToken());
  }

  function guardRoute(route) {
    const pub = route.hash === 'login';
    if (!tokenPresent() && !pub) {
      if (window.location.hash !== '#/login') window.location.hash = '#/login';
      return byHash.login;
    }
    if (tokenPresent() && pub) {
      if (window.location.hash !== '#/dashboard') window.location.hash = '#/dashboard';
      return byHash.dashboard;
    }
    if (tokenPresent() && route.hash !== 'login') {
      if (window.NexusAuth && typeof window.NexusAuth.can === 'function') {
        const k = ROUTE_PERM[route.id];
        if (k && !window.NexusAuth.can(k)) {
          const fb = window.NexusAuth.can('pos_sales') ? byHash.pos : byHash.dashboard;
          const target = '#/' + fb.hash;
          if (window.location.hash !== target) window.location.hash = target;
          return fb;
        }
      }
    }
    return route;
  }

  async function navigate(viewEl, options) {
    let route = options && options.route ? options.route : getRouteFromHash();
    route = guardRoute(route);
    const skipTransition = options && options.skipTransition;

    if (!viewEl) return;

    if (!skipTransition) {
      viewEl.classList.add('is-transitioning');
      viewEl.classList.remove('is-visible');
      await nextFrame();
    }

    const htmlPath = route.html;
    const res = await fetch(htmlPath, { cache: 'no-cache' });
    if (!res.ok) {
      viewEl.innerHTML =
        '<section class="page-content card"><h2>Error</h2><p>No se pudo cargar la vista.</p></section>';
      viewEl.classList.remove('is-transitioning');
      viewEl.classList.add('is-visible');
      return route;
    }

    const text = await res.text();
    viewEl.innerHTML = text;
    dispatchPartialScripts(viewEl);
    const factory = pageMounts[route.id];
    const api = factory && factory();
    if (api && typeof api.mount === 'function') {
      try {
        api.mount(viewEl, route);
      } catch (e) {
        console.error('NexusRouter mount', route.id, e);
      }
    }

    if (!skipTransition) {
      await nextFrame();
      viewEl.classList.remove('is-transitioning');
      viewEl.classList.add('is-visible');
    }

    document.title = 'Nexus-Core — ' + route.title;
    window.dispatchEvent(new CustomEvent('nexus:route', { detail: { route } }));
    updateGuestShell(route);

    return route;
  }

  function syncSidebarActive(route) {
    document.querySelectorAll('.sidebar-nav-link').forEach((a) => {
      const href = a.getAttribute('href') || '';
      const match = href.replace(/^#\/?/, '').split('/')[0] || 'dashboard';
      const isActive = match === route.hash;
      a.classList.toggle('is-active', isActive);
      if (isActive) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  async function start(viewEl) {
    if (!window.location.hash || window.location.hash === '#') {
      window.location.hash = tokenPresent() ? '#/dashboard' : '#/login';
    }
    let initial = getRouteFromHash();
    initial = guardRoute(initial);
    await navigate(viewEl, { route: initial, skipTransition: true });
    viewEl.classList.remove('is-transitioning');
    viewEl.classList.add('is-visible');
    syncSidebarActive(getRouteFromHash());

    window.addEventListener('hashchange', async () => {
      const next = guardRoute(getRouteFromHash());
      await navigate(viewEl, { route: next });
      syncSidebarActive(next);
    });

    window.addEventListener('nexus:session', async () => {
      if (!tokenPresent()) {
        if (getRouteFromHash().hash !== 'login') {
          window.location.hash = '#/login';
        } else {
          await navigate(viewEl, { route: byHash.login, skipTransition: true });
        }
        return;
      }
      if (getRouteFromHash().hash === 'login') window.location.hash = '#/dashboard';
    });
  }

  return {
    routes,
    getRouteFromHash,
    navigate,
    start,
    syncSidebarActive
  };
})();
