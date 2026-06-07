'use strict';

/**
 * licenseManager.js — Cliente profesional de licencias (proceso principal de Electron).
 *
 * Responsabilidades (Fase 4.4 del brief):
 *   - HWID endurecido (CPU + placa base + UUID de producto + serial de disco) estable ante
 *     reinstalación del SO / actualizaciones de Windows / cambio de usuario.
 *   - Archivo de licencia local CIFRADO (AES-256-GCM) en userData, con clave derivada del
 *     HWID (scrypt) → no se puede copiar a otra máquina, y el tag GCM detecta manipulación.
 *   - Activación inicial online contra el servidor Vercel (POST /api/licenses/activate).
 *   - Verificación periódica (POST /api/licenses/verify) con período de gracia offline.
 *   - Verificación OFFLINE del token Ed25519 (clave pública embebida) en cada arranque.
 *   - Anti-bypass: archivo cifrado por HWID + tag de integridad + expiración del token del
 *     servidor (el reloj local no puede extender la licencia más allá de lo que el token dice).
 *
 * NEXUS-DUAL: la verificación Ed25519 es espejo de backend/services/licenciaService.js
 * (verificarClave). Se duplica aquí ~30 líneas a propósito para que el gate de arranque NO
 * dependa del proceso hijo Express (que aún no está listo en el primer arranque).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LICENSE_FILE = 'license.dat';
const FILE_VERSION = 1;
const VERIFY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 h
const DEFAULT_GRACE_DAYS = 7;

// Clave pública Ed25519 embebida (pareja de la privada en Vercel). Override por env sin recompilar.
const PUBLIC_KEY_PEM_DEFAULT = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEALRroxTO1ghmGygJM0WMWY9zWk2XvQDdcZDBqbcb5qrM=
-----END PUBLIC KEY-----`;

function publicKeyPem() {
  const raw = process.env.NEXUS_LICENSE_PUBLIC_KEY;
  if (raw && String(raw).trim()) return String(raw).trim().replace(/\\n/g, '\n');
  return PUBLIC_KEY_PEM_DEFAULT;
}

function serverUrl() {
  return String(process.env.NEXUS_LICENSE_SERVER_URL || 'https://nexuscore-iota.vercel.app')
    .replace(/\/+$/, '');
}

// ── HWID endurecido ────────────────────────────────────────────────────────

let _hwidCache = null;

/**
 * Lee identificadores de hardware estables en Windows vía CIM (PowerShell). En caso de fallo
 * (otro SO, permisos, timeout) devuelve {} y el HWID cae a la combinación os.* disponible.
 * @returns {Record<string,string>}
 */
function readWindowsHardwareIds() {
  if (process.platform !== 'win32') return {};
  try {
    // Una sola invocación de PowerShell que imprime CLAVE=VALOR por línea.
    const ps = [
      "$ErrorActionPreference='SilentlyContinue';",
      "function v($x){ if($x){ ($x | Select-Object -First 1).ToString().Trim() } else { '' } }",
      "'CPU='   + v((Get-CimInstance Win32_Processor).ProcessorId);",
      "'BOARD=' + v((Get-CimInstance Win32_BaseBoard).SerialNumber);",
      "'UUID='  + v((Get-CimInstance Win32_ComputerSystemProduct).UUID);",
      "'DISK='  + v((Get-CimInstance Win32_DiskDrive | Where-Object { $_.SerialNumber }).SerialNumber)"
    ].join(' ');
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: 6000, windowsHide: true, encoding: 'utf8' }
    );
    const ids = {};
    for (const line of String(out).split(/\r?\n/)) {
      const m = line.match(/^([A-Z]+)=(.*)$/);
      if (m && m[2] && m[2].trim() && !/^0+$/.test(m[2].trim()) && m[2].trim().toUpperCase() !== 'TO BE FILLED BY O.E.M.') {
        ids[m[1]] = m[2].trim();
      }
    }
    return ids;
  } catch (_e) {
    return {};
  }
}

/**
 * HWID estable: SHA-256 de la combinación de identificadores de hardware disponibles.
 * Devuelve { hwid, components } donde components lista qué fuentes se usaron (para soporte).
 * @returns {{ hwid: string, components: string[], detail: Record<string,boolean> }}
 */
