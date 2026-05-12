'use strict';

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { cn } = require('../config/database');
const { logger } = require('../config/logger');

const BACKUP_PREFIX = 'nexus_backup_';
const BACKUP_NAME_RE = /^nexus_backup_\d{4}_\d{2}_\d{2}_\d{4}(?:_\d+)?\.sql$/;
const MAX_BACKUPS = 10;
const STATE_FILENAME = 'nexus_backup_state.json';

/** stderr típico cuando pg_dump y el servidor difieren de versión mayor. */
function isPgDumpVersionMismatch(text) {
  const s = String(text || '').toLowerCase();
  return (
    s.includes('server version') ||
    s.includes('version mismatch') ||
    s.includes('versión del servidor') ||
    s.includes('version del servidor') ||
    s.includes('no coincide la versión') ||
    s.includes('no coincide la version') ||
    s.includes('abortando debido')
  );
}

/**
 * Respaldo completo con pg_dump, rotación y estado en disco.
 * Directorio: NEXUS_BACKUP_DIR (Electron → userData/backups) o ./backups en backend suelto.
 */
class SyncService {
  static getBackupDir() {
    const fromEnv = process.env.NEXUS_BACKUP_DIR;
    if (fromEnv && String(fromEnv).trim().length > 0) {
      return path.resolve(String(fromEnv).trim());
    }
    return path.join(process.cwd(), 'backups');
  }

  static getPgDumpCandidates() {
    const win = process.platform === 'win32';
    const exe = win ? 'pg_dump.exe' : 'pg_dump';
    const list = [];
    const seen = new Set();

    const add = (p) => {
      if (!p || typeof p !== 'string') return;
      const x = path.resolve(p.trim());
      if (!seen.has(x)) {
        seen.add(x);
        list.push(x);
      }
    };

    if (process.env.NEXUS_PG_DUMP && process.env.NEXUS_PG_DUMP.trim().length > 0) {
      add(process.env.NEXUS_PG_DUMP.trim());
    }

    const pathToken = win ? 'pg_dump.exe' : 'pg_dump';
    if (!seen.has(pathToken)) {
      seen.add(pathToken);
      list.push(pathToken);
    }

    const binDir = process.env.NEXUS_PG_BIN_DIR;
    if (binDir && binDir.trim().length > 0) {
      const p = path.join(path.resolve(binDir.trim()), exe);
      if (fsSync.existsSync(p)) add(p);
    }
    const rel = path.join(__dirname, '..', '..', 'database', 'postgres', 'bin', exe);
    if (fsSync.existsSync(rel)) add(rel);

    return list;
  }

  /** @deprecated usar getPgDumpCandidates; se mantiene por compatibilidad */
  static getPgDumpPath() {
    const c = this.getPgDumpCandidates();
    return c.length ? c[0] : null;
  }

  static buildBackupBaseName(d) {
    const dt = d || new Date();
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    const hm = String(dt.getHours()).padStart(2, '0') + String(dt.getMinutes()).padStart(2, '0');
    return `${BACKUP_PREFIX}${y}_${m}_${day}_${hm}`;
  }

  static resolveUniqueFilePath(dir, baseName) {
    let name = `${baseName}.sql`;
    let full = path.join(dir, name);
    let i = 1;
    while (fsSync.existsSync(full)) {
      name = `${baseName}_${i}.sql`;
      full = path.join(dir, name);
      i += 1;
    }
    return { full, name };
  }

