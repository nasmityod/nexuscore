'use strict';

(function () {
  var cfgActual = {};
  /** true cuando cargarConfig() + hydrate completaron exitosamente */
  var _tasasDisplayListas = false;

  function apiBase() { return String(window.NEXUS_API_BASE || 'http://127.0.0.1:3000').replace(/\/$/, ''); }
  function apiFetch(path, init) {
    var url = path.indexOf('http') === 0 ? path : apiBase() + path;
    if (window.NexusAuth && window.NexusAuth.authFetch) return window.NexusAuth.authFetch(url, init);
    return fetch(url, init);
  }
  function toast(msg, tipo) {
    if (window.NexusComponents && window.NexusComponents.showToast) window.NexusComponents.showToast(msg, tipo || 'info');
  }
  function n(v) { return Number(v) || 0; }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  var SVG_EDIT = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  var SVG_LIC_OK = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>';
  var SVG_LIC_WARN = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  var SVG_LIC_WAIT = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

  function etiquetaIntervaloMin(m) {
    if (typeof m !== 'number' || !Number.isFinite(m)) return '—';
    if (m < 60) return m + ' min';
    if (m % 1440 === 0) {
      var días = m / 1440;
      return días === 1 ? '1 día' : días + ' días';
    }
    if (m % 60 === 0) {
      var h = m / 60;
      return h === 1 ? '1 hora' : h + ' horas';
    }
    return (Math.round((m / 60) * 10) / 10) + ' h';
  }

  var BACKUP_INTERVAL_PRESETS_MIN = [15, 30, 45, 60, 90, 120, 240, 360, 720, 1440, 2880, 4320, 10080];

  function poblarSelectIntervalo(selectEl, minutosPreferidos) {
    if (!selectEl) return;
    var mPref = typeof minutosPreferidos === 'number' && Number.isFinite(minutosPreferidos)
      ? Math.round(minutosPreferidos)
      : 1440;
    while (selectEl.firstChild) selectEl.removeChild(selectEl.firstChild);
    var seen = {};
    BACKUP_INTERVAL_PRESETS_MIN.forEach(function (m) {
      seen[m] = true;
      var o = document.createElement('option');
      o.value = String(m);
      o.textContent = etiquetaIntervaloMin(m);
      selectEl.appendChild(o);
    });
    if (!seen[mPref]) {
      var o2 = document.createElement('option');
      o2.value = String(mPref);
      o2.textContent = etiquetaIntervaloMin(mPref) + ' (' + mPref + ' min)';
      selectEl.appendChild(o2);
    }
    selectEl.value = String(mPref);
  }

  function puedeEscribirConfig() {
    return window.NexusAuth && typeof window.NexusAuth.can === 'function' &&
      window.NexusAuth.can('config_write');
  }

  function sincronizarFormularioScheduler(sch) {
    var s = sch || {};
    var bBanner = document.getElementById('respaldo-env-priority-banner');
    if (bBanner) {
      if (s.desde_entorno) {
        bBanner.style.display = '';
        bBanner.innerHTML =
          'La variable de entorno <code>NEXUS_BACKUP_INTERVAL_MINUTES</code> está definida y ' +
          '<strong>prevalece</strong> sobre lo guardado en la base de datos. Intervalo efectivo: ' +
          '<strong>' + esc(String(s.efectivo_minutos != null ? s.efectivo_minutos : 0)) + '</strong> min.';
      } else {
        bBanner.style.display = 'none';
        bBanner.innerHTML = '';
      }
    }

    var cb = document.getElementById('cfg-backup-sched-active');
    var sel = document.getElementById('cfg-backup-sched-interval-min');
    var btnG = document.getElementById('btn-guardar-backup-sched');
    var bloqueadoEnv = s.desde_entorno === true;
    var puede = puedeEscribirConfig();

    var autoRaw = s.bd ? s.bd.backup_automatico : null;
    var autoOn = autoRaw == null || autoRaw === ''
      ? true
      : (String(autoRaw).toLowerCase() !== 'false' && String(autoRaw) !== '0' && String(autoRaw).toLowerCase() !== 'no');

    var minBd = s.bd && s.bd.intervalo_minutos != null ? n(s.bd.intervalo_minutos) : 0;
    if (!minBd || minBd < 1) {
      var fb = s.intervalo_horas_fallback != null ? n(s.intervalo_horas_fallback) : 24;
      minBd = Math.round(fb * 60);
    }

    if (cb) {
      cb.checked = autoOn;
      cb.disabled = bloqueadoEnv || !puede;
    }
    poblarSelectIntervalo(sel, minBd);
    if (sel) sel.disabled = bloqueadoEnv || !puede;
    if (btnG) btnG.disabled = bloqueadoEnv || !puede;
  }

  function guardarProgramaBackup() {
    if (!puedeEscribirConfig()) {
      toast('No tienes permiso para cambiar esta configuración', 'warning');
      return;
    }
    var cb = document.getElementById('cfg-backup-sched-active');
    var sel = document.getElementById('cfg-backup-sched-interval-min');
    if (!cb || !sel) return;
    var min = n(sel.value);
    if (cb.checked && (min < 15 || min > 10080)) {
      toast('Elige un intervalo entre 15 min y 7 días', 'warning');
      return;
    }

    var btn = document.getElementById('btn-guardar-backup-sched');
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }

    apiFetch('/api/configuracion/respaldo/scheduler', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        backup_automatico: cb.checked,
        intervalo_minutos: cb.checked ? min : min
      })
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Error');
        return d;
      });
    }).then(function (resp) {
      toast('Programa de respaldos guardado', 'success');
      if (resp.aviso) toast(resp.aviso, 'warning');
      cargarEstadoRespaldo();
    }).catch(function (e) {
      toast(e.message || 'No se pudo guardar el programa', 'error');
    }).finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Guardar programa'; }
      if (window.__nexusLastScheduler) sincronizarFormularioScheduler(window.__nexusLastScheduler);
    });
  }

  /* ─── CARGAR CONFIG ─── */
  function cargarConfig() {
    _tasasDisplayListas = false;
    // Deshabilitar guardado mientras carga para evitar guardado con displays vacíos (IMPACT-002)
    var btnTasas = document.getElementById('btn-guardar-tasas');
    if (btnTasas) btnTasas.disabled = true;

    apiFetch('/api/configuracion', { cache: 'no-store' })
      .then(function (r) {
        return r.ok ? r.json() : {};
      })
      .then(function (cfg) {
        cfgActual = cfg;

        // Displays se pintan SOLO desde hydrate para evitar flash de valor raw vs legal (IMPACT-006)
        var dispBcv = document.getElementById('display-bcv');
        var dispUsd = document.getElementById('display-usd');
        if (dispBcv && dispBcv.textContent === '') dispBcv.textContent = '—';
        if (dispUsd && dispUsd.textContent === '') dispUsd.textContent = '—';

        setVal('cfg-empresa-nombre', cfg.empresa_nombre || cfg.nombre_empresa);
        setVal('cfg-empresa-rif', cfg.empresa_rif || cfg.rif_empresa);
        setVal('cfg-empresa-telefono', cfg.empresa_telefono || cfg.telefono_empresa);
        setVal('cfg-empresa-direccion', cfg.empresa_direccion || cfg.direccion_empresa);
        setVal('cfg-empresa-email', cfg.empresa_email || cfg.email_empresa);
        setVal('cfg-factura-control-desde', cfg.factura_control_desde || '1');
        setVal('cfg-factura-leyenda', cfg.factura_leyenda || '');

        setVal('cfg-imp-nombre', cfg.impresora_nombre);
        setVal('cfg-imp-interfaz', cfg.impresora_interfaz || 'tcp://192.168.1.100:9100');
        var tipoEl = document.getElementById('cfg-imp-tipo');
        if (tipoEl) {
          if (!cfg.impresora_interfaz || cfg.impresora_activa === 'false') tipoEl.value = 'none';
          else if ((cfg.impresora_interfaz || '').startsWith('tcp://')) tipoEl.value = 'tcp';
          else tipoEl.value = 'usb';
        }
      })
      .then(function () {
        if (window.NexusComponents && typeof window.NexusComponents.hydrateTasasDesdeServidorSilent === 'function') {
          return window.NexusComponents.hydrateTasasDesdeServidorSilent();
        }
        return null;
      })
      .then(function (ht) {
        var dispBcv = document.getElementById('display-bcv');
        var dispUsd = document.getElementById('display-usd');
        if (ht && ht.ok) {
          if (dispBcv) dispBcv.textContent = ht.bcv.toFixed(4);
          if (dispUsd) dispUsd.textContent = ht.usd.toFixed(4);
          _tasasDisplayListas = true;
        } else {
          // Hydrate falló: caer a localStorage como respaldo
          var local = window.NexusComponents && window.NexusComponents.loadTasasLocal
            ? window.NexusComponents.loadTasasLocal() : { bcv: 0, usd: 0 };
          if (dispBcv) dispBcv.textContent = local.bcv > 0 ? local.bcv.toFixed(4) : '—';
          if (dispUsd) dispUsd.textContent = local.usd > 0 ? local.usd.toFixed(4) : '—';
          _tasasDisplayListas = local.bcv > 0 && local.usd > 0;
        }
      })
      .then(function () {
        return cargarEstadoBcvAuto();
      })
      .catch(function () {
        toast('No se pudo cargar la configuración', 'error');
      })
      .finally(function () {
        // Re-habilitar guardado solo si tiene permiso (IMPACT-002)
        aplicarUIPermisosTasas(null);
      });
  }

  function setVal(id, val) {
    var el = document.getElementById(id);
    if (el) el.value = val || '';
  }

  function formatearFechaVe(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      return d.toLocaleString('es-VE', { timeZone: 'America/Caracas' });
    } catch (e) {
      return String(iso);
    }
  }

  function formatearFechaValorYmd(ymd) {
    if (!ymd) return '—';
    var p = String(ymd).trim().split('-');
    if (p.length === 3) return p[2] + '/' + p[1] + '/' + p[0];
    return String(ymd);
  }

  function renderEstadoBcvAuto(st) {
    var badge = document.getElementById('bcv-auto-badge');
    var msgP = document.getElementById('bcv-auto-msg-principal');
    var msgS = document.getElementById('bcv-auto-msg-secundaria');
    var lista = document.getElementById('bcv-auto-detalles-list');
    var detWrap = document.getElementById('bcv-auto-detalles');
    if (!msgP) return;
    st = st || {};

    var activo = !!(st.activo || st.desde_entorno_auto);
    var congelada = !!(
      st.tasa_congelada_fin_semana_feriado ||
      (st.dia_habil_referencia && st.hoy_caracas && st.dia_habil_referencia !== st.hoy_caracas)
    );
    var pendiente = st.pendiente != null && n(st.pendiente) > 0;

    var badgeText = 'Desactivada';
    var badgeCls = 'bcv-auto-badge--off';
    if (!activo) {
      badgeText = 'Desactivada';
      badgeCls = 'bcv-auto-badge--off';
    } else if (st.ultimo_error) {
      badgeText = 'Revisar';
      badgeCls = 'bcv-auto-badge--warn';
    } else if (congelada) {
      badgeText = 'Sin cambio hoy';
      badgeCls = 'bcv-auto-badge--idle';
    } else if (pendiente && !st.pendiente_puede_aplicar) {
      badgeText = 'Cambio programado';
      badgeCls = 'bcv-auto-badge--pending';
    } else if (pendiente) {
      badgeText = 'Lista para aplicar';
      badgeCls = 'bcv-auto-badge--ok';
    } else {
      badgeText = 'Al día';
      badgeCls = 'bcv-auto-badge--ok';
    }

    if (badge) {
      badge.className = 'bcv-auto-badge ' + badgeCls;
      badge.textContent = badgeText;
    }

    var principal = 'No se pudo cargar el estado. Use «Consultar ahora» o recargue la página.';
    if (!activo) {
      principal =
        'Active la casilla de arriba para que el sistema consulte la tasa oficial cada día hábil (~5:30 p.m.) ' +
        'y la aplique a medianoche según el calendario del BCV.';
    } else if (st.ultimo_error) {
      principal =
        'La última consulta falló. Puede pulsar «Consultar ahora» o abrir los detalles técnicos abajo.';
    } else if (congelada) {
      var ref = st.dia_habil_referencia ? formatearFechaValorYmd(st.dia_habil_referencia) : '';
      principal = ref
        ? 'Hoy es fin de semana o feriado: se sigue usando la tasa del día hábil ' + ref + '.'
        : 'Hoy no hay cambio de tasa (fin de semana o feriado bancario).';
    } else if (pendiente) {
      var tasaTxt = n(st.pendiente).toFixed(4) + ' Bs';
      var fvTxt = formatearFechaValorYmd(st.pendiente_fecha_valor);
      if (st.pendiente_puede_aplicar) {
        principal = 'La tasa ' + tasaTxt + ' ya puede entrar en vigencia.';
      } else {
        principal = 'La tasa ' + tasaTxt + ' se aplicará el ' + fvTxt + ' a las 12:00 a.m.';
      }
    } else {
      principal =
        'La tasa BCV en pantalla está al día. El sistema consulta sola cada día hábil (~5:30 p.m.).';
    }
    msgP.textContent = principal;

    if (msgS) {
      var secundaria = '';
      if (activo && pendiente && !st.pendiente_puede_aplicar && !congelada) {
        secundaria = 'Hasta esa fecha se mantiene la tasa que ves arriba en «Tasa BCV (oficial)».';
      } else if (activo && !pendiente && !congelada && !st.ultimo_error) {
        secundaria = 'Si el BCV publicó hoy una tasa nueva, aparecerá aquí tras la consulta de la tarde.';
      }
      if (secundaria) {
        msgS.textContent = secundaria;
        msgS.hidden = false;
      } else {
        msgS.textContent = '';
        msgS.hidden = true;
      }
    }

    var detalles = [];
    if (st.hoy_caracas) detalles.push('Hoy (Caracas): ' + formatearFechaValorYmd(st.hoy_caracas));
    if (st.ultima_consulta) detalles.push('Última consulta a la API: ' + formatearFechaVe(st.ultima_consulta));
    if (st.ultima_aplicacion) detalles.push('Última aplicación de tasa: ' + formatearFechaVe(st.ultima_aplicacion));
    if (pendiente) {
      detalles.push(
        'Tasa recibida de la API: ' + n(st.pendiente).toFixed(4) +
        ' · fecha valor ' + formatearFechaValorYmd(st.pendiente_fecha_valor)
      );
    }
    detalles.push(
      'Programa: 1 consulta al día (~' + (st.consulta_diaria_hora || '17:30') + ') · vigencia a medianoche'
    );
    if (st.calendario_anio) {
      var cnt = st.feriados_cantidad != null
        ? st.feriados_cantidad
        : (st.feriados && st.feriados.length) || 0;
      detalles.push('Feriados ' + String(st.calendario_anio) + ' cargados: ' + String(cnt) + ' fechas');
    }
    if (st.ultimo_error) detalles.push('Error: ' + String(st.ultimo_error));

    if (lista) {
      lista.innerHTML = '';
      detalles.forEach(function (txt) {
        var li = document.createElement('li');
        li.textContent = txt;
        lista.appendChild(li);
      });
    }
    if (detWrap) detWrap.open = !!st.ultimo_error;

    // Aviso si el job BCV auto elevó USD automáticamente (IMPACT-003)
    var avisoUsd = document.getElementById('bcv-auto-aviso-usd-ajuste');
    if (st.usd_ajuste_ts) {
      var tsAjuste = new Date(st.usd_ajuste_ts);
      var hace48h = new Date(Date.now() - 48 * 60 * 60 * 1000);
      if (tsAjuste > hace48h) {
        if (!avisoUsd) {
          avisoUsd = document.createElement('p');
          avisoUsd.id = 'bcv-auto-aviso-usd-ajuste';
          avisoUsd.className = 'bcv-auto-notice bcv-auto-notice--warn';
          if (msgP && msgP.parentNode) msgP.parentNode.insertBefore(avisoUsd, msgP.nextSibling);
        }
        var de = st.usd_ajuste_de != null ? n(st.usd_ajuste_de).toFixed(4) : '?';
        var a = st.usd_ajuste_a != null ? n(st.usd_ajuste_a).toFixed(4) : '?';
        avisoUsd.textContent =
          'El sistema ajustó automáticamente la tasa USD de ' + de + ' a ' + a +
          ' para que no sea inferior al BCV. Revisa la tasa USD en la pestaña «Tasas».';
        avisoUsd.hidden = false;
      } else if (avisoUsd) {
        avisoUsd.hidden = true;
      }
    } else if (avisoUsd) {
      avisoUsd.hidden = true;
    }
  }

  function sincronizarFormularioBcvAuto(st) {
    window.__nexusBcvAuto = st || {};
    var cb = document.getElementById('cfg-bcv-auto-active');
    var fer = document.getElementById('cfg-bcv-feriados');
    var banner = document.getElementById('bcv-auto-env-banner');
    var btnForzar = document.getElementById('btn-bcv-auto-forzar');
    if (cb) cb.checked = !!(st && st.activo);
    if (fer && st && st.feriados && st.feriados.length) {
      try { fer.value = JSON.stringify(st.feriados); } catch (e) { fer.value = '[]'; }
      fer.readOnly = !puedeEscribirConfig();
    }
    if (banner) {
      if (st && st.desde_entorno_auto) {
        banner.style.display = '';
        banner.textContent =
          'La sincronización está fijada en la configuración del servidor; el interruptor de aquí no la cambia.';
      } else {
        banner.style.display = 'none';
        banner.textContent = '';
      }
    }
    // Mostrar «Aplicar ahora» solo si hay una tasa pendiente no aplicada aún
    if (btnForzar) {
      var puedeTasas = window.NexusAuth && typeof window.NexusAuth.can === 'function' &&
        window.NexusAuth.can('tasas_edit');
      var hasPendiente = st && st.pendiente != null && n(st.pendiente) > 0;
      btnForzar.style.display = (puedeTasas && hasPendiente) ? '' : 'none';
    }
    renderEstadoBcvAuto(st);
  }

  function cargarEstadoBcvAuto() {
    return apiFetch('/api/configuracion/tasa-bcv-auto', { cache: 'no-store' })
      .then(function (r) {
        return r.ok ? r.json() : r.json().then(function (d) { throw new Error(d.error || 'Error'); });
      })
      .then(function (st) {
        sincronizarFormularioBcvAuto(st);
        return st;
      })
      .catch(function () {
        sincronizarFormularioBcvAuto({});
      });
  }

  function guardarProgramaBcvAuto() {
    if (!puedeEscribirConfig()) {
      toast('No tienes permiso para cambiar esta configuración', 'warning');
      return;
    }
    var cb = document.getElementById('cfg-bcv-auto-active');
    var fer = document.getElementById('cfg-bcv-feriados');
    var feriados = [];
    if (fer && fer.value.trim()) {
      try {
        var parsed = JSON.parse(fer.value.trim());
        if (!Array.isArray(parsed)) throw new Error('Debe ser un arreglo JSON');
        feriados = parsed;
      } catch (e) {
        toast('Feriados: JSON inválido (ej. ["2026-05-01"])', 'warning');
        return;
      }
    }
    var btn = document.getElementById('btn-guardar-bcv-auto');
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
    apiFetch('/api/configuracion/tasa-bcv-auto', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activo: cb ? cb.checked : false, feriados: feriados })
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Error');
        return d;
      });
    }).then(function (resp) {
      toast('Configuración BCV automática guardada', 'success');
      sincronizarFormularioBcvAuto(resp.estado || {});
    }).catch(function (e) {
      toast(e.message || 'No se pudo guardar', 'error');
    }).finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Guardar cambios'; }
      aplicarUIPermisosBcvAuto(null);
    });
  }

  function forzarAplicarBcvAhora() {
    if (window.NexusAuth && typeof window.NexusAuth.can === 'function' && !window.NexusAuth.can('tasas_edit')) {
      toast('Solo el administrador puede aplicar la tasa BCV', 'warning');
      return;
    }
    var btn = document.getElementById('btn-bcv-auto-forzar');
    if (btn) { btn.disabled = true; btn.textContent = 'Aplicando...'; }
    apiFetch('/api/configuracion/tasa-bcv-auto/forzar-aplicar', { method: 'POST' })
      .then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error(d.error || 'Error');
          return d;
        });
      })
      .then(function (resp) {
        var ap = resp.aplicacion;
        if (ap && ap.aplicado) {
          toast('Tasa BCV aplicada: ' + n(ap.tasa_bcv).toFixed(4), 'success');
          cargarConfig();
          if (window.NexusComponents && typeof window.NexusComponents.hydrateTasasDesdeServidorSilent === 'function') {
            window.NexusComponents.hydrateTasasDesdeServidorSilent();
          }
        } else if (ap && ap.motivo === 'ya_activa') {
          toast('La tasa ya estaba activa', 'info');
        } else if (ap && ap.motivo === 'sin_pendiente') {
          toast('No hay tasa pendiente que aplicar', 'warning');
        } else {
          toast('No se pudo aplicar la tasa ahora', 'warning');
        }
        if (resp.estado) sincronizarFormularioBcvAuto(resp.estado);
        else cargarEstadoBcvAuto();
      })
      .catch(function (e) {
        toast(e.message || 'Error al aplicar la tasa', 'error');
        cargarEstadoBcvAuto();
      })
      .finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = 'Aplicar ahora'; }
        aplicarUIPermisosBcvAuto(null);
      });
  }

  function consultarBcvAutoAhora() {
    if (window.NexusAuth && typeof window.NexusAuth.can === 'function' && !window.NexusAuth.can('tasas_edit')) {
      toast('Solo el administrador puede sincronizar la tasa BCV', 'warning');
      return;
    }
    var btn = document.getElementById('btn-bcv-auto-sync');
    if (btn) { btn.disabled = true; btn.textContent = 'Consultando...'; }
    apiFetch('/api/configuracion/tasa-bcv-auto/sincronizar', { method: 'POST' })
      .then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error(d.error || 'Error');
          return d;
        });
      })
      .then(function (resp) {
        var est = resp.resultado && resp.resultado.estado ? resp.resultado.estado : null;
        if (est) sincronizarFormularioBcvAuto(est);
        else cargarEstadoBcvAuto();
        var ap = resp.resultado && resp.resultado.aplicacion;
        if (ap && ap.aplicado) {
          toast('Tasa BCV aplicada: ' + n(ap.tasa_bcv).toFixed(4), 'success');
          cargarConfig();
          if (window.NexusComponents && typeof window.NexusComponents.hydrateTasasDesdeServidorSilent === 'function') {
            window.NexusComponents.hydrateTasasDesdeServidorSilent();
          }
        } else {
          toast('Consulta lista. La nueva tasa se aplicará en la fecha indicada arriba.', 'success');
        }
      })
      .catch(function (e) {
        toast(e.message || 'No se pudo consultar la API', 'error');
        cargarEstadoBcvAuto();
      })
      .finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = 'Consultar ahora'; }
        aplicarUIPermisosBcvAuto(null);
      });
  }

  function aplicarUIPermisosBcvAuto(host) {
    var puedeCfg = puedeEscribirConfig();
    var puedeTasas = window.NexusAuth && typeof window.NexusAuth.can === 'function' &&
      window.NexusAuth.can('tasas_edit');
    var idsCfg = ['cfg-bcv-auto-active', 'btn-guardar-bcv-auto'];
    idsCfg.forEach(function (id) {
      var el = (host && host.querySelector ? host : document).querySelector('#' + id);
      if (!el) el = document.getElementById(id);
      if (el) el.disabled = !puedeCfg;
    });
    var ferEl = (host && host.querySelector ? host : document).querySelector('#cfg-bcv-feriados');
    if (!ferEl) ferEl = document.getElementById('cfg-bcv-feriados');
    if (ferEl) ferEl.readOnly = !puedeCfg;
    var btnSync = (host && host.querySelector ? host : document).querySelector('#btn-bcv-auto-sync');
    if (!btnSync) btnSync = document.getElementById('btn-bcv-auto-sync');
    if (btnSync) btnSync.disabled = !puedeTasas;
    var btnForzar = (host && host.querySelector ? host : document).querySelector('#btn-bcv-auto-forzar');
    if (!btnForzar) btnForzar = document.getElementById('btn-bcv-auto-forzar');
    // Solo se oculta/muestra por sincronizarFormularioBcvAuto; aquí solo controlamos disabled
    if (btnForzar) btnForzar.disabled = !puedeTasas;
  }

  function aplicarUIPermisosTasas(host) {
    var puede = window.NexusAuth && typeof window.NexusAuth.can === 'function' && window.NexusAuth.can('tasas_edit');
    var ids = ['input-tasa-bcv', 'input-tasa-usd', 'btn-guardar-tasas'];
    ids.forEach(function (id) {
      var el = (host && host.querySelector ? host : document).querySelector('#' + id);
      if (!el) el = document.getElementById(id);
      if (!el) return;
      el.disabled = !puede;
      if (id.indexOf('input-') === 0) {
        el.readOnly = !puede;
        el.title = puede ? '' : 'Solo el administrador puede modificar las tasas';
      }
    });
    var hint = (host && host.querySelector ? host : document).querySelector('[data-tasas-admin-only]');
    if (hint) hint.style.display = puede ? 'none' : '';
    aplicarUIPermisosBcvAuto(host);
  }

  function aplicarUIPermisosRespaldo(host) {
    void host;
    var sch = window.__nexusLastScheduler;
    if (sch) sincronizarFormularioScheduler(sch);
    else sincronizarFormularioScheduler({});
  }

  /* ─── ENVÍO DEFINITIVO DE TASAS (luego de confirmación si aplica) ─── */
  function enviarGuardarTasas(bcv, usd) {
    var btn = document.getElementById('btn-guardar-tasas');
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }

    apiFetch('/api/configuracion/tasas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasa_bcv: bcv, tasa_usd: usd })
    }).then(function (r) {
      return r.ok ? r.json() : r.json().then(function (d) { throw new Error(d.error || 'Error'); });
    }).then(function (data) {
      toast('Tasas actualizadas: BCV ' + n(data.tasa_bcv).toFixed(4) + ' | USD ' + n(data.tasa_usd).toFixed(4), 'success');
      if (window.NexusComponents && typeof window.NexusComponents.saveTasasLocal === 'function') {
        window.NexusComponents.saveTasasLocal(data.tasa_bcv, data.tasa_usd);
      }
      cargarConfig();
      document.getElementById('input-tasa-bcv').value = '';
      document.getElementById('input-tasa-usd').value = '';
    }).catch(function (e) {
      toast(e.message || 'No se pudieron guardar las tasas', 'error');
    }).finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Guardar Tasas'; }
      aplicarUIPermisosTasas(null);
    });
  }

  /* ─── MODAL CONFIRMACIÓN USD ─── */
  function mostrarConfirmacionUsd(bcv, usd, usdActual) {
    var modal = document.getElementById('modal-confirm-tasa-usd');
    var texto = document.getElementById('modal-confirm-tasa-usd-texto');
    if (!modal) { enviarGuardarTasas(bcv, usd); return; }
    var diff = usd - usdActual;
    var pct = usdActual > 0 ? ((Math.abs(diff) / usdActual) * 100).toFixed(2) : '—';
    var direccion = diff >= 0 ? 'subida' : 'bajada';
    var txtDiff = usdActual > 0
      ? ('Cambio: ' + direccion + ' de ' + esc(usdActual.toFixed(4)) + ' → ' + esc(usd.toFixed(4)) + ' (' + (diff >= 0 ? '+' : '') + esc(diff.toFixed(4)) + ', ' + (diff >= 0 ? '+' : '-') + esc(pct) + '%).')
      : ('Nueva tasa USD: ' + esc(usd.toFixed(4)) + '.');
    if (texto) {
      texto.innerHTML =
        'Estás modificando manualmente la <strong>Tasa USD</strong>.<br>' +
        esc(txtDiff) +
        '<br><br>Esta acción queda registrada en el historial de tasas. ¿Confirmas el cambio?';
    }
    modal.style.display = 'flex';

    var btnConfirmar = document.getElementById('btn-confirm-usd-confirmar');
    var btnCancelar = document.getElementById('btn-confirm-usd-cancelar');

    function cerrarModal() {
      modal.style.display = 'none';
      if (btnConfirmar) btnConfirmar.onclick = null;
      if (btnCancelar) btnCancelar.onclick = null;
    }
    if (btnConfirmar) {
      btnConfirmar.onclick = function () {
        cerrarModal();
        enviarGuardarTasas(bcv, usd);
      };
    }
    if (btnCancelar) {
      btnCancelar.onclick = cerrarModal;
    }
    modal.onclick = function (e) {
      if (e.target === modal) cerrarModal();
    };
  }

  /* ─── GUARDAR TASAS ─── */
  function guardarTasas() {
    if (window.NexusAuth && typeof window.NexusAuth.can === 'function' && !window.NexusAuth.can('tasas_edit')) {
      toast('Solo el administrador puede modificar las tasas', 'warning');
      return;
    }

    var bcvInput = parseFloat(
      (document.getElementById('input-tasa-bcv').value || '').replace(',', '.')
    ) || 0;
    var usdInput = parseFloat(
      (document.getElementById('input-tasa-usd').value || '').replace(',', '.')
    ) || 0;

    // Leer valores vigentes desde los displays (cargados desde hydrate)
    var bcvActual = parseFloat(
      ((document.getElementById('display-bcv') || {}).textContent || '0').replace(',', '.')
    ) || 0;
    var usdActual = parseFloat(
      ((document.getElementById('display-usd') || {}).textContent || '0').replace(',', '.')
    ) || 0;

    // Si hydrate aún no completó, caer a localStorage para evitar guardar con 0 (IMPACT-002)
    if (!_tasasDisplayListas || bcvActual <= 0 || usdActual <= 0) {
      var localTasas = window.NexusComponents && window.NexusComponents.loadTasasLocal
        ? window.NexusComponents.loadTasasLocal() : { bcv: 0, usd: 0 };
      if (bcvActual <= 0) bcvActual = localTasas.bcv;
      if (usdActual <= 0) usdActual = localTasas.usd;
    }

    // Usar el input si es válido; si no, conservar el valor vigente
    var bcvFinal = bcvInput > 0 ? bcvInput : bcvActual;
    var usdFinal = usdInput > 0 ? usdInput : usdActual;

    // Validar que al menos uno de los dos inputs tiene valor nuevo
    if (bcvInput <= 0 && usdInput <= 0) {
      toast('Ingresa al menos una tasa válida mayor a 0', 'warning');
      return;
    }

    // Validar que los valores finales sean positivos
    if (bcvFinal <= 0 || usdFinal <= 0) {
      toast('No se pudo determinar una tasa válida. Verifica los valores.', 'warning');
      return;
    }

    // Regla de negocio: USD calle debe ser >= BCV oficial
    if (usdFinal < bcvFinal) {
      toast('La tasa USD debe ser mayor o igual a la tasa BCV', 'warning');
      return;
    }

    var cambioUsd = usdInput > 0 && Math.abs(usdFinal - usdActual) > 0.00005;

    if (cambioUsd) {
      mostrarConfirmacionUsd(bcvFinal, usdFinal, usdActual);
    } else {
      enviarGuardarTasas(bcvFinal, usdFinal);
    }
  }

  /* ─── GUARDAR EMPRESA ─── */
  function guardarEmpresa() {
    var nombre = (document.getElementById('cfg-empresa-nombre').value || '').trim();
    if (!nombre) { toast('El nombre del negocio es obligatorio', 'warning'); return; }

    var Ve = window.NexusTelefonoVe;
    if (!Ve) {
      toast('No se cargó la validación de celular. Recargue la página.', 'warning');
      return;
    }
    var telElEmp = document.getElementById('cfg-empresa-telefono');
    var vt = Ve.validarOpcional(telElEmp ? telElEmp.value : '');
    if (!vt.ok) { toast(vt.mensaje, 'warning'); return; }
    var telNorm = vt.normalizado == null ? '' : vt.normalizado;

    var btn = document.getElementById('btn-guardar-empresa');
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }

    apiFetch('/api/configuracion', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        empresa_nombre:    nombre,
        empresa_rif:            document.getElementById('cfg-empresa-rif').value,
        empresa_telefono:       telNorm,
        empresa_direccion:      document.getElementById('cfg-empresa-direccion').value,
        empresa_email:          document.getElementById('cfg-empresa-email').value,
        // Aliases para el generador de facturas y libros fiscales
        nombre_empresa:         document.getElementById('cfg-empresa-nombre').value,
        rif_empresa:            document.getElementById('cfg-empresa-rif').value,
        telefono_empresa:       telNorm,
        direccion_empresa:      document.getElementById('cfg-empresa-direccion').value,
        email_empresa:          document.getElementById('cfg-empresa-email').value,
        factura_control_desde:  (document.getElementById('cfg-factura-control-desde') || {}).value || '1',
        factura_leyenda:        (document.getElementById('cfg-factura-leyenda') || {}).value || ''
      })
    }).then(function (r) {
      return r.ok ? r.json() : r.json().then(function (d) { throw new Error(d.error || 'Error'); });
    }).then(function () {
      toast('Datos de la empresa guardados', 'success');
      cargarConfig();
    }).catch(function (e) {
      toast(e.message || 'No se pudieron guardar los datos', 'error');
    }).finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Guardar datos de empresa'; }
    });
  }

  /* ─── GUARDAR IMPRESORA ─── */
  function guardarImpresora() {
    var tipo     = document.getElementById('cfg-imp-tipo').value;
    var nombre   = document.getElementById('cfg-imp-nombre').value;
    var interfaz = document.getElementById('cfg-imp-interfaz').value;
    var activa   = tipo !== 'none';

    var btn = document.getElementById('btn-guardar-impresora');
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }

    apiFetch('/api/configuracion', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        impresora_nombre:    nombre,
        impresora_interfaz:  activa ? interfaz : '',
        impresora_activa:    activa ? 'true' : 'false'
      })
    }).then(function (r) {
      return r.ok ? r.json() : r.json().then(function (d) { throw new Error(d.error || 'Error'); });
    }).then(function () {
      toast('Configuración de impresora guardada', 'success');
    }).catch(function (e) {
      toast(e.message || 'No se pudo guardar', 'error');
    }).finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Guardar'; }
    });
  }

  function probarImpresora() {
    var resEl = document.getElementById('imp-resultado');
    if (resEl) { resEl.className = 'cfg-imp-resultado cfg-imp-resultado--info'; resEl.style.display = 'block'; resEl.textContent = 'Enviando prueba a la impresora...'; }

    apiFetch('/api/configuracion/impresora/prueba', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (resEl) {
          if (data.ok) {
            resEl.className = 'cfg-imp-resultado cfg-imp-resultado--ok';
            resEl.textContent = '¡Prueba enviada! Revisa si la impresora imprimió algo.';
          } else {
            var motivo = data.motivo || '';
            var msgAmigable;
            if (motivo.toLowerCase().indexOf('econnrefused') !== -1 || motivo.toLowerCase().indexOf('connect') !== -1) {
              msgAmigable = 'No se puede conectar a la impresora. Verifica que esté encendida y bien configurada.';
            } else if (motivo.indexOf('no está disponible') !== -1 || motivo.indexOf('not available') !== -1) {
              msgAmigable = 'El módulo de impresora no está instalado. Contacta soporte.';
            } else if (motivo.indexOf('desactivada') !== -1) {
              msgAmigable = 'La impresora está desactivada. Actívala en la configuración de impresora.';
            } else if (motivo.indexOf('timeout') !== -1 || motivo.indexOf('timed out') !== -1) {
              msgAmigable = 'La impresora tardó demasiado en responder. Verifica la conexión.';
            } else {
              msgAmigable = 'No se pudo imprimir. Verifica que la impresora esté encendida y conectada.';
            }
            resEl.className = 'cfg-imp-resultado cfg-imp-resultado--err';
            resEl.textContent = msgAmigable;
          }
        }
      })
      .catch(function () {
        if (resEl) { resEl.className = 'cfg-imp-resultado cfg-imp-resultado--err'; resEl.textContent = 'Error de conexión al servidor'; }
      });
  }

  /* ─── USUARIOS ─── */
  function cargarUsuarios() {
    apiFetch('/api/usuarios')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (data) {
        var lista = document.getElementById('usuarios-lista');
        if (!lista) return;
        var usuarios = Array.isArray(data) ? data : (data.data || data.usuarios || []);
        if (!usuarios.length) {
          lista.innerHTML = '<p class="cfg-cargando">No hay usuarios registrados</p>';
          return;
        }
        var colores = ['var(--accent-primary)','var(--accent-success)','var(--accent-warning)','var(--accent-primary)','var(--accent-danger)'];
        lista.innerHTML = usuarios.map(function (u, i) {
          var nombreDisp = u.nombre_completo || u.nombre || u.username || 'U';
          var iniciales = nombreDisp.split(' ').map(function (w) { return w[0]; }).join('').toUpperCase().substring(0, 2);
          var color = colores[i % colores.length];
          var rolLabel = { admin:'Administrador', supervisor:'Supervisor', cajero:'Cajero' }[u.rol] || u.rol;
          return '<div class="usuario-row">' +
            '<div class="usuario-avatar" style="background:' + color + '22;color:' + color + '">' + esc(iniciales) + '</div>' +
            '<div class="usuario-ident"><strong>' + esc(nombreDisp) + '</strong> <span class="usuario-username">@' + esc(u.username) + '</span></div>' +
            '<div class="usuario-rol">' + esc(rolLabel) + '</div>' +
            '<div class="usuario-estado">' + (u.activo !== false ? '<span class="cfg-user-estado cfg-user-estado--activo">Activo</span>' : '<span class="cfg-user-estado cfg-user-estado--inactivo">Inactivo</span>') + '</div>' +
            '<button class="btn-secondary cfg-user-editar" onclick="ConfiguracionPage.editarUsuario(' + u.id + ')">' + SVG_EDIT + ' Editar</button>' +
            '</div>';
        }).join('');
      }).catch(function () {
        toast('No se pudieron cargar los usuarios', 'error');
      });
  }

  function abrirModalUsuario(usuario) {
    document.getElementById('usuario-id').value = usuario ? usuario.id : '';
    document.getElementById('modal-usuario-titulo').textContent = usuario ? 'Editar Usuario' : 'Nuevo Usuario';
    document.getElementById('usuario-nombre').value   = usuario ? (usuario.nombre_completo || usuario.nombre || '') : '';
    document.getElementById('usuario-username').value = usuario ? (usuario.username || '') : '';
    document.getElementById('usuario-password').value = '';
    document.getElementById('usuario-rol').value      = usuario ? (usuario.rol || 'cajero') : 'cajero';

    var lblPass = document.getElementById('lbl-password');
    if (lblPass) lblPass.textContent = usuario ? 'Nueva contraseña (dejar en blanco para no cambiar)' : 'Contraseña *';

    var modal = document.getElementById('modal-usuario');
    if (modal) modal.style.display = 'flex';
    setTimeout(function () { var el = document.getElementById('usuario-nombre'); if (el) el.focus(); }, 100);
  }

  function cerrarModalUsuario() {
    var modal = document.getElementById('modal-usuario');
    if (modal) modal.style.display = 'none';
  }

  function guardarUsuario() {
    var id       = document.getElementById('usuario-id').value;
    var nombre   = (document.getElementById('usuario-nombre').value || '').trim();
    var username = (document.getElementById('usuario-username').value || '').trim();
    var password = document.getElementById('usuario-password').value;
    var rol      = document.getElementById('usuario-rol').value;

    if (!nombre)   { toast('El nombre es obligatorio', 'warning'); return; }
    if (!username) { toast('El nombre de usuario es obligatorio', 'warning'); return; }
    if (!id && (!password || password.length < 6)) { toast('La contraseña debe tener al menos 6 caracteres', 'warning'); return; }

    var payload = { nombre_completo: nombre, username: username, rol: rol };
    if (password) payload.password = password;

    var btn = document.getElementById('btn-guardar-usuario');
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }

    var url    = id ? '/api/usuarios/' + id : '/api/usuarios';
    var method = id ? 'PATCH' : 'POST';

    apiFetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.ok ? r.json() : r.json().then(function (d) { throw new Error(d.error || 'Error'); });
    }).then(function () {
      toast(id ? 'Usuario actualizado' : 'Usuario creado', 'success');
      cerrarModalUsuario();
      cargarUsuarios();
    }).catch(function (e) {
      toast(e.message || 'No se pudo guardar el usuario', 'error');
    }).finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Guardar'; }
    });
  }

  /* ─── RESPALDO ─── */
  function cargarEstadoRespaldo() {
    apiFetch('/api/configuracion/respaldo')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (data) {
        window.__nexusLastScheduler = data.scheduler || null;
        var el = document.getElementById('respaldo-status');
        if (!el) return;
        var bannerPg = '';
        if (data.lastErrorCode === 'pg_dump_version_mismatch') {
          bannerPg =
            '<div class="cfg-pg-warn">' +
            'Versión de <code>pg_dump</code> incompatible con PostgreSQL. ' +
            'Reinicie la app (Nexus busca en <code>Program Files\\PostgreSQL</code>) o defina <code>NEXUS_PG_BIN_DIR</code> en <code>.env</code> con la carpeta <code>bin</code> de la misma versión mayor.' +
            '</div>';
        }
        var estado = '';
        if (data.lastSuccessAt) {
          estado =
            'Último respaldo exitoso: <strong>' +
            esc(new Date(data.lastSuccessAt).toLocaleString('es-VE')) +
            '</strong>';
          el.className = 'cfg-respaldo-status cfg-respaldo-status--ok';
        } else {
          estado = 'No hay respaldos registrados todavía';
          el.className = 'cfg-respaldo-status cfg-respaldo-status--warn';
        }
        var prog = '';
        var sch = data.scheduler;
        if (sch) {
          if (sch.programa_activo === true && sch.efectivo_minutos > 0) {
            prog +=
              '<p class="cfg-respaldo-prog">' +
              'Respaldo automático periódico: cada <strong>' +
              esc(String(sch.efectivo_minutos)) +
              '</strong> min (~' +
              esc(etiquetaIntervaloMin(sch.efectivo_minutos)) +
              ').</p>';
          } else {
            prog +=
              '<p class="cfg-respaldo-prog">' +
              'Respaldo automático periódico desactivado (' +
              (!sch.desde_entorno ? 'base de datos' : '<code>NEXUS_BACKUP_INTERVAL_MINUTES</code> en 0 min') +
              ').</p>';
          }
        }
        el.innerHTML = bannerPg + estado + prog;
        sincronizarFormularioScheduler(sch);
      }).catch(function () {});
  }

  function hacerRespaldo() {
    var btn = document.getElementById('btn-respaldo-manual');
    if (btn) { btn.disabled = true; btn.textContent = 'Creando respaldo...'; }
    apiFetch('/api/configuracion/respaldo/manual', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          toast('Respaldo creado: ' + (data.lastFile || ''), 'success');
          cargarEstadoRespaldo();
        } else {
          toast(data.error || 'No se pudo crear el respaldo', 'error');
        }
      }).catch(function () {
        toast('Error al crear respaldo', 'error');
      }).finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = 'Crear respaldo ahora'; }
      });
  }

  /* ─── LICENCIA ─── */
  var _hwidBundle = null;

  function obtenerHwidBundle() {
    if (_hwidBundle) return Promise.resolve(_hwidBundle);
    if (window.electronAPI && window.electronAPI.invoke) {
      return window.electronAPI.invoke('app:get-hardware-id-bundle').then(function (b) {
        _hwidBundle = {
          hwid: (b && b.hwid) || 'HWID-UNKNOWN',
          hwidCompat: b && b.hwidCompat ? b.hwidCompat : null
        };
        return _hwidBundle;
      }).catch(function () {
        _hwidBundle = { hwid: 'HWID-UNKNOWN', hwidCompat: null };
        return _hwidBundle;
      });
    }
    return Promise.resolve({ hwid: 'HWID-UNKNOWN', hwidCompat: null }).then(function (b) {
      _hwidBundle = b;
      return b;
    });
  }

  function obtenerHwid() {
    return obtenerHwidBundle().then(function (b) { return b.hwid; });
  }

  function cargarLicencia() {
    var iconoInicial = document.getElementById('lic-icono');
    if (iconoInicial && !iconoInicial.innerHTML) { iconoInicial.innerHTML = SVG_LIC_WAIT; iconoInicial.className = 'lic-icono lic-icono--wait'; }
    // Mostrar versión de la app
    var verEl = document.getElementById('lic-app-version');
    if (verEl && window.nexusCore && window.nexusCore.getVersion) {
      window.nexusCore.getVersion().then(function (v) { if (verEl && v) verEl.textContent = 'v' + v; }).catch(function () {});
    } else if (verEl) {
      verEl.textContent = window._APP_VERSION ? 'v' + window._APP_VERSION : '—';
    }

    obtenerHwidBundle().then(function (bundle) {
      var hwid = bundle.hwid;
      var compat = bundle.hwidCompat;
      var hwidEl = document.getElementById('lic-hwid');
      if (hwidEl) hwidEl.textContent = hwid;
      var q = '/api/licencia/estado?hwid=' + encodeURIComponent(hwid);
      if (compat && compat !== hwid) {
        q += '&hwid_compat=' + encodeURIComponent(compat);
      }
      return apiFetch(q);
    }).then(function (r) {
      return r.ok ? r.json() : {};
    }).then(function (data) {
      var iconoEl    = document.getElementById('lic-icono');
      var labelEl    = document.getElementById('lic-estado-label');
      var empresaEl  = document.getElementById('lic-empresa');
      var editionEl  = document.getElementById('lic-edition');
      var expiraEl   = document.getElementById('lic-expira');
      var hwidRegEl  = document.getElementById('lic-hwid-reg');
      var boxEl      = document.getElementById('lic-estado-box');
      var secActEl   = document.getElementById('lic-activar-seccion');
      var secGenEl   = document.getElementById('lic-generar-seccion');

      var prevBanner = document.getElementById('lic-banner-trial');
      if (prevBanner && prevBanner.parentNode) {
        prevBanner.parentNode.removeChild(prevBanner);
      }

      if (data.activada) {
        if (iconoEl) { iconoEl.innerHTML = SVG_LIC_OK; iconoEl.className = 'lic-icono lic-icono--ok'; }
        if (labelEl) { labelEl.textContent = 'Licencia ACTIVA'; labelEl.className = 'lic-estado-label badge badge-success'; }
        if (boxEl) { boxEl.className = 'lic-estado-box lic-estado-box--success'; }
        if (empresaEl) empresaEl.textContent = data.empresa || '';
        if (editionEl) editionEl.textContent = data.edition || 'Profesional';
        if (expiraEl) {
          var rawExp = data.expira != null && data.expira !== '' ? data.expira : 'Perpetua';
          expiraEl.textContent =
            typeof window.formatExpiraLicenciaUi === 'function'
              ? window.formatExpiraLicenciaUi(rawExp)
              : rawExp || 'Perpetua';
          expiraEl.removeAttribute('title');
          if (
            rawExp &&
            String(rawExp).trim() &&
            !/^perpetua$/i.test(String(rawExp))
          ) {
            var du = new Date(rawExp);
            if (!Number.isNaN(du.getTime())) {
              expiraEl.title =
                'Referencia en UTC (técnico): ' +
                du.toISOString() +
                '. La hora mostrada arriba es la de tu zona horaria.';
            }
          }
        }
        if (hwidRegEl) hwidRegEl.textContent = data.hwid_registrado || data.hwid_actual || '—';
        // Ocultar sección activar si ya está activa
        if (secActEl) secActEl.style.display = 'none';

        if (data.esTrial && data.horasRestantes != null) {
          var diasR = Math.floor(data.horasRestantes / 24);
          var horasR = data.horasRestantes % 24;
          var textoT = diasR > 0 ? diasR + 'd ' + horasR + 'h restantes' : data.horasRestantes + 'h restantes';
          var bannerUrgent = data.horasRestantes <= 6;
          var bannerT = document.createElement('div');
          bannerT.id = 'lic-banner-trial';
          bannerT.className = 'lic-banner-trial ' + (bannerUrgent ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-warning');
          bannerT.innerHTML =
            '<strong>Modo de prueba</strong> — ' +
            textoT +
            '. Para activar la licencia completa contacta a tu proveedor.';
          if (boxEl && boxEl.parentNode) {
            boxEl.parentNode.insertBefore(bannerT, boxEl);
          }
        }
      } else {
        if (iconoEl) { iconoEl.innerHTML = SVG_LIC_WARN; iconoEl.className = 'lic-icono lic-icono--warn'; }
        if (labelEl) { labelEl.textContent = 'Sin Licencia Activa'; labelEl.className = 'lic-estado-label badge badge-warning'; }
        if (boxEl) { boxEl.className = 'lic-estado-box lic-estado-box--warning'; }
        if (empresaEl) empresaEl.textContent = data.motivo || '';
        if (editionEl) editionEl.textContent = '—';
        if (expiraEl)  expiraEl.textContent  = '—';
        if (hwidRegEl) hwidRegEl.textContent = '—';
        if (secActEl) secActEl.style.display = '';
      }

      // Mostrar generador solo si es admin (heurística: hwid coincide con el registrado o no hay registrado)
      var esAdmin = window.NexusAuth && window.NexusAuth.getUser &&
                    (window.NexusAuth.getUser().rol === 'admin');
      if (secGenEl) secGenEl.style.display = esAdmin ? '' : 'none';
    }).catch(function () {
      var labelEl = document.getElementById('lic-estado-label');
      if (labelEl) { labelEl.textContent = 'Error al verificar licencia'; labelEl.className = 'lic-estado-label badge badge-danger'; }
    });
  }

  function activarLicencia() {
    var claveInput = document.getElementById('lic-clave-input');
    var clave = claveInput ? claveInput.value.trim() : '';
    if (!clave) { toast('Ingresa la clave de licencia', 'error'); return; }

    obtenerHwidBundle().then(function (bundle) {
      var body = { clave: clave, hwid: bundle.hwid };
      if (bundle.hwidCompat && bundle.hwidCompat !== bundle.hwid) {
        body.hwid_compat = bundle.hwidCompat;
      }
      return apiFetch('/api/licencia/activar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Error al activar');
        return d;
      });
    }).then(function (data) {
      toast(data.message || 'Licencia activada', 'success');
      if (claveInput) claveInput.value = '';
      cargarLicencia();
    }).catch(function (e) {
      toast(e.message || 'No se pudo activar la licencia', 'error');
    });
  }

  function generarClave() {
    var hwid    = (document.getElementById('lic-gen-hwid')    || {}).value || '';
    var empresa = (document.getElementById('lic-gen-empresa') || {}).value || '';
    var expira  = (document.getElementById('lic-gen-expira')  || {}).value || '';
    if (!hwid.trim()) { toast('El Hardware ID del cliente es obligatorio', 'error'); return; }

    apiFetch('/api/licencia/generar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hwid: hwid.trim(), empresa: empresa.trim(), expiraEn: expira || null })
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Error al generar');
        return d;
      });
    }).then(function (data) {
      var resDiv  = document.getElementById('lic-gen-resultado');
      var claveEl = document.getElementById('lic-gen-clave-output');
      if (claveEl) claveEl.textContent = data.clave;
      if (resDiv) resDiv.style.display = '';
    }).catch(function (e) {
      toast(e.message || 'No se pudo generar la clave', 'error');
    });
  }

  /* ─── MOUNT ─── */
  window.ConfiguracionPage = {
    mount: function (host) {
      // Tabs
      host.querySelectorAll('.cfg-tab').forEach(function (tab) {
        tab.addEventListener('click', function () {
          var target = tab.getAttribute('data-tab');
          host.querySelectorAll('.cfg-tab').forEach(function (t) { t.classList.remove('activo'); });
          host.querySelectorAll('.cfg-panel').forEach(function (p) { p.classList.remove('activo'); });
          tab.classList.add('activo');
          var panel = host.querySelector('#panel-' + target);
          if (panel) panel.classList.add('activo');

          // Cargar datos del tab según necesidad
          if (target === 'usuarios') cargarUsuarios();
          if (target === 'respaldo') cargarEstadoRespaldo();
          if (target === 'licencia') cargarLicencia();
        });
      });

      // Tasas
      var btnTasas = host.querySelector('#btn-guardar-tasas');
      if (btnTasas) btnTasas.addEventListener('click', guardarTasas);
      var btnBcvAuto = host.querySelector('#btn-guardar-bcv-auto');
      if (btnBcvAuto) btnBcvAuto.addEventListener('click', guardarProgramaBcvAuto);
      var btnBcvSync = host.querySelector('#btn-bcv-auto-sync');
      if (btnBcvSync) btnBcvSync.addEventListener('click', consultarBcvAutoAhora);
      var btnBcvForzar = host.querySelector('#btn-bcv-auto-forzar');
      if (btnBcvForzar) btnBcvForzar.addEventListener('click', forzarAplicarBcvAhora);

      // Empresa
      var btnEmpresa = host.querySelector('#btn-guardar-empresa');
      if (btnEmpresa) btnEmpresa.addEventListener('click', guardarEmpresa);

      var telEmpIn = host.querySelector('#cfg-empresa-telefono');
      if (telEmpIn && window.NexusTelefonoVe) window.NexusTelefonoVe.enlazarInput(telEmpIn);

      // Impresora
      var btnImp = host.querySelector('#btn-guardar-impresora');
      if (btnImp) btnImp.addEventListener('click', guardarImpresora);
      var btnProbar = host.querySelector('#btn-probar-impresora');
      if (btnProbar) btnProbar.addEventListener('click', probarImpresora);

      // Tipo impresora toggle
      var tipoEl = host.querySelector('#cfg-imp-tipo');
      if (tipoEl) {
        tipoEl.addEventListener('change', function () {
          var wrap = host.querySelector('#cfg-imp-tcp-wrap');
          if (wrap) wrap.style.display = tipoEl.value === 'none' ? 'none' : 'block';
        });
      }

      // Usuarios
      var btnNuevoUsuario = host.querySelector('#btn-nuevo-usuario');
      if (btnNuevoUsuario) btnNuevoUsuario.addEventListener('click', function () { abrirModalUsuario(null); });
      host.querySelector('#btn-cerrar-modal-usuario').addEventListener('click', cerrarModalUsuario);
      host.querySelector('#btn-cancelar-modal-usuario').addEventListener('click', cerrarModalUsuario);
      host.querySelector('#btn-guardar-usuario').addEventListener('click', guardarUsuario);

      // Respaldo
      var btnRespaldo = host.querySelector('#btn-respaldo-manual');
      if (btnRespaldo) btnRespaldo.addEventListener('click', hacerRespaldo);

      var btnSched = host.querySelector('#btn-guardar-backup-sched');
      if (btnSched) btnSched.addEventListener('click', guardarProgramaBackup);

      // Licencia
      var btnCopiarHwid = host.querySelector('#btn-copiar-hwid');
      if (btnCopiarHwid) btnCopiarHwid.addEventListener('click', function () {
        var hwid = (document.getElementById('lic-hwid') || {}).textContent || '';
        if (hwid && hwid !== '—') {
          navigator.clipboard.writeText(hwid).then(function () { toast('Hardware ID copiado', 'success'); });
        }
      });

      var btnActivar = host.querySelector('#btn-activar-licencia');
      if (btnActivar) btnActivar.addEventListener('click', activarLicencia);

      var btnGenerar = host.querySelector('#btn-generar-clave');
      if (btnGenerar) btnGenerar.addEventListener('click', generarClave);

      var btnCopiarGen = host.querySelector('#btn-copiar-gen-clave');
      if (btnCopiarGen) btnCopiarGen.addEventListener('click', function () {
        var clave = (document.getElementById('lic-gen-clave-output') || {}).textContent || '';
        if (clave) navigator.clipboard.writeText(clave).then(function () { toast('Clave copiada', 'success'); });
      });

      cargarConfig();
      aplicarUIPermisosTasas(host);
      aplicarUIPermisosRespaldo(host);
    },
    editarUsuario: function (id) {
      apiFetch('/api/usuarios/' + id)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (u) { if (u) abrirModalUsuario(u); })
        .catch(function () { toast('No se pudo cargar el usuario', 'error'); });
    }
  };
})();
