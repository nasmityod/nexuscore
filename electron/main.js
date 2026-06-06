'use strict';

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, dialog, nativeImage } = require('electron');
const {
  loadNexusEnv,
  needsFirstRunSetup,
  normalizeSetupPayload,
  testPostgresConnection,
  saveUserConfigEnv,
  getSetupDefaults,
  applySavedConfigToProcess,
  getUserConfigEnvPath
} = require('./setupConfig');
const LOG_PREFIX = '[nexus-core]';

// userData/config.env (asistente) → .env del proyecto (dev) → defaults
loadNexusEnv(app);

// Debe ejecutarse antes de crear ventanas (agrupación e icono en barra de tareas en Windows).
if (process.platform === 'win32') {
  app.setAppUserModelId('com.nexuscore.pos');
}

let cachedAppIcon = null;

/**
 * Windows empaquetado: el .exe ya lleva icon.ico (electron-builder).
 * setIcon() desde PNG suele mostrar el placeholder genérico en la barra.
 */
function useEmbeddedExeTaskbarIcon() {
  return app.isPackaged && process.platform === 'win32';
}

function getBrowserWindowIcon() {
  if (useEmbeddedExeTaskbarIcon()) return undefined;
  return loadAppIcon() || undefined;
}

/** Rutas .png/.ico para setIcon (nativeImage no puede leer el .exe). */
function getAppIconCandidates() {
  const list = [];
  if (app.isPackaged && process.resourcesPath) {
    list.push(
      path.join(process.resourcesPath, 'branding', 'icon.png'),
      path.join(process.resourcesPath, 'branding', 'icon.ico')
    );
  }
  const projectRoot = path.resolve(__dirname, '..');
  list.push(
    path.join(projectRoot, 'build-resources', 'icon.png'),
    path.join(projectRoot, 'build-resources', 'icon.ico')
  );
  return list;
}

function loadAppIcon() {
  if (cachedAppIcon) return cachedAppIcon;
  for (const iconPath of getAppIconCandidates()) {
    if (!fsSync.existsSync(iconPath)) continue;
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) {
      cachedAppIcon = img;
      return cachedAppIcon;
    }
    console.warn(`${LOG_PREFIX} Icono vacío: ${iconPath}`);
  }
  console.warn(
    `${LOG_PREFIX} Sin icono de app — ejecuta "npm run icons" y vuelve a empaquetar`
  );
  return null;
}

function applyWindowIcon(win) {
  if (useEmbeddedExeTaskbarIcon()) return;
  const icon = loadAppIcon();
  if (icon && win && !win.isDestroyed()) {
    win.setIcon(icon);
  }
}

/**
 * Rechaza con un error de timeout si `promise` no resuelve en `ms` milisegundos.
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `Timeout (${ms / 1000}s) esperando: ${label}.\n` +
        'Revisa la consola de Electron (DevTools → Main Process) para ver los logs técnicos.'
      ));
    }, ms);

    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

/**
 * Carpeta de respaldos en userData. pg_dump se resuelve en el backend (pgDumpResolver)
 * contra la versión real del servidor — no se fuerza database/postgres del repo.
 */
