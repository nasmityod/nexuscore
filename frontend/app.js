'use strict';

document.addEventListener('DOMContentLoaded', function () {
  var sidebarHost = document.getElementById('sidebar-host');
  var navbarHost = document.getElementById('navbar-host');
  var view = document.getElementById('view');

  // Bandera para no destruir y recrear el chrome en cada cambio de ruta
  var chromeYaMontado = false;

  function hasSession() {
    return !!(
      window.NexusAuth &&
      typeof window.NexusAuth.getAccessToken === 'function' &&
      window.NexusAuth.getAccessToken()
    );
  }

  function updateChromePerRoute() {
    // Actualizar sidebar activo sin recrear el chrome completo
    if (window.NexusRouter && typeof window.NexusRouter.syncSidebarActive === 'function') {
      window.NexusRouter.syncSidebarActive(window.NexusRouter.getRouteFromHash());
    }
    // Sincronizar navbar con localStorage (tasa puede haber cambiado desde otro módulo)
    if (typeof window.NexusComponents?.syncNavbarRatesInputsFromLocalStorage === 'function') {
      window.NexusComponents.syncNavbarRatesInputsFromLocalStorage();
    }
  }

  function mountChrome() {
    if (!hasSession()) {
      if (sidebarHost) sidebarHost.innerHTML = '';
      if (navbarHost) navbarHost.innerHTML = '';
      chromeYaMontado = false;
      return;
    }
    var route =
      window.NexusRouter && typeof window.NexusRouter.getRouteFromHash === 'function'
        ? window.NexusRouter.getRouteFromHash()
        : null;
    if (route && route.hash === 'login') {
      if (sidebarHost) sidebarHost.innerHTML = '';
      if (navbarHost) navbarHost.innerHTML = '';
      chromeYaMontado = false;
      return;
    }

    if (chromeYaMontado) {
      // Chrome ya existe: solo sincronizar estado por ruta, sin destruir/recrear
      updateChromePerRoute();
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

    chromeYaMontado = true;

    // Hidratar tasas desde servidor una sola vez al montar el chrome inicial
    if (typeof window.NexusComponents?.hydrateTasasDesdeServidorSilent === 'function') {
      window.NexusComponents.hydrateTasasDesdeServidorSilent().then(function (r) {
        if (!r) {
          // Hydrate falló o devolvió tasas inválidas — advertencia no bloqueante
          if (window.NexusComponents && window.NexusComponents.showToast) {
            window.NexusComponents.showToast(
              'No se pudieron actualizar las tasas de cambio. Verifica la conexión con el servidor.',
              'warning'
            );
          }
        }
      }).catch(function () {});
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
    // Al cambiar sesión resetear la bandera para que el nuevo chrome se monte limpio
    chromeYaMontado = false;
    mountChrome();
  });

  window.addEventListener('nexus:route', function () {
    mountChrome();
    if (window.NexusNumberStepper && view) {
      window.NexusNumberStepper.init(view);
    }
  });
});