function computeHardwareId() {
  if (_hwidCache) return _hwidCache;
  const os = require('os');
  const hw = readWindowsHardwareIds();

  const parts = [];
  const used = [];
  const detail = { cpu: false, board: false, uuid: false, disk: false, mac: false, host: false };

  if (hw.CPU) { parts.push('cpu:' + hw.CPU); used.push('cpu'); detail.cpu = true; }
  if (hw.UUID) { parts.push('uuid:' + hw.UUID); used.push('uuid'); detail.uuid = true; }
  if (hw.BOARD) { parts.push('board:' + hw.BOARD); used.push('board'); detail.board = true; }
  if (hw.DISK) { parts.push('disk:' + hw.DISK); used.push('disk'); detail.disk = true; }

  // Refuerzo / fallback con identificadores del SO (MAC ordenadas + hostname). Si no hubo
  // identificadores de hardware, estos garantizan un HWID no trivial.
  try {
    const ifaces = os.networkInterfaces();
    const macSet = new Set();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name] || []) {
        if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
          macSet.add(iface.mac.toLowerCase());
        }
      }
    }
    if (macSet.size && used.length === 0) {
      // Solo se incluye la MAC en el hash cuando no hay IDs de hardware: así el HWID no
      // cambia si el usuario conecta/desconecta una tarjeta de red en un equipo con WMI ok.
      parts.push('mac:' + [...macSet].sort().join(','));
      used.push('mac'); detail.mac = true;
    }
  } catch (_e) { /* sin red */ }

  if (used.length === 0) {
    parts.push('host:' + os.hostname());
    used.push('host'); detail.host = true;
  }

  const hwid = crypto.createHash('sha256').update(parts.join('|')).digest('hex');
  _hwidCache = { hwid, components: used, detail };
  return _hwidCache;
}

// ── Cifrado del archivo local (AES-256-GCM, clave derivada del HWID) ─────────

function deriveKey(hwid, salt) {
  // scrypt: lento a propósito; deriva 32 bytes desde el HWID (machine-bound) + salt almacenado.
  return crypto.scryptSync(String(hwid), salt, 32, { N: 16384, r: 8, p: 1 });
}

function encryptPayload(obj, hwid) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(hwid, salt);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: FILE_VERSION,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64')
  };
}

function decryptPayload(fileObj, hwid) {
  if (!fileObj || fileObj.v !== FILE_VERSION) throw new Error('Formato de licencia local desconocido');
  const salt = Buffer.from(fileObj.salt, 'base64');
  const iv = Buffer.from(fileObj.iv, 'base64');
  const tag = Buffer.from(fileObj.tag, 'base64');
  const key = deriveKey(hwid, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(Buffer.from(fileObj.data, 'base64')), decipher.final()]);
  return JSON.parse(dec.toString('utf8'));
}

function licenseFilePath(app) {
  return path.join(app.getPath('userData'), LICENSE_FILE);
}

function readLocal(app, hwid) {
  try {
    const p = licenseFilePath(app);
    if (!fs.existsSync(p)) return null;
    const fileObj = JSON.parse(fs.readFileSync(p, 'utf8'));
    // Si el archivo fue manipulado o copiado de otra máquina, decrypt lanza (tag GCM/clave HWID).
    return decryptPayload(fileObj, hwid);
  } catch (_e) {
    return { __tampered: true };
  }
}

function writeLocal(app, hwid, payload) {
  const p = licenseFilePath(app);
  const enc = encryptPayload(payload, hwid);
  fs.writeFileSync(p, JSON.stringify(enc), { mode: 0o600 });
}

function clearLocal(app) {
  try { fs.unlinkSync(licenseFilePath(app)); } catch (_e) { /* no existía */ }
}

// ── Verificación Ed25519 offline (espejo de licenciaService.verificarClave) ──

function sha256hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
function fromB64url(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (b64.length % 4)) % 4;
  return Buffer.from(b64 + '='.repeat(pad), 'base64');
}

/**
 * @returns {{ ok:true, payload:object } | { ok:false, motivo:string }}
 */