function applyNexusBackupEnv() {
  try {
    const userData = app.getPath('userData');
    process.env.NEXUS_BACKUP_DIR = path.join(userData, 'backups');
    console.log(`${LOG_PREFIX} NEXUS_BACKUP_DIR = ${process.env.NEXUS_BACKUP_DIR}`);

    const envDump = process.env.NEXUS_PG_DUMP && String(process.env.NEXUS_PG_DUMP).trim();
    const envBin = process.env.NEXUS_PG_BIN_DIR && String(process.env.NEXUS_PG_BIN_DIR).trim();
    if (envDump || envBin) {
      console.log(
        `${LOG_PREFIX} Respaldos: NEXUS_PG_DUMP / NEXUS_PG_BIN_DIR desde .env; el backend validará compatibilidad con el servidor.`
      );
    } else {
      console.log(
        `${LOG_PREFIX} Respaldos: pg_dump se detectará al conectar (Program Files\\PostgreSQL\\<versión>\\bin, PATH, etc.).`
      );
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} applyNexusBackupEnv:`, err.message);
  }
}

applyNexusBackupEnv();

/** Backend se carga tras el asistente para que PG_* estén definidos. */
let backendModule = null;
function getBackendModule() {
  if (!backendModule) {
    backendModule = require('../backend/server');
  }
  return backendModule;
}
function startBackend() {
  return getBackendModule().start();
}
function shutdownBackend() {
  return getBackendModule().shutdown();
}

const isDev = !app.isPackaged;

/** true si NEXUS_DEVTOOLS=1 (pruebas en .exe instalado). */
function isDevToolsEnabled() {
  if (isDev) return true;
  const v = String(process.env.NEXUS_DEVTOOLS || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function openDevToolsDetached(webContents, label) {
  if (!isDevToolsEnabled() || !webContents || webContents.isDestroyed()) return;
  webContents.openDevTools({ mode: 'detach' });
  if (!isDev) {
    console.log(`${LOG_PREFIX} DevTools abiertas (${label}) — NEXUS_DEVTOOLS activo`);
  }
}

function toggleDevTools(webContents) {
  if (!isDevToolsEnabled() || !webContents || webContents.isDestroyed()) return;
  if (webContents.isDevToolsOpened()) {
    webContents.closeDevTools();
  } else {
    webContents.openDevTools({ mode: 'detach' });
  }
}

let appShuttingDown = false;

let mainWindow = null;
let splashWindow = null;
let setupWindow = null;
/** @type {((ok: boolean) => void) | null} */
let pendingSetupFinish = null;
/** @type {1 | 2} */
let setupWindowStartStep = 1;
/** Backend ya arrancó durante el wizard (evita doble start). */
let startupBackendPreloaded = false;
/** Motivo de licencia inactiva (p. ej. trial expirado) para el paso 2 del wizard. */
let pendingLicenseReason = null;

/** Evita app.quit() cuando aún no existe la ventana principal (p. ej. al cerrar solo la activación). */
let mainWindowLifecycleStarted = false;

function getPreloadPath() {
  return path.join(__dirname, 'preload.js');
}

function getIndexHtmlPath() {
  return path.join(__dirname, '..', 'frontend', 'index.html');
}

function getSplashPreloadPath() {
  return path.join(__dirname, 'preload-splash.js');
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 600,
    height: 400,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    icon: getBrowserWindowIcon(),
    webPreferences: {
      preload: getSplashPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const splashPath = path.join(__dirname, '..', 'frontend', 'splash.html');
  splashWindow.loadFile(splashPath).catch((err) => {
    console.error(`${LOG_PREFIX} No se pudo cargar splash screen:`, err);
  });

  splashWindow.on('closed', () => {
    splashWindow = null;
  });
  applyWindowIcon(splashWindow);
}

function updateSplashStatus(status, progress) {
  console.log(`${LOG_PREFIX} [splash] ${status} (${progress}%)`);
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('splash:status', { status, progress });
  }
}

function showSplashError(error, technicalLog) {
  const message = error && error.message ? error.message : String(error);
  console.error(`${LOG_PREFIX} [splash:error] ${message}`);
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('splash:error', { message, technicalLog: technicalLog || '' });
  }
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
    splashWindow = null;
  }
}

// ── Asistente de primera ejecución (PostgreSQL) ─────────────────────────

function createSetupWindow(options = {}) {
  const start = Number(options.startStep);
  setupWindowStartStep = start === 2 ? 2 : (start === 3 ? 3 : 1);
  if (setupWindowStartStep === 1) {
    pendingLicenseReason = null;
  }

  return new Promise((resolve) => {
    pendingSetupFinish = resolve;

    const onLicenseActivated = () => {
      if (setupWindow && !setupWindow.isDestroyed()) {
        finishSetupWindow(true);
      }
    };
    ipcMain.once('license:activated', onLicenseActivated);

    setupWindow = new BrowserWindow({
      width: 520,
      height: 820,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      icon: getBrowserWindowIcon(),
      title: 'Nexus Core · Instalación',
      webPreferences: {
        preload: path.join(__dirname, 'preload-setup.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });

    setupWindow.loadFile(
      path.join(__dirname, '..', 'frontend', 'setup.html')
    ).catch((err) => {
      console.error(`${LOG_PREFIX} No se pudo cargar setup.html:`, err);
    });
    applyWindowIcon(setupWindow);

    openDevToolsDetached(setupWindow.webContents, 'asistente instalación');

    setupWindow.on('closed', () => {
      setupWindow = null;
      ipcMain.removeListener('license:activated', onLicenseActivated);
      if (pendingSetupFinish) {
        const finish = pendingSetupFinish;
        pendingSetupFinish = null;
        finish(false);
      }
    });
  });
}

function finishSetupWindow(ok) {
  if (!pendingSetupFinish) return;
  const finish = pendingSetupFinish;
  pendingSetupFinish = null;
  if (ok) pendingLicenseReason = null;

  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.removeAllListeners('closed');
    setupWindow.once('closed', () => finish(ok));
    setupWindow.close();
  } else {
    finish(ok);
  }
}

function registerSetupIpc() {
  ipcMain.handle('setup:get-initial-step', () => ({
    step: setupWindowStartStep,
    dbDone: setupWindowStartStep >= 2,
    renewalOnly: setupWindowStartStep === 2,
    adminOnly: setupWindowStartStep === 3,
    licenseReason: pendingLicenseReason
  }));

  ipcMain.handle('setup:get-defaults', () => getSetupDefaults(app));

  ipcMain.handle('setup:test-connection', async (_evt, raw) => {
    try {
      const cfg = normalizeSetupPayload(raw);
      return await testPostgresConnection(cfg);
    } catch (err) {
      return { ok: false, message: err.message || 'Datos inválidos.' };
    }
  });

  ipcMain.handle('setup:prepare-license-step', async () => {
    try {
      if (!backendModule) {
        await withTimeout(startBackend(), 60_000, 'Inicio del servidor backend');
      }
      startupBackendPreloaded = true;
      const { ok: licenseActive } = await checkLicense();
      return { ok: true, licenseActive };
    } catch (err) {
      startupBackendPreloaded = false;
      backendModule = null;
      return { ok: false, message: err.message || 'No se pudo iniciar el sistema.' };
    }
  });

  ipcMain.handle('setup:save-and-continue', async (_evt, raw) => {
    try {
      const cfg = normalizeSetupPayload(raw);
      const test = await testPostgresConnection(cfg);
      if (!test.ok) {
        return { ok: false, message: test.message };
      }
      await saveUserConfigEnv(app, cfg);
      applySavedConfigToProcess(app);
      applyNexusBackupEnv();

      // Si el backend ya estaba corriendo (p. ej. el usuario volvió al paso 1
      // para corregir la config PG), apagarlo limpiamente antes de reiniciar
      // con la nueva configuración para evitar EADDRINUSE.
      if (startupBackendPreloaded && backendModule) {
        console.log(`${LOG_PREFIX} Backend previo detectado — reiniciando con nueva configuración PG.`);
        try {
          await withTimeout(shutdownBackend(), 8000, 'Apagado backend previo');
        } catch (shutErr) {
          console.warn(`${LOG_PREFIX} Apagado previo con advertencia:`, shutErr.message);
        }
        startupBackendPreloaded = false;
        backendModule = null;
      } else {
        backendModule = null;
      }

      await withTimeout(startBackend(), 60_000, 'Inicio del servidor backend');
      startupBackendPreloaded = true;
      const { ok: licenseActive } = await checkLicense();
      return { ok: true, licenseActive, message: test.message };
    } catch (err) {
      startupBackendPreloaded = false;
      backendModule = null;
      return { ok: false, message: err.message || 'No se pudo guardar la configuración.' };
    }
  });

  ipcMain.handle('setup:open-postgres-help', async () => {
    await shell.openExternal('https://www.postgresql.org/download/windows/');
  });
}

// ── Ventana de Activación de Licencia ─────────────────────────────────────

let activationWindow = null;

function createActivationWindow() {
  return new Promise((resolve) => {
    let settled = false;

    activationWindow = new BrowserWindow({
      width:            520,
      height:           680,
      resizable:        false,
      maximizable:      false,
      fullscreenable:   false,
      autoHideMenuBar:  true,
      icon:             getBrowserWindowIcon(),
      title:            'Nexus Core · Activación de Licencia',
      webPreferences: {
        preload:          path.join(__dirname, 'preload-activation.js'),
        contextIsolation: true,
        nodeIntegration:  false,
        sandbox:          false,
      },
    });

    activationWindow.loadFile(
      path.join(__dirname, '..', 'frontend', 'activation.html')
    ).catch((err) => {
      console.error(`${LOG_PREFIX} No se pudo cargar activation.html:`, err);
    });
    applyWindowIcon(activationWindow);

    openDevToolsDetached(activationWindow.webContents, 'activación licencia');

    // El renderer envía este evento cuando la activación es exitosa
    ipcMain.once('license:activated', () => {
      console.log(`${LOG_PREFIX} Licencia activada — abriendo aplicación principal.`);
      settled = true;
      if (activationWindow && !activationWindow.isDestroyed()) {
        activationWindow.close();
      }
      activationWindow = null;
      resolve(true);
    });

    activationWindow.on('closed', () => {
      activationWindow = null;
      // Cierre sin activar: no dejar la promesa colgada ni el proceso sin ventanas sin salir
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });
  });
}

/**
 * HWID estable (MACs ordenadas + CPU + hostname) y variante legado (primera MAC según orden del SO).
 * Las licencias antiguas usan solo la primera interfaz; si Windows cambia el orden entre reinicios,
 * el HWID legado ya no coincide — por eso intentamos ambos al validar.
 */
function computeHardwareIdCandidates() {
  const os     = require('os');
  const crypto = require('crypto');
  const ifaces = os.networkInterfaces();
  const cpus   = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model : 'unknown';
  const hostname = os.hostname();

  let macLegacy = '';
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        macLegacy = iface.mac;
        break;
      }
    }
    if (macLegacy) break;
  }
  const rawLegacy = `${macLegacy}|${cpuModel}|${hostname}`;
  const hwidLegacy = crypto.createHash('sha256').update(rawLegacy).digest('hex').slice(0, 24).toUpperCase();

  const macSet = new Set();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        macSet.add(iface.mac.toLowerCase());
      }
    }
  }
  const sortedMacs = [...macSet].sort();
  const rawStable = `${sortedMacs.join(',')}|${cpuModel}|${hostname}`;
  const hwidStable = crypto.createHash('sha256').update(rawStable).digest('hex').slice(0, 24).toUpperCase();

  if (hwidStable === hwidLegacy) return [hwidStable];
  return [hwidStable, hwidLegacy];
}

function licenciaEstadoPath(ids) {
  const primary = ids[0];
  const compat = ids[1];
  if (compat && compat !== primary) {
    return `/api/licencia/estado?hwid=${encodeURIComponent(primary)}&hwid_compat=${encodeURIComponent(compat)}`;
  }
  return `/api/licencia/estado?hwid=${encodeURIComponent(primary)}`;
}

/**
 * Comprueba la licencia contra el backend local.
 * @returns {{ ok: boolean, estado: object | null }}
 */
async function fetchSetupAdminEstado() {
  try {
    const res = await fetch('http://127.0.0.1:3000/api/setup/estado');
    if (!res.ok) return { adminPendiente: true };
    return await res.json();
  } catch (_e) {
    return { adminPendiente: true };
  }
}

async function checkLicense() {
  try {
    const ids = computeHardwareIdCandidates();
    const pathQuery = licenciaEstadoPath(ids);
    const http = require('http');
    const hwidLog = ids.filter(Boolean).join('+');

    let lastNetErr = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const resp = await new Promise((resolve, reject) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port: 3000,
              path: pathQuery,
              method: 'GET',
              timeout: 8000
            },
            (res) => {
              let data = '';
              res.on('data', (chunk) => { data += chunk; });
              res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (_e) { resolve({ activada: false, motivo: 'Respuesta JSON inválida del backend' }); }
              });
            }
          );
          req.on('error', reject);
          req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
          });
          req.end();
        });

        if (resp && resp.activada === true) {
          const exp = resp.expira != null && resp.expira !== '' ? resp.expira : '—';
          const emp = resp.empresa != null && resp.empresa !== '' ? resp.empresa : '—';
          console.log(
            `${LOG_PREFIX} [licencia] estado=activa hwid=${resp.hwid_actual || ids[0]} expira=${exp} empresa=${emp}`
          );
          return { ok: true, estado: resp };
        }

        const motivo = resp && resp.motivo ? String(resp.motivo) : '(sin motivo en respuesta)';
        console.warn(`${LOG_PREFIX} [licencia] estado=inactiva hwids=${hwidLog} motivo=${motivo}`);
        if (/expirada/i.test(motivo)) {
          console.warn(
            `${LOG_PREFIX} [licencia] Licencia expirada (campo ex del token) — solicita una nueva clave al distribuidor ` +
            `(servidor de licencias configurado en NEXUS_LICENSE_SERVER_URL / build).`
          );
        } else if (resp && resp.clave_presente && /otro equipo/i.test(motivo)) {
          console.warn(
            `${LOG_PREFIX} [licencia] La clave guardada en BD es de otro equipo. ` +
            `Actualizar solo licencia_hwid en PostgreSQL no sirve: el token NC1 lleva el hash fijo en el payload. ` +
            `Reactiva con un código emitido para este HWID o usa la BD del equipo original.`
          );
        }
        return { ok: false, estado: resp || null };
      } catch (e) {
        lastNetErr = e;
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }

    console.warn(
      `${LOG_PREFIX} [licencia] estado=error hwids=${hwidLog} ` +
      `sin respuesta HTTP tras reintentos: ${lastNetErr && lastNetErr.message}`
    );
    return { ok: false, estado: null };
  } catch (e) {
    console.warn(`${LOG_PREFIX} checkLicense error:`, e.message);
    return { ok: false, estado: null };
  }
}

function createMainWindow() {
  mainWindowLifecycleStarted = true;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 768,
    show: false,
    fullscreen: false,
    fullscreenable: true,
    autoHideMenuBar: true,
    icon: getBrowserWindowIcon(),
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
      // webSecurity no se deshabilita; el backend Express expone cabeceras CORS
      // que permiten el origen null (file://) y localhost explícitamente.
    }
  });

  // F11 → alternar pantalla completa
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F11' && input.type === 'keyDown') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
    if (input.key === 'F12' && input.type === 'keyDown' && isDevToolsEnabled()) {
      toggleDevTools(mainWindow.webContents);
    }
    // Desactivar menú contextual (click derecho) en producción sin NEXUS_DEVTOOLS
    if (!isDevToolsEnabled() && input.type === 'mouseDown' && input.button === 'right') {
      event.preventDefault();
    }
  });

  mainWindow.once('ready-to-show', () => {
    applyWindowIcon(mainWindow);
    closeSplash();
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('close', () => {
    // Limpiar sesión del renderer antes de cerrar
    // para que la próxima apertura siempre pida credenciales
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(
        'window.NexusAuth && window.NexusAuth.clearSession && window.NexusAuth.clearSession()'
      ).catch(function () {});
    }
  });

  const indexFile = getIndexHtmlPath();
  mainWindow.loadFile(indexFile).catch((err) => {
    console.error(`${LOG_PREFIX} No se pudo cargar la ventana principal:`, err);
  });

  openDevToolsDetached(mainWindow.webContents, 'ventana principal');
}

function registerBasicIpc() {
  // URL del servidor de licencias (Vercel).
  // Cámbiala por tu URL real después de desplegar:  https://tu-proyecto.vercel.app
  const NEXUS_LICENSE_SERVER_URL = process.env.NEXUS_LICENSE_SERVER_URL
    || 'https://nexuscore-iota.vercel.app';

  ipcMain.handle('license:get-server-url', () => NEXUS_LICENSE_SERVER_URL);

  ipcMain.handle('app:get-path', (_evt, name) => app.getPath(name));

  ipcMain.handle('window:focus', () => {
    if (mainWindow) {
      mainWindow.focus();
      mainWindow.webContents.focus();
    }
  });

  ipcMain.handle('window:steal-focus', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    app.focus({ steal: true });
    mainWindow.focus();
    mainWindow.webContents.focus();
  });

  ipcMain.handle('app:get-hardware-id', async () => {
    try {
      return computeHardwareIdCandidates()[0];
    } catch (e) {
      return 'HWID-UNKNOWN';
    }
  });

  ipcMain.handle('app:get-hardware-id-bundle', async () => {
    try {
      const ids = computeHardwareIdCandidates();
      return {
        hwid: ids[0],
        hwidCompat: ids.length > 1 ? ids[1] : null
      };
    } catch (e) {
      return { hwid: 'HWID-UNKNOWN', hwidCompat: null };
    }
  });

  ipcMain.handle('pdf:open-buffer', async (_evt, arrayBuffer) => {
    const buf = Buffer.from(arrayBuffer);
    const target = path.join(app.getPath('temp'), `nexus-comprobante-${Date.now()}.pdf`);
    await fs.writeFile(target, buf);
    const errMsg = await shell.openPath(target);
    if (errMsg) {
      throw new Error(errMsg);
    }
    return target;
  });

  // Versión de la app (para mostrar en UI y verificaciones de licencia)
  ipcMain.handle('app:get-version', () => app.getVersion());

  // Abrir URL externa en navegador del sistema
  ipcMain.handle('app:open-external', (_evt, url) => {
    const parsed = new URL(url);
    if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
      shell.openExternal(url);
    }
  });
}

function buildStartupDiagnostic(err) {
  const msg = err && err.message ? err.message : String(err);
  return {
    message: msg,
    technicalLog:
      '─── Diagnóstico ───\n' +
      `PG_HOST=${process.env.PG_HOST || '127.0.0.1'}\n` +
      `PG_PORT=${process.env.PG_PORT || '5432'}\n` +
      `PG_DATABASE=${process.env.PG_DATABASE || 'nexuscore'}\n` +
      `PG_USER=${process.env.PG_USER || 'postgres'}\n` +
      `Config: ${getUserConfigEnvPath(app)}\n\n` +
      'Verifica que el servicio "postgresql-x64-XX" esté en ejecución\n' +
      '(Servicios de Windows) y que la base/usuario/contraseña coincidan\n' +
      'con la configuración guardada.'
  };
}

async function runStartupSequence() {
  updateSplashStatus('Verificando PostgreSQL...', 10);

  if (!startupBackendPreloaded) {
    updateSplashStatus('Iniciando servidor backend...', 30);
    await withTimeout(startBackend(), 60_000, 'Inicio del servidor backend');
  } else {
    console.log(`${LOG_PREFIX} Backend ya iniciado en instalación — omitiendo arranque duplicado.`);
    startupBackendPreloaded = false;
    updateSplashStatus('Servidor backend listo...', 30);
  }

  updateSplashStatus('Aplicando migraciones...', 70);
  await new Promise((resolve) => setTimeout(resolve, 200));

  updateSplashStatus('Verificando licencia...', 85);
  const { ok: licenciaOk, estado: licenciaEstado } = await checkLicense();

  if (licenciaOk && licenciaEstado && licenciaEstado.esTrial) {
    const hrs = licenciaEstado.horasRestantes;
    console.warn(
      `${LOG_PREFIX} [licencia] MODO PRUEBA — Vence en ${hrs != null ? hrs : '?'}h (${licenciaEstado.expira || '—'})`
    );
    if (hrs != null && hrs <= 6) {
      await dialog.showMessageBox({
        type: 'warning',
        title: 'Licencia de prueba por vencer',
        message: `Tu período de prueba vence en ${hrs} hora(s).`,
        detail:
          'Contacta a tu proveedor para activar la licencia completa y continuar usando el sistema sin interrupciones.',
        buttons: ['Entendido']
      });
    }
  }

  if (!licenciaOk) {
    pendingLicenseReason =
      licenciaEstado && licenciaEstado.motivo ? String(licenciaEstado.motivo) : null;
    console.log(
      `${LOG_PREFIX} Licencia inactiva — paso 2 del asistente` +
      (pendingLicenseReason ? ` (${pendingLicenseReason})` : '.')
    );
    updateSplashStatus('Se requiere activación...', 90);
    await new Promise((resolve) => setTimeout(resolve, 300));
    closeSplash();
    const activated = await createSetupWindow({ startStep: 2 });
    if (!activated) {
      console.log(`${LOG_PREFIX} Activación cancelada o ventana cerrada — saliendo.`);
      app.quit();
      return;
    }
    pendingLicenseReason = null;
    if (!splashWindow || splashWindow.isDestroyed()) {
      createSplashWindow();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } else {
    console.log(`${LOG_PREFIX} Licencia válida — continuando.`);
    const adminEstado = await fetchSetupAdminEstado();
    if (adminEstado && adminEstado.adminPendiente) {
      console.log(`${LOG_PREFIX} Falta crear administrador — paso 3 del asistente.`);
      updateSplashStatus('Configurar administrador...', 88);
      await new Promise((resolve) => setTimeout(resolve, 300));
      closeSplash();
      const adminDone = await createSetupWindow({ startStep: 3 });
      if (!adminDone) {
        console.log(`${LOG_PREFIX} Configuración de administrador cancelada — saliendo.`);
        app.quit();
        return;
      }
      if (!splashWindow || splashWindow.isDestroyed()) {
        createSplashWindow();
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  updateSplashStatus('Cargando interfaz...', 95);
  await new Promise((resolve) => setTimeout(resolve, 200));

  updateSplashStatus('¡Listo!', 100);
  await new Promise((resolve) => setTimeout(resolve, 300));

  console.log(`${LOG_PREFIX} Secuencia de inicio completada. Abriendo ventana principal.`);
  createMainWindow();
}

async function handleStartupFailure(err) {
  const diag = buildStartupDiagnostic(err);
  console.error(`${LOG_PREFIX} *** ERROR DE INICIO ***`);
  console.error(diag.message);

  showSplashError({ message: diag.message }, diag.technicalLog);

  await new Promise((resolve) => setTimeout(resolve, 800));

  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'Nexus Core — Error de inicio',
    message: 'No se pudo conectar a PostgreSQL o iniciar el sistema.',
    detail: `${diag.message}\n\nPuedes reconfigurar la conexión o salir.`,
    buttons: ['Reconfigurar conexión', 'Salir'],
    defaultId: 0,
    cancelId: 1
  });

  closeSplash();

  if (response === 0) {
    const reconfigured = await createSetupWindow();
    if (reconfigured) {
      applySavedConfigToProcess(app);
      applyNexusBackupEnv();
      backendModule = null;
      app.relaunch();
      app.quit();
    } else {
      app.quit();
    }
  } else {
    app.quit();
  }
}

function beginSplashStartup() {
  createSplashWindow();

  ipcMain.once('splash:ready', async () => {
    console.log(`${LOG_PREFIX} splash:ready recibido — comenzando secuencia de inicio.`);
    try {
      await runStartupSequence();
    } catch (err) {
      await handleStartupFailure(err);
    }
  });
}

app.whenReady().then(async () => {
  console.log(`${LOG_PREFIX} Electron listo. isDev=${isDev}, devTools=${isDevToolsEnabled()}, platform=${process.platform}`);
  console.log(`${LOG_PREFIX} userData: ${app.getPath('userData')}`);
  console.log(`${LOG_PREFIX} PG_HOST=${process.env.PG_HOST || '127.0.0.1'} PG_PORT=${process.env.PG_PORT || '5432'}`);
  console.log(`${LOG_PREFIX} NODE_ENV=${process.env.NODE_ENV || '(no definido)'}`);
  if (isDev && process.platform === 'win32') {
    console.log(
      `${LOG_PREFIX} Icono en barra (dev): Windows usa electron.exe de node_modules, no el de marca. ` +
        'Para probar el icono real: npm run start:packaged'
    );
  } else if (useEmbeddedExeTaskbarIcon()) {
    console.log(
      `${LOG_PREFIX} Icono en barra: recurso embebido en "${path.basename(process.execPath)}" (sin setIcon)`
    );
  }

  registerBasicIpc();
  registerSetupIpc();

  if (needsFirstRunSetup(app)) {
    console.log(`${LOG_PREFIX} Primera ejecución — asistente de instalación (pasos 1–3).`);
    const setupOk = await createSetupWindow({ startStep: 1 });
    if (!setupOk) {
      console.log(`${LOG_PREFIX} Instalación cancelada — saliendo.`);
      app.quit();
      return;
    }
    applySavedConfigToProcess(app);
    applyNexusBackupEnv();
  }

  beginSplashStartup();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      beginSplashStartup();
    }
  });
});

app.on('before-quit', (e) => {
  if (appShuttingDown) return;
  e.preventDefault();
  appShuttingDown = true;

  // Notificar al renderer ANTES del shutdown para que el POS pueda
  // guardar el carrito en localStorage (beforeunload del renderer).
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.executeJavaScript(
        'window.dispatchEvent(new Event("beforeunload"));'
      ).catch(() => {});
    } catch (_e) {}
  }

  // Timeout duro: si shutdownBackend no termina en 8s, salir igual
  // para evitar que un proceso colgado mantenga la app abierta.
  const forceExitTimer = setTimeout(() => {
    console.warn(`${LOG_PREFIX} shutdownBackend tardó más de 8s — saliendo forzosamente`);
    app.exit(1);
  }, 8000);

  shutdownBackend()
    .then(() => { clearTimeout(forceExitTimer); app.exit(0); })
    .catch((err) => {
      clearTimeout(forceExitTimer);
      console.error(`${LOG_PREFIX} Error en shutdown:`, err && err.message);
      app.exit(1);
    });
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  if (!mainWindowLifecycleStarted) {
    return;
  }
  app.quit();
});

// Manejo de excepciones no capturadas: loguea sin tumbar la app.
// Si hay sesión de caja abierta, queremos que el usuario tenga oportunidad
// de cerrarla manualmente antes de que un crash silencioso lo deje colgado.
process.on('uncaughtException', (err) => {
  console.error(`${LOG_PREFIX} *** uncaughtException ***`, err && err.stack ? err.stack : err);
});

process.on('unhandledRejection', (reason) => {
  console.error(`${LOG_PREFIX} *** unhandledRejection ***`, reason);
});
