'use strict';

// ── dotenv debe cargarse PRIMERO, antes de cualquier lógica que lea process.env ──
// En producción empaquetada puede no existir .env; las variables vienen del SO.
const dotenvPath = require('path').join(__dirname, '..', '.env');
require('dotenv').config({ path: dotenvPath });

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { getBundledRoot } = require('./postgres-portable');

const LOG_PREFIX = '[nexus-core]';

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
 * Configura las rutas usadas por funciones de respaldo (pg_dump).
 *
 * Tolerante a la ausencia de binarios: la app ya no depende de PostgreSQL
 * portátil para arrancar; los binarios solo son necesarios si el usuario
 * lanza un backup desde la app y no tiene pg_dump en el PATH del sistema.
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
        `${LOG_PREFIX} Respaldos: usando NEXUS_PG_DUMP / NEXUS_PG_BIN_DIR del entorno (.env); no se sobrescribe con binarios embebidos.`
      );
      return;
    }

    const pgRoot = getBundledRoot(app);
    if (pgRoot) {
      const binDir = path.join(pgRoot, 'bin');
      const dumpName = process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump';
      const dump = path.join(binDir, dumpName);
      if (fsSync.existsSync(dump)) {
        process.env.NEXUS_PG_BIN_DIR = binDir;
        console.log(`${LOG_PREFIX} NEXUS_PG_BIN_DIR = ${binDir}`);
        console.log(
          `${LOG_PREFIX} Aviso: pg_dump bundleado puede diferir de la versión del servidor. Si los respaldos fallan, define NEXUS_PG_BIN_DIR en .env.`
        );
        return;
      }
    }
    console.log(
      `${LOG_PREFIX} Sin binarios PostgreSQL bundleados; los respaldos usarán pg_dump del PATH del sistema (si está disponible).`
    );
  } catch (err) {
    console.warn(`${LOG_PREFIX} applyNexusBackupEnv:`, err.message);
  }
}

applyNexusBackupEnv();

const { start: startBackend, shutdown: shutdownBackend } = require('../backend/server');

const isDev = !app.isPackaged;

let appShuttingDown = false;

let mainWindow = null;
let splashWindow = null;

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
      title:            'Nexus-Core · Activación de Licencia',
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

    if (isDev) {
      activationWindow.webContents.openDevTools({ mode: 'detach' });
    }

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
        return { ok: false, estado: null };
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
    fullscreen: !isDev,
    autoHideMenuBar: true,
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
    // Desactivar menú contextual (click derecho) en producción
    if (!isDev && input.type === 'mouseDown' && input.button === 'right') {
      event.preventDefault();
    }
  });

  mainWindow.once('ready-to-show', () => {
    closeSplash();
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      if (!isDev) {
        mainWindow.setFullScreen(true);
      }
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

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
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

app.whenReady().then(async () => {
  console.log(`${LOG_PREFIX} Electron listo. isDev=${isDev}, platform=${process.platform}`);
  console.log(`${LOG_PREFIX} userData: ${app.getPath('userData')}`);
  console.log(`${LOG_PREFIX} PG_HOST=${process.env.PG_HOST || '127.0.0.1'} PG_PORT=${process.env.PG_PORT || '5432'}`);
  console.log(`${LOG_PREFIX} NODE_ENV=${process.env.NODE_ENV || '(no definido)'}`);

  registerBasicIpc();

  createSplashWindow();

  // Registrar el handler ANTES de que el splash pueda enviar el evento.
  // ipcMain.once garantiza que solo se procese el primer disparo aunque
  // el Splash se recargue por algún motivo.
  ipcMain.once('splash:ready', async () => {
    console.log(`${LOG_PREFIX} splash:ready recibido — comenzando secuencia de inicio.`);
    try {
      updateSplashStatus('Verificando PostgreSQL...', 10);

      updateSplashStatus('Iniciando servidor backend...', 30);
      // Timeout amplio (60s): cubre 5 reintentos de 12s con backoff lineal.
      // El backend internamente usa initDatabaseWithRetry para tolerar
      // arranques lentos del servicio Windows o bloqueos transitorios de antivirus.
      await withTimeout(startBackend(), 60_000, 'Inicio del servidor backend');

      updateSplashStatus('Aplicando migraciones...', 70);
      await new Promise(resolve => setTimeout(resolve, 200));

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
            buttons: ['Entendido'],
          });
        }
      }

      if (!licenciaOk) {
        // ── Sin licencia válida: mostrar pantalla de activación ──────────
        console.log(`${LOG_PREFIX} Licencia no encontrada — mostrando pantalla de activación.`);
        updateSplashStatus('Se requiere activación...', 90);
        await new Promise(resolve => setTimeout(resolve, 300));
        closeSplash();
        // Espera hasta que el usuario active correctamente
        const activated = await createActivationWindow();
        if (!activated) {
          console.log(`${LOG_PREFIX} Activación cancelada o ventana cerrada — saliendo.`);
          app.quit();
          return;
        }
      } else {
        console.log(`${LOG_PREFIX} Licencia válida — continuando.`);
      }

      updateSplashStatus('Cargando interfaz...', 95);
      await new Promise(resolve => setTimeout(resolve, 200));

      updateSplashStatus('¡Listo!', 100);
      await new Promise(resolve => setTimeout(resolve, 300));

      console.log(`${LOG_PREFIX} Secuencia de inicio completada. Abriendo ventana principal.`);
      createMainWindow();

    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error(`${LOG_PREFIX} *** ERROR DE INICIO ***`);
      console.error(msg);

      // Construir log técnico para mostrar en el Splash.
      // Ya no leemos postgres.log porque el cluster no es nuestro; mostramos
      // una pista clara sobre PostgreSQL del sistema y las variables PG_*.
      const technicalLog =
        '─── Diagnóstico ───\n' +
        `PG_HOST=${process.env.PG_HOST || '127.0.0.1'}\n` +
        `PG_PORT=${process.env.PG_PORT || '5432'}\n` +
        `PG_DATABASE=${process.env.PG_DATABASE || 'nexuscore'}\n` +
        `PG_USER=${process.env.PG_USER || 'postgres'}\n\n` +
        'Verifica que el servicio "postgresql-x64-XX" esté en ejecución\n' +
        '(Servicios de Windows) y que la base/usuario/contraseña coincidan\n' +
        'con los valores del archivo .env.';

      showSplashError(err, technicalLog);

      setTimeout(() => {
        dialog.showErrorBox(
          'Nexus-Core — Error de Inicio',
          `No se pudo iniciar el sistema:\n\n${msg}\n\n` +
          'Asegúrate de que PostgreSQL del sistema esté en ejecución y de que\n' +
          'las variables PG_HOST, PG_PORT, PG_USER, PG_PASSWORD y PG_DATABASE\n' +
          'del archivo .env sean correctas.'
        );
        app.quit();
      }, 5000);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createSplashWindow();
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
