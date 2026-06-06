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
    const found = byHash[part];
    if (!found) {
      // Normalise unknown hash to #/dashboard to avoid showing a blank route
      if (window.location.hash !== '#/dashboard') window.location.hash = '#/dashboard';
      return byHash.dashboard || routes[1];
    }
    return found;
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

  // Navigation concurrency guard: drop (or queue) a second navigate() while one is running.
  let _navInProgress = false;
  let _navPending = null; // { viewEl, options }

  async function navigate(viewEl, options) {
    if (_navInProgress) {
      // Remember the latest pending call and let the running one pick it up when done.
      _navPending = { viewEl, options };
      return;
    }
    _navInProgress = true;
    try {
      return await _navigateImpl(viewEl, options);
    } finally {
      _navInProgress = false;
      if (_navPending) {
        const p = _navPending;
        _navPending = null;
        // Use setTimeout(0) so the current call-stack fully unwinds first.
        setTimeout(() => navigate(p.viewEl, p.options), 0);
      }
    }
  }

  async function _navigateImpl(viewEl, options) {
    let route = options && options.route ? options.route : getRouteFromHash();
    route = guardRoute(route);
    const skipTransition = options && options.skipTransition;

    if (!viewEl) return;

    if (!skipTransition) {
      viewEl.classList.add('is-transitioning');
      viewEl.classList.remove('is-visible');
      await nextFrame();
    }

    // Bug-25/26: call any registered page-cleanup hook before replacing the DOM.
    // Pages register it as host._pageDestroy (or legacy aliases _posDestroy / _ventasDestroy).
    if (viewEl._pageDestroy) { try { viewEl._pageDestroy(); } catch (_e) {} delete viewEl._pageDestroy; }
    if (viewEl._posDestroy)   { try { viewEl._posDestroy();   } catch (_e) {} delete viewEl._posDestroy; }
    if (viewEl._ventasDestroy){ try { viewEl._ventasDestroy();} catch (_e) {} delete viewEl._ventasDestroy; }

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
    if (viewEl._posDestroy) {
      try {
        viewEl._posDestroy();
      } catch (_e) {}
      delete viewEl._posDestroy;
    }
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

    // Tras repintado / fin de transición: foco ventana Electron en login (evita race con el DOM)
    if (route && route.hash === 'login') {
      requestAnimationFrame(() => {
        try {
          if (window.nexusCore && window.nexusCore.focusWindow) {
            Promise.resolve(window.nexusCore.focusWindow()).catch(() => {});
          } else if (window.electronAPI) {
            window.electronAPI.invoke('window:steal-focus').catch(() => {});
          }
        } catch (_e) {}
      });
    }

    document.title = 'Nexus Core — ' + route.title;
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
    if (!window.__nexusLoginMountedHook) {
      window.__nexusLoginMountedHook = true;
      window.addEventListener('nexus:login-mounted', (ev) => {
        requestAnimationFrame(() => {
          const host = ev.detail && ev.detail.host;
          const userInput = host
            ? host.querySelector('#login-user')
            : document.querySelector('#login-user');
          if (!userInput) return;
          let attempts = 0;
          const tryFocus = () => {
            attempts += 1;
            if (document.hasFocus()) {
              userInput.focus();
            } else if (attempts < 10) {
              setTimeout(tryFocus, 100);
            }
          };
          tryFocus();
        });
      });
    }

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
        // Always call navigate() explicitly so we don't depend on hashchange firing
        // in the right order (it may already be #/login and hashchange won't fire again).
        window.location.hash = '#/login';
        await navigate(viewEl, { route: byHash.login, skipTransition: false });
        return;
      }
      if (getRouteFromHash().hash === 'login') {
        window.location.hash = '#/dashboard';
        await navigate(viewEl, { route: byHash.dashboard, skipTransition: false });
      }
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
