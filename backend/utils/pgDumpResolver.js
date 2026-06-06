'use strict';

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');

const { logger } = require('../config/logger');

const execFileAsync = promisify(execFile);

/** @type {{ serverMajor: number|null, candidates: string[]|null }} */
let resolutionCache = { serverMajor: null, candidates: null };

/**
 * Extrae la versión mayor de cadenas típicas de PostgreSQL / pg_dump.
 * @param {string} text
 * @returns {number|null}
 */
function parsePostgresMajor(text) {
  const s = String(text || '');
  const m =
    s.match(/PostgreSQL\s+(\d+)/i) ||
    s.match(/pg_dump\s+\(PostgreSQL\)\s+(\d+)/i) ||
    s.match(/server version:\s*(\d+)/i) ||
    s.match(/versi[oó]n del servidor:\s*(\d+)/i);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {object} db pg-promise
 * @returns {Promise<number|null>}
 */
async function getServerMajorFromDb(db) {
  const row = await db.one('SELECT version() AS version');
  return parsePostgresMajor(row.version);
}

/**
 * @param {string} dumpPath
 * @returns {Promise<number|null>}
 */
function probePgDumpMajor(dumpPath) {
  return new Promise((resolve) => {
    const child = spawn(dumpPath, ['--version'], {
      windowsHide: true,
      env: process.env
    });
    let out = '';
    const finish = (major) => {
      try {
        child.kill();
      } catch (_e) {}
      resolve(major);
    };
    const timer = setTimeout(() => finish(null), 12000);
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.stdout.on('data', (c) => {
      out += c.toString();
    });
    child.stderr.on('data', (c) => {
      out += c.toString();
    });
    child.on('close', () => {
      clearTimeout(timer);
      finish(parsePostgresMajor(out));
    });
  });
}

function bundledPgDumpPath() {
  const win = process.platform === 'win32';
  const exe = win ? 'pg_dump.exe' : 'pg_dump';
  const rel = path.join(__dirname, '..', '..', 'database', 'postgres', 'bin', exe);
  return fs.existsSync(rel) ? rel : null;
}

function packagedPgDumpCandidates() {
  const win = process.platform === 'win32';
  const exe = win ? 'pg_dump.exe' : 'pg_dump';
  const list = [];
  const roots = [];
  if (process.resourcesPath) {
    roots.push(path.join(process.resourcesPath, 'postgres', 'bin', exe));
  }
  try {
    const execDir = path.dirname(process.execPath);
    roots.push(path.join(execDir, 'resources', 'postgres', 'bin', exe));
  } catch (_e) {}
  for (const p of roots) {
    if (p && fs.existsSync(p)) list.push(p);
  }
  return list;
}

/**
 * Rutas típicas de instaladores oficiales en Windows.
 * @returns {Promise<string[]>}
 */
async function discoverWindowsPgDumpPaths() {
  const roots = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PostgreSQL'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'PostgreSQL')
  ];
  const found = [];
  const seen = new Set();
  for (const root of roots) {
    let entries;
    try {
      entries = await fsPromises.readdir(root, { withFileTypes: true });
    } catch (_e) {
      continue;
    }
    const dirs = entries
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => Number(b) - Number(a));
    for (const ver of dirs) {
      const dump = path.join(root, ver, 'bin', 'pg_dump.exe');
      if (fs.existsSync(dump) && !seen.has(dump)) {
        seen.add(dump);
        found.push(dump);
      }
    }
  }
  return found;
}

/**
 * @returns {Promise<string[]>}
 */
async function discoverUnixPgDumpPaths() {
  const found = [];
  const seen = new Set();
  const add = (p) => {
    if (p && fs.existsSync(p) && !seen.has(p)) {
      seen.add(p);
      found.push(p);
    }
  };

  add('/usr/bin/pg_dump');
  add('/usr/local/bin/pg_dump');
  if (process.platform === 'darwin') {
    add('/opt/homebrew/bin/pg_dump');
    add('/usr/local/opt/postgresql/bin/pg_dump');
    try {
      const opt = '/opt/homebrew/opt';
      const entries = await fsPromises.readdir(opt, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && e.name.startsWith('postgresql')) {
          add(path.join(opt, e.name, 'bin', 'pg_dump'));
        }
      }
    } catch (_e) {}
  }

  if (process.platform === 'linux') {
    try {
      const lib = '/usr/lib/postgresql';
      const entries = await fsPromises.readdir(lib, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          add(path.join(lib, e.name, 'bin', 'pg_dump'));
        }
      }
    } catch (_e) {}
  }

  return found;
}