function verifyTokenOffline(token, hwid) {
  try {
    const raw = String(token || '').trim();
    if (!raw.startsWith('NC1.')) return { ok: false, motivo: 'Formato de licencia inválido' };
    const parts = raw.split('.');
    if (parts.length !== 3) return { ok: false, motivo: 'Token de licencia corrupto' };
    const payloadBuf = fromB64url(parts[1]);
    const sigBytes = fromB64url(parts[2]);
    const pubKey = crypto.createPublicKey(publicKeyPem());
    const ok = crypto.verify(null, payloadBuf, pubKey, sigBytes)
      || crypto.verify(null, Buffer.from(parts[1], 'utf8'), pubKey, sigBytes);
    if (!ok) return { ok: false, motivo: 'Firma de licencia no válida' };
    const payload = JSON.parse(payloadBuf.toString('utf8'));
    if (payload.h !== sha256hex(String(hwid || '').trim().toUpperCase())) {
      return { ok: false, motivo: 'Esta licencia pertenece a otro equipo' };
    }
    if (payload.ex) {
      const exp = new Date(payload.ex);
      if (Number.isNaN(exp.getTime())) return { ok: false, motivo: 'Fecha de expiración inválida' };
      if (exp < new Date()) return { ok: false, motivo: 'Licencia vencida' };
    }
    return { ok: true, payload };
  } catch (e) {
    return { ok: false, motivo: 'Token de licencia inválido: ' + e.message };
  }
}

// ── Llamadas al servidor ─────────────────────────────────────────────────────

