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
      if (activationWindow && !activationWindow.isDestroyed()) {
        activationWindow.close();
        activationWindow = null;
      }
      resolve(true);
    });

    activationWindow.on('closed', () => {
      activationWindow = null;
    });
  });
}

/**
 * Comprueba la licencia contra el backend local.
 * Retorna true si está activada, false en caso contrario.
 */
async function checkLicense() {
  try {
    const os     = require('os');
    const crypto = require('crypto');
    const ifaces = os.networkInterfaces();
    let mac = '';
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
          mac = iface.mac;
          break;
        }
      }
      if (mac) break;
    }
    const cpuModel = os.cpus().length > 0 ? os.cpus()[0].model : 'unknown';
    const raw  = `${mac}|${cpuModel}|${os.hostname()}`;
    const hwid = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24).toUpperCase();

    const http = require('http');
    const resp = await new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: 3000, path: `/api/licencia/estado?hwid=${hwid}`, method: 'GET' },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch (_e) { resolve({ activada: false }); }
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });

    return resp && resp.activada === true;
  } catch (e) {
    console.warn(`${LOG_PREFIX} checkLicense error:`, e.message);
    return false;
  }
}

function createMainWindow() {
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
    || 'https://nexus-license-server.vercel.app';

  ipcMain.handle('license:get-server-url', () => NEXUS_LICENSE_SERVER_URL);

  ipcMain.handle('app:get-path', (_evt, name) => app.getPath(name));

  // Hardware ID para licenciamiento: combinación de MAC address + CPU model
  ipcMain.handle('app:get-hardware-id', async () => {
    try {
      const os    = require('os');
      const crypto = require('crypto');
      const ifaces = os.networkInterfaces();
      // Tomar la primera MAC no-loopback
      let mac = '';
      for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
          if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
            mac = iface.mac;
            break;
          }
        }
        if (mac) break;
      }
      const cpus = os.cpus();
      const cpuModel = cpus.length > 0 ? cpus[0].model : 'unknown';
      const raw = `${mac}|${cpuModel}|${os.hostname()}`;
      return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24).toUpperCase();
    } catch (e) {
      return 'HWID-UNKNOWN';
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
      const licenciaOk = await checkLicense();

      if (!licenciaOk) {
        // ── Sin licencia válida: mostrar pantalla de activación ──────────
        console.log(`${LOG_PREFIX} Licencia no encontrada — mostrando pantalla de activación.`);
        updateSplashStatus('Se requiere activación...', 90);
        await new Promise(resolve => setTimeout(resolve, 300));
        closeSplash();
        // Espera hasta que el usuario active correctamente
        await createActivationWindow();
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
  if (process.platform !== 'darwin') app.quit();
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