/**
 * pg_dump en PATH del sistema (where/which).
 * @returns {Promise<string|null>}
 */
async function resolvePgDumpFromPath() {
  const win = process.platform === 'win32';
  const cmd = win ? 'where.exe' : 'which';
  const arg = win ? 'pg_dump.exe' : 'pg_dump';
  try {
    const { stdout } = await execFileAsync(cmd, [arg], {
      windowsHide: true,
      timeout: 8000,
      env: process.env
    });
    const line = String(stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    if (line && fs.existsSync(line)) return line;
  } catch (_e) {}
  return null;
}

/**
 * @param {number} serverMajor
 * @returns {Promise<string[]>}
 */
async function collectRawCandidatePaths() {
  const win = process.platform === 'win32';
  const exe = win ? 'pg_dump.exe' : 'pg_dump';
  const raw = [];
  const seen = new Set();
  const push = (p) => {
    if (!p || typeof p !== 'string') return;
    const x = path.resolve(p.trim());
    if (!seen.has(x)) {
      seen.add(x);
      raw.push(x);
    }
  };

  if (process.env.NEXUS_PG_DUMP && String(process.env.NEXUS_PG_DUMP).trim()) {
    push(process.env.NEXUS_PG_DUMP.trim());
  }

  const binDir = process.env.NEXUS_PG_BIN_DIR;
  if (binDir && String(binDir).trim()) {
    push(path.join(path.resolve(String(binDir).trim()), exe));
  }

  const discovered =
    process.platform === 'win32' ? await discoverWindowsPgDumpPaths() : await discoverUnixPgDumpPaths();
  for (const p of discovered) push(p);

  const fromPath = await resolvePgDumpFromPath();
  if (fromPath) push(fromPath);

  const bundled = bundledPgDumpPath();
  if (bundled) push(bundled);
  for (const p of packagedPgDumpCandidates()) push(p);

  return raw.filter((p) => fs.existsSync(p));
}

/**
 * Ordena candidatos: misma versión mayor que el servidor primero; dentro del grupo, mayor minor.
 *
 * @param {string[]} rawPaths
 * @param {number} serverMajor
 * @returns {Promise<string[]>}
 */
async function rankCandidatesByServerMajor(rawPaths, serverMajor) {
  const probed = [];
  for (const dumpPath of rawPaths) {
    const major = await probePgDumpMajor(dumpPath);
    if (major == null) continue;
    probed.push({ dumpPath, major });
  }

  const matching = probed.filter((p) => p.major === serverMajor);
  const others = probed.filter((p) => p.major !== serverMajor);

  matching.sort((a, b) => b.major - a.major);
  others.sort((a, b) => {
    const da = Math.abs(a.major - serverMajor);
    const db = Math.abs(b.major - serverMajor);
    if (da !== db) return da - db;
    return b.major - a.major;
  });

  const ordered = [...matching, ...others].map((p) => p.dumpPath);
  const uniq = [];
  const seen = new Set();
  for (const p of ordered) {
    if (!seen.has(p)) {
      seen.add(p);
      uniq.push(p);
    }
  }
  return uniq;
}

/**
 * @param {object} db
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{ serverMajor: number|null, candidates: string[], preferred: string|null }>}
 */
async function resolvePgDumpCandidates(db, opts) {
  const force = Boolean(opts && opts.force);
  let serverMajor = null;
  try {
    serverMajor = await getServerMajorFromDb(db);
  } catch (e) {
    logger.warn('pgDumpResolver: no se pudo leer version() del servidor', { error: e.message });
  }

  if (
    !force &&
    resolutionCache.candidates &&
    resolutionCache.candidates.length > 0 &&
    resolutionCache.serverMajor === serverMajor
  ) {
    return {
      serverMajor,
      candidates: resolutionCache.candidates,
      preferred: resolutionCache.candidates[0] || null
    };
  }

  const raw = await collectRawCandidatePaths();
  let candidates = raw;

  if (serverMajor != null && raw.length > 0) {
    const ranked = await rankCandidatesByServerMajor(raw, serverMajor);
    const matching = [];
    for (const p of ranked) {
      const major = await probePgDumpMajor(p);
      if (major === serverMajor) matching.push(p);
    }
    candidates = matching.length > 0 ? matching : ranked;
  }

  resolutionCache = { serverMajor, candidates };

  return {
    serverMajor,
    candidates,
    preferred: candidates[0] || null
  };
}

/**
 * Tras conectar a BD, fija NEXUS_PG_DUMP al binario compatible (sin pisar .env explícito válido).
 *
 * @param {object} db
 */
async function warmupPgDumpResolution(db) {
  const userDump =
    process.env.NEXUS_PG_DUMP && String(process.env.NEXUS_PG_DUMP).trim().length > 0;
  const userBin =
    process.env.NEXUS_PG_BIN_DIR && String(process.env.NEXUS_PG_BIN_DIR).trim().length > 0;

  const { serverMajor, candidates, preferred } = await resolvePgDumpCandidates(db, { force: true });

  if (!serverMajor) {
    logger.warn('pgDumpResolver: versión del servidor no detectada; se usarán candidatos sin filtrar');
  }

  if (!preferred) {
    logger.warn('pgDumpResolver: no se encontró pg_dump compatible', {
      serverMajor,
      sugerencia:
        serverMajor != null
          ? `Instale PostgreSQL ${serverMajor} o defina NEXUS_PG_BIN_DIR apuntando a su carpeta bin`
          : 'Defina NEXUS_PG_BIN_DIR o NEXUS_PG_DUMP en .env'
    });
    return { serverMajor, preferred: null, candidates: [] };
  }

  const preferredMajor = await probePgDumpMajor(preferred);

  if (userDump || userBin) {
    const envPath = userDump
      ? path.resolve(String(process.env.NEXUS_PG_DUMP).trim())
      : path.join(path.resolve(String(process.env.NEXUS_PG_BIN_DIR).trim()), process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump');
    if (fs.existsSync(envPath)) {
      const envMajor = await probePgDumpMajor(envPath);
      if (serverMajor != null && envMajor != null && envMajor !== serverMajor) {
        logger.warn('pgDumpResolver: NEXUS_PG_* del .env no coincide con el servidor; se usará binario del sistema', {
          envPath,
          envMajor,
          serverMajor,
          preferred
        });
        process.env.NEXUS_PG_DUMP = preferred;
      } else {
        logger.info('pgDumpResolver: usando pg_dump definido en entorno', {
          path: envPath,
          major: envMajor,
          serverMajor
        });
        return { serverMajor, preferred: envPath, candidates };
      }
    } else {
      logger.warn('pgDumpResolver: ruta NEXUS_PG_* del .env no existe; usando descubrimiento automático', {
        envPath,
        preferred
      });
      process.env.NEXUS_PG_DUMP = preferred;
    }
  } else {
    process.env.NEXUS_PG_DUMP = preferred;
  }

  logger.info('pgDumpResolver: pg_dump listo para respaldos', {
    path: preferred,
    pgDumpMajor: preferredMajor,
    serverMajor,
    candidatos: candidates.length
  });

  return { serverMajor, preferred, candidates };
}

function clearPgDumpResolutionCache() {
  resolutionCache = { serverMajor: null, candidates: null };
}

module.exports = {
  parsePostgresMajor,
  getServerMajorFromDb,
  resolvePgDumpCandidates,
  warmupPgDumpResolution,
  clearPgDumpResolutionCache,
  probePgDumpMajor,
  discoverWindowsPgDumpPaths
};
