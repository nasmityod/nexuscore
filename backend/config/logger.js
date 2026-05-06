'use strict';

const winston = require('winston');
const path = require('path');
const fs = require('fs');

/**
 * Carga `electron.app` solo en el proceso principal de Electron.
 * Evita romper `node backend/server.js` (sin proceso Electron).
 */
function tryRequireElectronApp() {
  if (!process.versions || !process.versions.electron) {
    return null;
  }
  try {
    const electron = require('electron');
    return electron.app || null;
  } catch {
    return null;
  }
}

function resolveLogDir() {
  const electronApp = tryRequireElectronApp();
  if (
    electronApp &&
    electronApp.isPackaged === true &&
    typeof electronApp.getPath === 'function'
  ) {
    try {
      return path.join(electronApp.getPath('userData'), 'logs');
    } catch {
      /* continuar al fallback local */
    }
  }
  return path.join(__dirname, '..', '..', 'logs');
}

const logDir = resolveLogDir();
try {
  fs.mkdirSync(logDir, { recursive: true });
} catch (_) {
  /* sin carpeta: File transport puede fallar; Console sigue activo */
}

const SKIP_KEYS = new Set(['timestamp', 'level', 'message', 'stack', 'service']);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf((info) => {
      const { timestamp, level, message, stack } = info;
      const metaParts = [];
      for (const [k, v] of Object.entries(info)) {
        if (SKIP_KEYS.has(k)) continue;
        if (v === undefined || v === null || v === '') continue;
        const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
        metaParts.push(`${k}=${val}`);
      }
      const meta = metaParts.length ? ` | ${metaParts.join(' | ')}` : '';
      const stackLine = stack && String(stack).trim() ? `\n${stack}` : '';
      return `${timestamp} ${level}: ${message}${meta}${stackLine}`;
    })
  ),
  transports: [
    new winston.transports.File({ filename: path.join(logDir, 'app.log') }),
    new winston.transports.Console()
  ]
});

module.exports = { logger };
