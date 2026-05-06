'use strict';

document.addEventListener('DOMContentLoaded', function () {
  var sidebarHost = document.getElementById('sidebar-host');
  var navbarHost = document.getElementById('navbar-host');
  var view = document.getElementById('view');

  function hasSession() {
    return !!(
      window.NexusAuth &&
      typeof window.NexusAuth.getAccessToken === 'function' &&
      window.NexusAuth.getAccessToken()
    );
  }

  function mountChrome() {
    if (!hasSession()) {
      if (sidebarHost) sidebarHost.innerHTML = '';
      if (navbarHost) navbarHost.innerHTML = '';
      return;
    }
    var route =
      window.NexusRouter && typeof window.NexusRouter.getRouteFromHash === 'function'
        ? window.NexusRouter.getRouteFromHash()
        : null;
    if (route && route.hash === 'login') {
      if (sidebarHost) sidebarHost.innerHTML = '';
      if (navbarHost) navbarHost.innerHTML = '';
      return;
    }
    if (sidebarHost && window.NexusComponents && window.NexusComponents.renderSidebar) {
      sidebarHost.innerHTML = '';
      window.NexusComponents.renderSidebar(sidebarHost);
    }
    if (navbarHost && window.NexusComponents && window.NexusComponents.renderNavbar) {
      navbarHost.innerHTML = '';
      window.NexusComponents.renderNavbar(navbarHost);
    }
    if (window.NexusRouter && typeof window.NexusRouter.syncSidebarActive === 'function') {
      window.NexusRouter.syncSidebarActive(window.NexusRouter.getRouteFromHash());
    }
  }

  function startRouter() {
    if (window.NexusRouter && view) {
      window.NexusRouter.start(view);
    }
  }

  // ── NUEVO: verificar token antes de montar UI ──────────────
  function initSession() {
    if (!hasSession()) {
      // Sin token local → ir directo al login sin verificar
      mountChrome();
      startRouter();
      if (window.NexusRouter) window.location.hash = '#/login';
      return;
    }

    // Hay token en localStorage → verificar con el servidor
    // antes de mostrar cualquier parte de la UI autenticada
    window.NexusAuth.verifySession().then(function (valid) {
      if (!valid) {
        // Token expirado o inválido → clearSession ya fue llamado en verifySession
        mountChrome();
        startRouter();
        window.location.hash = '#/login';
      } else {
        // Token válido → montar UI normal
        mountChrome();
        startRouter();
      }
    });
  }

  initSession();
  // ── FIN NUEVO ──────────────────────────────────────────────

  window.addEventListener('nexus:session', function () {
    mountChrome();
  });

  window.addEventListener('nexus:route', function () {
    mountChrome();
    if (window.NexusNumberStepper && view) {
      window.NexusNumberStepper.init(view);
    }
  });
});
