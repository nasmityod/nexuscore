'use strict';

(function () {
  const STORAGE_BCV = 'nexus_tasa_bcv';
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
    const d = {
      bcv: parseFloat(localStorage.getItem(STORAGE_BCV) || '489.5547'),
      usd: parseFloat(rawUsd || '625.0000')
    };
    if (Number.isNaN(d.bcv)) d.bcv = 489.5547;
    if (Number.isNaN(d.usd)) d.usd = 625.0;
    return { bcv: round4(d.bcv), usd: round4(d.usd) };
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

  function persistTasasToServer(bcv, usd) {
    const base = String(window.NEXUS_API_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
    const url = `${base}/api/configuracion/tasas`;
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasa_bcv: bcv, tasa_usd: usd })
    };
    const req =
      window.NexusAuth && window.NexusAuth.authFetch
        ? window.NexusAuth.authFetch(url, init)
        : fetch(url, init);
    return req.then((res) => {
      if (!res.ok) {
        return res.text().then((txt) => {
          let msg = txt || res.statusText || 'Error del servidor';
          try {
            const j = JSON.parse(txt);
            if (j && j.error) msg = j.error;
          } catch (e) {
            /* ignore */
          }
          throw new Error(msg);
        });
      }
      return res.json();
    });
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

    const puedeEditarTasasServidor =
      window.NexusAuth &&
      typeof window.NexusAuth.can === 'function' &&
      window.NexusAuth.can('tasas_edit');

    const mkGroup = (label, badge, initial, key) => {
      const g = document.createElement('div');
      g.className = 'tasa-group';
      const lb = document.createElement('span');
      lb.className = 'tasa-badge';
      lb.textContent = badge;
      const wrap = document.createElement('div');
      wrap.className = 'tasa-input-wrap';
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'tasa-input';
      inp.id = key === 'bcv' ? 'navbar-tasa-bcv' : 'navbar-tasa-usd';
      inp.setAttribute('inputmode', 'decimal');
      inp.setAttribute('aria-label', label);
      inp.value = initial.toFixed(4);
      inp.readOnly = !puedeEditarTasasServidor;
      inp.title = puedeEditarTasasServidor
        ? label
        : 'Solo el administrador puede modificar las tasas en el servidor';
      if (puedeEditarTasasServidor) {
        inp.addEventListener('blur', () => {
          const v = parseFloat(String(inp.value).replace(',', '.'));
          if (Number.isNaN(v) || v <= 0) {
            const cur = loadRates();
            inp.value = (key === 'bcv' ? cur.bcv : cur.usd).toFixed(4);
            return;
          }
          const other =
            key === 'bcv'
              ? parseFloat(String(usdInp.value).replace(',', '.'))
              : parseFloat(String(bcvInp.value).replace(',', '.'));
          const bcvVal = key === 'bcv' ? v : other;
          const usdVal = key === 'usd' ? v : other;
          if (usdVal < bcvVal) {
            window.NexusComponents &&
              window.NexusComponents.showToast &&
              window.NexusComponents.showToast(
                'El tipo USD no puede ser menor que el tipo USD BCV',
                'warning'
              );
            const cur = loadRates();
            inp.value = (key === 'bcv' ? cur.bcv : cur.usd).toFixed(4);
            return;
          }
          const saved = saveRates(bcvVal, usdVal);
          bcvInp.value = saved.bcv.toFixed(4);
          usdInp.value = saved.usd.toFixed(4);
          persistTasasToServer(saved.bcv, saved.usd)
            .then(() => {
              window.NexusComponents &&
                window.NexusComponents.showToast &&
                window.NexusComponents.showToast('Tasas guardadas (local y servidor)', 'success');
            })
            .catch((err) => {
              window.NexusComponents &&
                window.NexusComponents.showToast &&
                window.NexusComponents.showToast(
                  (err && err.message) || 'No se pudieron guardar las tasas en el servidor',
                  'danger'
                );
            });
        });
      }
      wrap.appendChild(inp);
      g.appendChild(lb);
      g.appendChild(wrap);
      return { g, inp };
    };

    const b = mkGroup('Tipo USD BCV (Bs por USD)', 'USD BCV', rates.bcv, 'bcv');
    const u = mkGroup('Tipo USD (Bs por USD)', 'USD', rates.usd, 'usd');
    const bcvInp = b.inp;
    const usdInp = u.inp;

    tasasInner.appendChild(b.g);
    tasasInner.appendChild(u.g);
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
        window.NexusAuth.logout();
        window.NexusComponents &&
          window.NexusComponents.showToast &&
          window.NexusComponents.showToast('Sesión cerrada. Otro usuario puede iniciar sesión.', 'success');
      }
    });

    userBox.appendChild(userCol);
    userBox.appendChild(logoutBtn);
    applyUserHeader();
    window.addEventListener('nexus:session', applyUserHeader);

    const dbBox = document.createElement('div');
    dbBox.className = 'db-status';
    dbBox.innerHTML =
      '<span class="db-status-dot" title="Conexión BD simulada"></span><span>BD</span>';

    right.appendChild(clockBox);
    right.appendChild(userBox);
    right.appendChild(dbBox);

    header.appendChild(left);
    header.appendChild(ratesWrap);
    header.appendChild(right);

    container.appendChild(header);
  }

  /** Refresca los inputs del header según lo guardado en localStorage (tasas efectivas POS). */
  function syncNavbarRatesInputsFromLocalStorage() {
    const cur = loadRates();
    const bcvEl = document.getElementById('navbar-tasa-bcv');
    const usdEl = document.getElementById('navbar-tasa-usd');
    if (bcvEl) bcvEl.value = cur.bcv.toFixed(4);
    if (usdEl) usdEl.value = cur.usd.toFixed(4);
  }

  /**
   * Obtiene tasas del servidor siempre fresco (sin caché HTTP) y persiste en localStorage.
   * Punto único para alinear POS con la BD después de cambiar tasas.
   * @returns {Promise<{ ok: true, bcv: number, usd: number } | null>}
   */
  function hydrateTasasDesdeServidorSilent() {
    const base = String(window.NEXUS_API_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
    const url = `${base}/api/configuracion/tasas-actuales`;
    const init = { method: 'GET', cache: 'no-store' };
    const req =
      window.NexusAuth && window.NexusAuth.authFetch
        ? window.NexusAuth.authFetch(url, init)
        : fetch(url, init);
    return req
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return null;
        const bcv = parseFloat(String(d.tasa_bcv != null ? d.tasa_bcv : d.bcv).replace(',', '.'));
        const usd = parseFloat(String(d.tasa_usd != null ? d.tasa_usd : d.usd).replace(',', '.'));
        if (!bcv || Number.isNaN(bcv) || !usd || Number.isNaN(usd)) return null;
        saveRates(bcv, usd, true);
        syncNavbarRatesInputsFromLocalStorage();
        return { ok: true, bcv: round4(bcv), usd: round4(usd) };
      })
      .catch(() => null);
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