async function postServer(pathSeg, body, timeoutMs = 8000) {
  const url = serverUrl() + pathSeg;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    let json = null;
    try { json = await res.json(); } catch (_e) {}
    return { status: res.status, ok: res.ok, body: json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Activación inicial. Requiere internet.
 * @returns {Promise<{ ok:boolean, reason?:string, info?:object }>}
 */
async function activate(app, licenseKey, appVersion, machineName) {
  const { hwid } = computeHardwareId();
  let resp;
  try {
    resp = await postServer('/api/licenses/activate', {
      licenseKey: String(licenseKey || '').trim().toUpperCase(),
      hwid,
      appVersion: appVersion || '',
      machineName: machineName || ''
    });
  } catch (e) {
    return { ok: false, reason: 'offline', message: 'Sin conexión a internet. Conéctate para activar.' };
  }
  if (!resp.ok || !resp.body || !resp.body.valid) {
    const msg = (resp.body && (resp.body.error || resp.body.message)) || 'Licencia inválida.';
    return { ok: false, reason: 'rejected', status: resp.status, message: msg };
  }

  // Verificación cruzada offline del token recibido (defensa: el token debe ser para este HWID).
  const off = verifyTokenOffline(resp.body.token, hwid);
  if (!off.ok) return { ok: false, reason: 'token_invalid', message: off.motivo };

  const now = new Date().toISOString();
  const payload = {
    licenseKey: String(licenseKey || '').trim().toUpperCase(),
    token: resp.body.token,
    type: resp.body.type,
    status: resp.body.status || 'active',
    expiresAt: resp.body.expiresAt || null,
    features: resp.body.features || [],
    customerName: resp.body.customerName || null,
    gracePeriodDays: Number(resp.body.gracePeriodDays) || DEFAULT_GRACE_DAYS,
    activatedAt: now,
    lastVerifiedAt: now,
    checksum: sha256hex(resp.body.token + '|' + hwid)
  };
  writeLocal(app, hwid, payload);
  return { ok: true, info: publicInfo(payload) };
}

/**
 * Verificación periódica online. Actualiza token/estado y lastVerifiedAt.
 * @returns {Promise<{ ok:boolean, blocked?:boolean, reason?:string, info?:object }>}
 */
async function verifyOnline(app) {
  const { hwid } = computeHardwareId();
  const local = readLocal(app, hwid);
  if (!local || local.__tampered || !local.token) {
    return { ok: false, reason: 'no_license' };
  }
  let resp;
  try {
    resp = await postServer('/api/licenses/verify', {
      licenseKey: local.licenseKey, hwid, token: local.token
    });
  } catch (e) {
    return { ok: false, reason: 'offline' };
  }
  if (!resp.body) return { ok: false, reason: 'offline' };

  if (resp.body.valid) {
    local.lastVerifiedAt = new Date().toISOString();
    local.status = resp.body.status || 'active';
    local.expiresAt = resp.body.expiresAt || local.expiresAt;
    local.features = resp.body.features || local.features;
    if (resp.body.gracePeriodDays != null) local.gracePeriodDays = Number(resp.body.gracePeriodDays);
    if (resp.body.token) {
      local.token = resp.body.token;
      local.checksum = sha256hex(resp.body.token + '|' + hwid);
    }
    writeLocal(app, hwid, local);
    return { ok: true, info: publicInfo(local) };
  }

  // El servidor la marcó inválida (suspended / revoked / expired). Persistimos el estado para
  // que el PRÓXIMO arranque bloquee (no interrumpimos la sesión activa en curso).
  local.status = resp.body.reason === 'suspended' ? 'suspended'
    : resp.body.reason === 'revoked' ? 'revoked'
    : local.status;
  local.serverRejectedAt = new Date().toISOString();
  local.serverRejectReason = resp.body.reason || 'invalid';
  writeLocal(app, hwid, local);
  return { ok: false, blocked: true, reason: resp.body.reason || 'invalid', info: publicInfo(local) };
}

/**
 * Evaluación de arranque (sin red). Verifica integridad + firma + expiración + período de gracia.
 * @returns {{ ok:boolean, state:string, reason?:string, info?:object, needsOnlineSoon?:boolean }}
 *   state: 'none' | 'tampered' | 'foreign' | 'expired' | 'suspended' | 'revoked' | 'grace_exceeded' | 'ok'
 */
function evaluate(app) {
  const { hwid } = computeHardwareId();
  const local = readLocal(app, hwid);
  if (!local) return { ok: false, state: 'none', reason: 'Sin licencia. Ingresa tu clave de activación.' };
  if (local.__tampered) {
    return { ok: false, state: 'tampered', reason: 'El archivo de licencia fue modificado o pertenece a otro equipo.' };
  }

  // Estado persistido por una verificación previa del servidor.
  if (local.status === 'suspended') {
    return { ok: false, state: 'suspended', reason: 'Licencia suspendida — contacta al proveedor.', info: publicInfo(local) };
  }
  if (local.status === 'revoked') {
    return { ok: false, state: 'revoked', reason: 'Licencia revocada — contacta al proveedor.', info: publicInfo(local) };
  }

  // Verificación criptográfica offline del token.
  const off = verifyTokenOffline(local.token, hwid);
  if (!off.ok) {
    const st = /otro equipo/i.test(off.motivo) ? 'foreign' : /vencida|expir/i.test(off.motivo) ? 'expired' : 'tampered';
    return { ok: false, state: st, reason: off.motivo, info: publicInfo(local) };
  }

  // Período de gracia offline: si pasó demasiado tiempo sin verificar online, exigir reconexión.
  const grace = Number(local.gracePeriodDays) || DEFAULT_GRACE_DAYS;
  const last = Date.parse(local.lastVerifiedAt || local.activatedAt || '');
  const sinceMs = Number.isFinite(last) ? Date.now() - last : Infinity;
  if (sinceMs > grace * 24 * 60 * 60 * 1000) {
    return {
      ok: false, state: 'grace_exceeded',
      reason: `Han pasado más de ${grace} días sin verificar la licencia. Conéctate a internet para continuar.`,
      info: publicInfo(local)
    };
  }

  // Sugerir verificación online si ya toca (no bloquea el arranque).
  const needsOnlineSoon = sinceMs > VERIFY_INTERVAL_MS;
  return { ok: true, state: 'ok', info: publicInfo(local), needsOnlineSoon };
}

/** Libera la activación de esta máquina en el servidor y borra el archivo local. */
async function deactivate(app) {
  const { hwid } = computeHardwareId();
  const local = readLocal(app, hwid);
  if (local && !local.__tampered && local.licenseKey) {
    try { await postServer('/api/licenses/deactivate', { licenseKey: local.licenseKey, hwid }); }
    catch (_e) { /* offline: igual borramos local para permitir reactivar en otra máquina */ }
  }
  clearLocal(app);
  return { ok: true };
}

/** Proyección segura para la UI (sin token ni checksum). */
function publicInfo(p) {
  if (!p) return null;
  let daysRemaining = null;
  if (p.expiresAt) {
    const t = Date.parse(p.expiresAt);
    if (Number.isFinite(t)) daysRemaining = Math.ceil((t - Date.now()) / (24 * 60 * 60 * 1000));
  }
  return {
    type: p.type || null,
    status: p.status || 'active',
    expiresAt: p.expiresAt || null,
    customerName: p.customerName || null,
    features: p.features || [],
    daysRemaining,
    isTrial: p.type === 'trial',
    isPermanent: p.type === 'permanent',
    lastVerifiedAt: p.lastVerifiedAt || null,
    gracePeriodDays: Number(p.gracePeriodDays) || DEFAULT_GRACE_DAYS
  };
}

module.exports = {
  computeHardwareId,
  licenseFilePath,
  readLocal,
  writeLocal,
  clearLocal,
  verifyTokenOffline,
  activate,
  verifyOnline,
  evaluate,
  deactivate,
  publicInfo,
  serverUrl,
  VERIFY_INTERVAL_MS,
  DEFAULT_GRACE_DAYS
};
