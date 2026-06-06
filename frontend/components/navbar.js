'use strict';

(function () {
  const STORAGE_BCV = 'nexus_tasa_bcv';
  // Referencia al handler de nexus:session activo para poder removerlo al remontar navbar
  let _sessionHandler = null;
  const STORAGE_USD = 'nexus_tasa_usd';
  const LEGACY_STORAGE_USD = 'nexus_tasa_paralela';

  function round4(n) {
    return Math.round(Number(n) * 10000) / 10000;
  }

  function loadRates() {
    let rawUsd = localStorage.getItem(STORAGE_USD);
    if (rawUsd === null || rawUsd === '') {
      const leg = localStorage.getItem(LEGACY_STORAGE_USD);
      if (leg !== null && leg !== '') {
        rawUsd = leg;
        localStorage.setItem(STORAGE_USD, leg);
        localStorage.removeItem(LEGACY_STORAGE_USD);
      }
    }
    const rawBcv = localStorage.getItem(STORAGE_BCV);
    const bcv = parseFloat(rawBcv || '0');
    const usd = parseFloat(rawUsd || '0');
    return {
      bcv: !Number.isNaN(bcv) && bcv > 0 ? round4(bcv) : 0,
      usd: !Number.isNaN(usd) && usd > 0 ? round4(usd) : 0
    };
  }

  /** @param {boolean} silent si true solo persiste localStorage (sin disparar nexus:tasas) */
  function saveRates(bcv, usd, silent = false) {
    const b = round4(bcv);
    const u = round4(usd);
    localStorage.setItem(STORAGE_BCV, String(b));
    localStorage.setItem(STORAGE_USD, String(u));
    if (!silent) {
      window.dispatchEvent(
        new CustomEvent('nexus:tasas', { detail: { tasa_bcv: b, tasa_usd: u } })
      );
    }
    return { bcv: b, usd: u };
  }

  function formatClock(d) {
    return d.toLocaleTimeString('es-VE', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function formatDate(d) {
    return d.toLocaleDateString('es-VE', {
      weekday: 'short',
      day: 'numeric',
      month: 'short'
    });
  }

  function renderNavbar(container) {
    if (!container) return;

    const rates = loadRates();
    const header = document.createElement('header');
    header.className = 'app-header';

    const left = document.createElement('div');
    left.className = 'app-header-block';
    left.innerHTML =
      '<div><span class="app-header-label">Sistema</span><div style="font-weight:600">Panel operativo</div></div>';

    const ratesWrap = document.createElement('div');
    ratesWrap.className = 'app-header-block';
    ratesWrap.innerHTML = '<span class="app-header-label">Tasas del día (Bs por USD)</span>';

    const tasasInner = document.createElement('div');
    tasasInner.style.display = 'flex';
    tasasInner.style.gap = '1rem';
    tasasInner.style.flexWrap = 'wrap';

    // BCV: solo visualización. La tasa se actualiza automáticamente desde Configuración → Tasas.
    const bcvGroup = document.createElement('div');
    bcvGroup.className = 'tasa-group';
    const bcvBadge = document.createElement('span');
    bcvBadge.className = 'tasa-badge';
    bcvBadge.textContent = 'USD BCV';
    const bcvWrap = document.createElement('div');
    bcvWrap.className = 'tasa-input-wrap';
    const bcvInp = document.createElement('input');
    bcvInp.type = 'text';
    bcvInp.className = 'tasa-input';
    bcvInp.id = 'navbar-tasa-bcv';
    bcvInp.setAttribute('inputmode', 'decimal');
    bcvInp.setAttribute('aria-label', 'Tasa BCV oficial (Bs por USD)');
    bcvInp.setAttribute('title', 'Tasa BCV oficial — se actualiza automáticamente. Cambia en Configuración → Tasas.');
    bcvInp.value = rates.bcv > 0 ? rates.bcv.toFixed(4) : '—';
    bcvInp.readOnly = true;
    bcvWrap.appendChild(bcvInp);
    bcvGroup.appendChild(bcvBadge);
    bcvGroup.appendChild(bcvWrap);

    tasasInner.appendChild(bcvGroup);
    ratesWrap.appendChild(tasasInner);

    const right = document.createElement('div');
    right.className = 'header-meta';

    const clockBox = document.createElement('div');
    clockBox.style.textAlign = 'right';
    const clockEl = document.createElement('div');
    clockEl.className = 'header-clock';
    const dateEl = document.createElement('div');
    dateEl.style.fontSize = '0.75rem';
    dateEl.style.color = 'var(--text-muted)';
    clockBox.appendChild(clockEl);
    clockBox.appendChild(dateEl);

    const tick = () => {
      const now = new Date();
      clockEl.textContent = formatClock(now);
      dateEl.textContent = formatDate(now);
    };
    tick();
    setInterval(tick, 1000);

    const userBox = document.createElement('div');
    userBox.className = 'header-user-block';

    const userCol = document.createElement('div');
    userCol.className = 'header-user';
    userCol.innerHTML =
      '<span class="header-user-name">Usuario</span><span class="header-user-role">…</span>';

    function applyUserHeader() {
      const u = window.NexusAuth && window.NexusAuth.getUser ? window.NexusAuth.getUser() : null;
      const nameEl = userCol.querySelector('.header-user-name');
      const roleEl = userCol.querySelector('.header-user-role');
      if (nameEl) {
        nameEl.textContent =
          u && u.nombre_completo ? u.nombre_completo : u && u.username ? u.username : 'Sesión';
      }
      if (roleEl) {
        roleEl.textContent =
          u && u.rol_nombre
            ? u.rol_nombre
            : u && u.rol
              ? u.rol
              : u && u.id
                ? 'Usuario #' + u.id
                : 'Sin iniciar sesión';
      }
      if (logoutBtn) {
        logoutBtn.style.visibility =
          window.NexusAuth && window.NexusAuth.getAccessToken && window.NexusAuth.getAccessToken()
            ? ''
            : 'hidden';
      }
    }

    const logoutBtn = document.createElement('button');
    logoutBtn.type = 'button';
    logoutBtn.className = 'btn-logout-header';
    logoutBtn.setAttribute('aria-label', 'Cerrar sesión');
    logoutBtn.textContent = 'Cerrar sesión';
    logoutBtn.addEventListener('click', () => {
      if (window.NexusAuth && typeof window.NexusAuth.logout === 'function') {
        void Promise.resolve(window.NexusAuth.logout()).then((cleared) => {
          if (cleared) {
            window.NexusComponents &&
              window.NexusComponents.showToast &&
              window.NexusComponents.showToast('Sesión cerrada. Otro usuario puede iniciar sesión.', 'success');
          }
        });
      }
    });

    userBox.appendChild(userCol);
    userBox.appendChild(logoutBtn);
    applyUserHeader();
    // Reemplazar handler previo para evitar acumulación de listeners en ciclos login/logout
    if (_sessionHandler) window.removeEventListener('nexus:session', _sessionHandler);
    _sessionHandler = applyUserHeader;
    window.addEventListener('nexus:session', applyUserHeader);

    const dbBox = document.createElement('div');
    dbBox.className = 'db-status';
    const dbDot = document.createElement('span');
    dbDot.className = 'db-status-dot is-pending';
    dbDot.title = 'Comprobando conexión…';
    const dbLbl = document.createElement('span');
    dbLbl.textContent = 'BD';
    dbBox.appendChild(dbDot);
    dbBox.appendChild(dbLbl);

    const DB_HEALTH_POLL_MS = 30000;

    async function pingDatabaseHealth() {
      const base = String(window.NEXUS_API_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
      const url = `${base}/health/db`;
      try {
        const res = await fetch(url, { method: 'GET', cache: 'no-store' });
        let body = null;
        try {
          body = await res.json();
        } catch (e) {
          body = null;
        }
        if (res.ok && body && body.ok === true && body.database) {
          dbDot.classList.remove('is-offline', 'is-pending');
          dbDot.title = `PostgreSQL conectado (${body.database})`;
          return;
        }
        dbDot.classList.add('is-offline');
        dbDot.classList.remove('is-pending');
        dbDot.title =
          body && typeof body.error === 'string' ? body.error : 'Sin conexión a PostgreSQL';
      } catch (err) {
        dbDot.classList.add('is-offline');
        dbDot.classList.remove('is-pending');
        dbDot.title =
          err && err.message
            ? 'No se alcanza el servidor'
            : 'Sin conexión al servidor o a PostgreSQL';
      }
    }

    void pingDatabaseHealth();
    setInterval(() => void pingDatabaseHealth(), DB_HEALTH_POLL_MS);

    right.appendChild(clockBox);
    right.appendChild(userBox);
    right.appendChild(dbBox);

    header.appendChild(left);
    header.appendChild(ratesWrap);
    header.appendChild(right);

    container.appendChild(header);
  }

  /** Refresca el display BCV del header según lo guardado en localStorage. */
  function syncNavbarRatesInputsFromLocalStorage() {
    const cur = loadRates();
    const bcvEl = document.getElementById('navbar-tasa-bcv');
    if (bcvEl) bcvEl.value = cur.bcv > 0 ? cur.bcv.toFixed(4) : '—';
  }

  /**
   * Obtiene tasas del servidor siempre fresco (sin caché HTTP) y persiste en localStorage.
   * Punto único para alinear POS con la BD después de cambiar tasas.
   * Implementa singleton in-flight: llamadas concurrentes reciben la misma promesa.
   * @returns {Promise<{ ok: true, bcv: number, usd: number } | null>}
   */
  let _hydrateInFlight = null;
  function hydrateTasasDesdeServidorSilent() {
    if (_hydrateInFlight) return _hydrateInFlight;
    const base = String(window.NEXUS_API_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
    const url = `${base}/api/configuracion/tasas-actuales`;
    const init = { method: 'GET', cache: 'no-store' };
    const req =
      window.NexusAuth && window.NexusAuth.authFetch
        ? window.NexusAuth.authFetch(url, init)
        : fetch(url, init);
    _hydrateInFlight = req
      .then((r) => {
        if (r.status === 401) return { __unauthorized: true };
        return r.ok ? r.json() : null;
      })
      .then((d) => {
        if (!d) return null;
        if (d.__unauthorized) return { ok: false, unauthorized: true };
        const bcv = parseFloat(String(d.tasa_bcv != null ? d.tasa_bcv : d.bcv).replace(',', '.'));
        const usd = parseFloat(String(d.tasa_usd != null ? d.tasa_usd : d.usd).replace(',', '.'));
        if (!bcv || Number.isNaN(bcv) || !usd || Number.isNaN(usd)) return null;
        const modo = String(d.modo_moneda_operacion || 'multimoneda').trim().toLowerCase();
        const usdOperativo = modo === 'solo_bcv' ? bcv : usd;
        saveRates(bcv, usdOperativo, true);
        syncNavbarRatesInputsFromLocalStorage();
        // Notificar a todos los listeners (Inventario, POS, etc.) tras hydrate
        window.dispatchEvent(
          new CustomEvent('nexus:tasas', { detail: { tasa_bcv: round4(bcv), tasa_usd: round4(usdOperativo) } })
        );
        return {
          ok: true,
          bcv: round4(bcv),
          usd: round4(usdOperativo),
          modo_moneda_operacion: modo
        };
      })
      .catch(() => null)
      .finally(() => {
        _hydrateInFlight = null;
      });
    return _hydrateInFlight;
  }

  window.addEventListener('nexus:tasas', syncNavbarRatesInputsFromLocalStorage);

  /* Otra pestaña u otra ventana mismo origen tocó tasas → actualizar caches locales. */
  window.addEventListener('storage', (e) => {
    if (
      !e.storageArea ||
      (e.key !== STORAGE_BCV && e.key !== STORAGE_USD)
    ) {
      return;
    }
    syncNavbarRatesInputsFromLocalStorage();
    const cur = loadRates();
    window.dispatchEvent(
      new CustomEvent('nexus:tasas', { detail: { tasa_bcv: cur.bcv, tasa_usd: cur.usd } })
    );
  });

  window.NexusComponents = window.NexusComponents || {};
  window.NexusComponents.renderNavbar = renderNavbar;
  window.NexusComponents.loadTasasLocal = loadRates;
  window.NexusComponents.saveTasasLocal = saveRates;
  window.NexusComponents.syncNavbarRatesInputsFromLocalStorage = syncNavbarRatesInputsFromLocalStorage;
  window.NexusComponents.hydrateTasasDesdeServidorSilent = hydrateTasasDesdeServidorSilent;
})();