  static runPgDumpExecutable(dumpPath, outFile) {
    return new Promise((resolve, reject) => {
      const args = [
        '-h',
        String(cn.host),
        '-p',
        String(cn.port),
        '-U',
        cn.user,
        '-d',
        cn.database,
        '-F',
        'p',
        '-f',
        outFile
      ];
      const child = spawn(dumpPath, args, {
        env: { ...process.env, PGPASSWORD: cn.password != null ? String(cn.password) : '' },
        windowsHide: true
      });
      let err = '';
      child.stderr.on('data', (chunk) => {
        err += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error((err && err.trim()) || `pg_dump finalizó con código ${code}`));
      });
    });
  }

  static async mergeState(partial) {
    const dir = this.getBackupDir();
    const statePath = path.join(dir, STATE_FILENAME);
    let prev = {};
    try {
      const raw = await fs.readFile(statePath, 'utf8');
      prev = JSON.parse(raw);
    } catch (_e) {
      prev = {};
    }
    const next = { ...prev, ...partial };
    await fs.writeFile(statePath, JSON.stringify(next, null, 2), 'utf8');
  }

  static async rotateOldBackups(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch (_e) {
      return;
    }
    const sqlFiles = entries.filter((f) => BACKUP_NAME_RE.test(f));
    const withStat = await Promise.all(
      sqlFiles.map(async (f) => {
        const p = path.join(dir, f);
        try {
          const st = await fs.stat(p);
          return { f, t: st.mtimeMs };
        } catch (_e) {
          return null;
        }
      })
    );
    const list = withStat.filter(Boolean);
    list.sort((a, b) => b.t - a.t);
    const remove = list.slice(MAX_BACKUPS);
    for (const item of remove) {
      try {
        await fs.unlink(path.join(dir, item.f));
        logger.info('Rotación de respaldos: archivo eliminado', { file: item.f });
      } catch (e) {
        logger.warn('No se pudo eliminar respaldo antiguo', { file: item.f, error: e.message });
      }
    }
  }

  /**
   * @param {{ source?: string }} [options]
   * @returns {Promise<{ ok: boolean, filePath?: string, fileName?: string, error?: string }>}
   */
  static async runFullBackup(options) {
    const source = (options && options.source) || 'unknown';
    const candidates = this.getPgDumpCandidates().filter((p, i, arr) => {
      if (path.isAbsolute(p) || p.includes(path.sep)) return fsSync.existsSync(p);
      return true;
    });
    const dir = this.getBackupDir();

    if (!candidates.length) {
      const msg =
        'No se encontró pg_dump. Coloque PostgreSQL portable en database/postgres/bin o defina NEXUS_PG_BIN_DIR / NEXUS_PG_DUMP.';
      logger.error(msg);
      return { ok: false, error: msg };
    }

    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (e) {
      const msg = `No se pudo crear la carpeta de respaldos: ${e.message}`;
      logger.error(msg);
      return { ok: false, error: msg };
    }

    const baseName = this.buildBackupBaseName();
    const { full: outFile, name: fileName } = this.resolveUniqueFilePath(dir, baseName);

    let lastErr = null;
    for (let ci = 0; ci < candidates.length; ci += 1) {
      const dumpPath = candidates[ci];
      try {
        await this.runPgDumpExecutable(dumpPath, outFile);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        const msg = e.message || String(e);
        const retry =
          ci < candidates.length - 1 &&
          (isPgDumpVersionMismatch(msg) ||
            (e && e.code === 'ENOENT') ||
            String(msg).toLowerCase().includes('enoent'));
        logger.warn('Respaldo: pg_dump falló, probando siguiente candidato', { dumpPath, reintentarOtroBinario: retry, error: msg.split('\n')[0] });
        try {
          await fs.unlink(outFile);
        } catch (_u) {}
        if (!retry) {
          if (isPgDumpVersionMismatch(msg)) {
            logger.warn(
              'Respaldo omitido: versión de pg_dump distinta al servidor. Define NEXUS_PG_BIN_DIR en .env con el bin de la misma versión mayor que el servidor.',
              { dumpPath, error: msg.split('\n')[0] }
            );
            await this.mergeState({
              lastErrorCode: 'pg_dump_version_mismatch',
              lastErrorAt: new Date().toISOString(),
              lastErrorMessage: 'pg_dump versión incompatible con el servidor'
            });
          } else {
            logger.error('Respaldo fallido: pg_dump reportó un error', { dumpPath, error: msg.split('\n')[0] });
          }
          return { ok: false, error: msg };
        }
      }
    }

    if (lastErr) {
      const msg = lastErr.message || String(lastErr);
      if (isPgDumpVersionMismatch(msg)) {
        await this.mergeState({
          lastErrorCode: 'pg_dump_version_mismatch',
          lastErrorAt: new Date().toISOString(),
          lastErrorMessage: 'pg_dump versión incompatible con el servidor'
        });
      }
      return { ok: false, error: msg };
    }

    const lastSuccessAt = new Date().toISOString();
    try {
      await this.mergeState({
        lastSuccessAt,
        lastFile: fileName,
        lastSource: source,
        lastErrorCode: null,
        lastErrorAt: null,
        lastErrorMessage: null
      });
      await this.rotateOldBackups(dir);
    } catch (e) {
      logger.warn('Respaldo creado pero estado/rotación falló', { error: e.message });
    }

    logger.info('Respaldo completo generado', { file: fileName, source });
    return { ok: true, filePath: outFile, fileName, lastSuccessAt };
  }

  /**
   * @returns {Promise<{
   *   lastSuccessAt: string|null,
   *   lastFile: string|null,
   *   directorio: string,
   *   lastErrorCode: string|null,
   *   lastErrorAt: string|null,
   *   lastErrorMessage: string|null
   * }>}
   */
  static async getBackupStatus() {
    const dir = this.getBackupDir();
    const statePath = path.join(dir, STATE_FILENAME);
    try {
      const raw = await fs.readFile(statePath, 'utf8');
      const j = JSON.parse(raw);
      const lastSuccessAt = j.lastSuccessAt != null ? String(j.lastSuccessAt) : null;
      const lastErrorCode =
        j.lastErrorCode !== undefined && j.lastErrorCode !== null ? String(j.lastErrorCode) : null;
      return {
        lastSuccessAt,
        lastFile: j.lastFile != null ? String(j.lastFile) : null,
        directorio: dir,
        lastErrorCode,
        lastErrorAt: j.lastErrorAt != null ? String(j.lastErrorAt) : null,
        lastErrorMessage:
          j.lastErrorMessage !== undefined && j.lastErrorMessage !== null
            ? String(j.lastErrorMessage)
            : null
      };
    } catch (_e) {
      return {
        lastSuccessAt: null,
        lastFile: null,
        directorio: dir,
        lastErrorCode: null,
        lastErrorAt: null,
        lastErrorMessage: null
      };
    }
  }
}

module.exports = SyncService;
