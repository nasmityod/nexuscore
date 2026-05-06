'use strict';

(function () {
  var TOKEN_KEY = 'nexus_access_token';
  var USER_KEY = 'nexus_user_json';

  function apiBase() {
    return String(window.NEXUS_API_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
  }

  function getAccessToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  /**
   * Decodifica el payload del JWT sin verificar firma (solo para conocer exp).
   * El servidor sigue siendo la fuente de verdad: nunca confiar en la decodificación
   * cliente para autorización, solo para evitar llamadas con tokens vencidos.
   */
  function decodeJwtPayload(token) {
    try {
      var parts = String(token || '').split('.');
      if (parts.length !== 3) return null;
      // Base64URL → Base64
      var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      var pad = b64.length % 4;
      if (pad === 2) b64 += '==';
      else if (pad === 3) b64 += '=';
      else if (pad === 1) return null;
      var json = atob(b64);
      // Manejar UTF-8 si el payload contiene caracteres acentuados
      try {
        json = decodeURIComponent(
          Array.prototype.map.call(json, function (c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
          }).join('')
        );
      } catch (_e) { /* ignorar y usar el atob crudo */ }
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  /**
   * Devuelve true si el token está vencido o es inválido.
   * Aplica un margen de 30s para tokens "casi" vencidos (clock skew).
   */
  function isTokenExpired(token) {
    if (!token) return true;
    var payload = decodeJwtPayload(token);
    if (!payload) return true;
    if (!payload.exp) return false; // sin exp = no vence
    var nowSec = Math.floor(Date.now() / 1000);
    return payload.exp <= (nowSec + 30);
  }

  function getUser() {
    try {
      var raw = localStorage.getItem(USER_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function setSession(token, user) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch (e) {}
    window.dispatchEvent(
      new CustomEvent('nexus:session', {
        detail: { user: user, token: token }
      })
    );
  }

  function clearSession() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      localStorage.removeItem('nexus_usuario_id');
    } catch (e) {}
    window.dispatchEvent(new CustomEvent('nexus:session', { detail: { user: null } }));
  }

  function authHeaders() {
    var t = getAccessToken();
    if (!t) return {};
    return { Authorization: 'Bearer ' + t };
  }

  function authFetch(url, init) {
    init = init || {};

    // Pre-check: si el token está claramente vencido, NO hagas la llamada
    // de red. Marcamos sesión como expirada y devolvemos un Response 401
    // sintético para que el llamador maneje el caso uniformemente.
    var t = getAccessToken();
    if (t && isTokenExpired(t)) {
      clearSession();
      try {
        var fragment0 = String(window.location.hash || '').replace(/^#\/?/, '');
        var first0 = fragment0.split('/')[0];
        if (first0 !== 'login') window.location.hash = '#/login';
      } catch (_e) {}
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'Token expirado' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        })
      );
    }

    var h = Object.assign({}, init.headers || {}, authHeaders());
    return fetch(url, Object.assign({}, init, { headers: h })).then(function (res) {
      if (res.status === 401) {
        clearSession();
        try {
          var fragment = String(window.location.hash || '').replace(/^#\/?/, '');
          var first = fragment.split('/')[0];
          if (first !== 'login') window.location.hash = '#/login';
        } catch (_e) {}
      }
      return res;
    });
  }

  /**
   * Wrapper de authFetch con retry automático en errores transitorios (503).
   * - Reintenta hasta `maxAttempts` veces con backoff lineal.
   * - NO reintenta para 4xx (errores de cliente / negocio).
   * - NO reintenta si el método es GET ni para mutaciones idempotentes
   *   (debe declararlo el llamador con init.idempotent = true).
   */
  function authFetchWithRetry(url, init, opts) {
    init = init || {};
    opts = opts || {};
    var maxAttempts = opts.maxAttempts != null ? opts.maxAttempts : 3;
    var baseDelayMs = opts.baseDelayMs != null ? opts.baseDelayMs : 1500;
    var method = String((init.method || 'GET')).toUpperCase();
    var canRetry = method === 'GET' || init.idempotent === true;

    function attempt(n) {
      return authFetch(url, init).then(function (res) {
        if (res.status !== 503 || !canRetry || n >= maxAttempts) return res;
        return new Promise(function (resolve) {
          setTimeout(resolve, baseDelayMs * n);
        }).then(function () {
          return attempt(n + 1);
        });
      });
    }

    return attempt(1);
  }

  function login(username, password) {
    return fetch(apiBase() + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password })
    }).then(function (res) {
      return res.text().then(function (txt) {
        var data = null;
        try {
          data = txt ? JSON.parse(txt) : null;
        } catch (e) {}
        if (!res.ok) {
          var msg = (data && data.error) || txt || res.statusText || 'Error de acceso';
          throw new Error(msg);
        }
        return data;
      });
    }).then(function (data) {
      if (!data || !data.token) throw new Error('Respuesta de login inválida');
      setSession(data.token, data.user);
      try {
        if (data.user && data.user.id) {
          localStorage.setItem('nexus_usuario_id', String(data.user.id));
        }
        // Guardar advertencia de cajas abiertas de otros usuarios
        // para que el dashboard / POS la muestre como banner.
        if (Array.isArray(data.cajas_abiertas_otros) && data.cajas_abiertas_otros.length > 0) {
          localStorage.setItem(
            'nexus_cajas_abiertas_otros',
            JSON.stringify(data.cajas_abiertas_otros)
          );
        } else {
          localStorage.removeItem('nexus_cajas_abiertas_otros');
        }
      } catch (e) {}
      return data;
    });
  }

  function logout() {
    var token = getAccessToken();
    clearSession(); // limpia localStorage PRIMERO
    if (token) {
      // Notifica al servidor (auditoría). Fire-and-forget.
      fetch(apiBase() + '/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token }
      }).catch(function () {});
    }
  }

  /**
   * Verifica con el servidor si el token guardado sigue siendo válido.
   * Retorna Promise<boolean>.
   * Si el servidor responde 401 → limpia sesión automáticamente.
   */
  function verifySession() {
    var token = getAccessToken();
    if (!token) return Promise.resolve(false);

    // Pre-check de expiración para evitar tráfico innecesario.
    if (isTokenExpired(token)) {
      clearSession();
      return Promise.resolve(false);
    }

    return fetch(apiBase() + '/api/auth/verify', {
      headers: { Authorization: 'Bearer ' + token }
    }).then(function (res) {
      if (res.status === 401) {
        clearSession();
        return false;
      }
      if (!res.ok) return false;
      return res.json().then(function (data) {
        if (data && data.valid && data.user) {
          // Refresca el objeto user en localStorage con datos actuales del servidor
          setSession(token, data.user);
        }
        return !!(data && data.valid);
      });
    }).catch(function () {
      // Sin conexión — asumir sesión válida para no bloquear el POS offline
      return !!token;
    });
  }

  var ROLE_PERM_FALLBACK = {
    admin: { all: true },
    vendedor: {
      dashboard: true,
      pos_sales: true,
      ventas_ver: true,
      ventas_anular: false,
      caja_operar: false,
      clientes_ver: true,
      clientes_edit: false,
      inventario_ver: true,
      inventario_edit: false,
      compras_all: false,
      proveedores_all: false,
      reportes_all: false,
      config_read: false,
      config_write: false,
      tasas_ver: true,
      tasas_edit: false,
      usuarios_all: false,
      pdf_ver: true
    },
    cajero: {
      dashboard: true,
      pos_sales: true,
      ventas_ver: true,
      ventas_anular: false,
      caja_operar: true,
      clientes_ver: true,
      clientes_edit: true,
      inventario_ver: true,
      inventario_edit: false,
      compras_all: false,
      proveedores_all: false,
      reportes_all: true,
      config_read: true,
      config_write: false,
      tasas_ver: true,
      tasas_edit: false,
      usuarios_all: false,
      pdf_ver: true
    },
    almacenista: {
      dashboard: true,
      pos_sales: false,
      ventas_ver: true,
      ventas_anular: false,
      caja_operar: false,
      clientes_ver: false,
      clientes_edit: false,
      inventario_ver: true,
      inventario_edit: true,
      compras_all: true,
      proveedores_all: true,
      reportes_all: false,
      config_read: false,
      config_write: false,
      tasas_ver: true,
      tasas_edit: false,
      usuarios_all: false,
      pdf_ver: true
    },
    supervisor: {
      dashboard: true,
      pos_sales: true,
      ventas_ver: true,
      ventas_anular: true,
      caja_operar: true,
      clientes_ver: true,
      clientes_edit: true,
      inventario_ver: true,
      inventario_edit: true,
      compras_all: true,
      proveedores_all: true,
      reportes_all: true,
      config_read: true,
      config_write: true,
      tasas_ver: true,
      tasas_edit: false,
      usuarios_all: true,
      pdf_ver: true
    }
  };

  function normalizePermisosObj(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw;
  }

  function effectivePermissions() {
    var u = getUser();
    if (!u) return {};
    var p = normalizePermisosObj(u.permisos);
    if (p.all === true) return p;
    if (Object.keys(p).length > 0) return p;
    var rn = String(u.rol_nombre || u.rol || '')
      .toLowerCase()
      .trim();
    return normalizePermisosObj(ROLE_PERM_FALLBACK[rn]) || {};
  }

  function can(permissionKey) {
    var p = effectivePermissions();
    if (p.all === true) return true;
    return p[permissionKey] === true;
  }

  window.NexusAuth = {
    apiBase: apiBase,
    getAccessToken: getAccessToken,
    getUser: getUser,
    setSession: setSession,
    clearSession: clearSession,
    authFetch: authFetch,
    authFetchWithRetry: authFetchWithRetry,
    isTokenExpired: isTokenExpired,
    decodeJwtPayload: decodeJwtPayload,
    login: login,
    logout: logout,
    verifySession: verifySession,
    can: can,
    effectivePermissions: effectivePermissions
  };
})();
