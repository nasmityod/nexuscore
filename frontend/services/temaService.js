'use strict';

// ── Servicio de tema visual ────────────────────────────────────────────────
// Gestiona la preferencia dark / light del usuario con persistencia en
// localStorage (clave: nexus_theme). El cambio es inmediato y reactivo:
// se aplica sobre document.documentElement sin recargar la página.

var TemaService = (function () {
  var STORAGE_KEY = 'nexus_theme';

  function getTema() {
    try { return localStorage.getItem(STORAGE_KEY) || 'dark'; } catch (e) { return 'dark'; }
  }

  function syncElectronTheme(tema) {
    if (!window.nexusCore || typeof window.nexusCore.saveThemePreference !== 'function') return;
    window.nexusCore.saveThemePreference(tema).catch(function () {});
  }

  function setTema(tema) {
    if (tema !== 'dark' && tema !== 'light') return;
    try { localStorage.setItem(STORAGE_KEY, tema); } catch (e) {}
    document.documentElement.setAttribute('data-theme', tema);

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = tema === 'light' ? '#f4f6fa' : '#0a0e1a';

    syncElectronTheme(tema);

    window.dispatchEvent(new CustomEvent('nexus:themechange', { detail: { tema: tema } }));
  }

  function toggleTema() {
    setTema(getTema() === 'dark' ? 'light' : 'dark');
  }

  return {
    getTema: getTema,
    setTema: setTema,
    toggleTema: toggleTema,
    esDark: function () { return getTema() === 'dark'; },
    esLight: function () { return getTema() === 'light'; }
  };
})();

window.TemaService = TemaService;

// Sincronizar localStorage → userData sin disparar nexus:themechange al arranque
(function syncThemeToElectronOnLoad() {
  try {
    if (window.nexusCore && typeof window.nexusCore.saveThemePreference === 'function') {
      window.nexusCore.saveThemePreference(TemaService.getTema()).catch(function () {});
    }
  } catch (e) {}
})();
