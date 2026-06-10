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
const HWID_CACHE_FILE = 'hwid_cache.json';
const HWID_CACHE_MAX = 5;
const FILE_VERSION = 1;
const VERIFY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 h
const DEFAULT_GRACE_DAYS = 7;
const CIM_TIMEOUT_MS = 12000;
const CIM_RECOVERY_TIMEOUT_MS = 30000;

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
function isUsableHardwareValue(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  const u = v.toUpperCase();
  return !/^0+$/.test(v)
    && u !== 'TO BE FILLED BY O.E.M.'
    && u !== 'NONE'
    && u !== 'UNKNOWN'
    && u !== 'SYSTEM.OBJECT[]';
}

function readWindowsHardwareIds(timeoutMs = CIM_TIMEOUT_MS) {
  if (process.platform !== 'win32') return {};
  try {
    // Una sola invocación de PowerShell que imprime CLAVE=VALOR por línea.
    const ps = [
      '$ErrorActionPreference = "SilentlyContinue"',
      'function Get-HwidVal { param($InputObject) if ($null -eq $InputObject) { return "" } $v = $InputObject | Select-Object -First 1; if ($null -eq $v) { return "" } return ([string]$v).Trim() }',
      '$disks = @(Get-CimInstance Win32_DiskDrive | Where-Object { $_.SerialNumber } | ForEach-Object { ([string]$_.SerialNumber).Trim() } | Where-Object { $_ })',
      'Write-Output ("CPU=" + (Get-HwidVal (Get-CimInstance Win32_Processor).ProcessorId))',
      'Write-Output ("BOARD=" + (Get-HwidVal (Get-CimInstance Win32_BaseBoard).SerialNumber))',
      'Write-Output ("UUID=" + (Get-HwidVal (Get-CimInstance Win32_ComputerSystemProduct).UUID))',
      'Write-Output ("DISK=" + (Get-HwidVal $disks))',
      'Write-Output ("DISKS=" + (($disks | Sort-Object -Unique) -join ","))'
    ].join('; ');
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }
    );
    const ids = {};
    for (const line of String(out).split(/\r?\n/)) {
      const m = line.match(/^([A-Z]+)=(.*)$/);
      if (!m) continue;
      if (m[1] === 'DISKS') {
        const disks = String(m[2] || '')
          .split(',')
          .map((v) => v.trim())
          .filter(isUsableHardwareValue);
        if (disks.length) ids.DISKS = [...new Set(disks)];
      } else if (isUsableHardwareValue(m[2])) {
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
function buildHardwareResult(hw, options = {}) {
  const os = require('os');
  const parts = [];
  const used = [];
  const detail = { cpu: false, board: false, uuid: false, disk: false, mac: false, host: false };
  const disk = Object.prototype.hasOwnProperty.call(options, 'disk') ? options.disk : hw.DISK;
  const allowOsFallback = options.allowOsFallback !== false;

  if (hw.CPU) { parts.push('cpu:' + hw.CPU); used.push('cpu'); detail.cpu = true; }
  if (hw.UUID) { parts.push('uuid:' + hw.UUID); used.push('uuid'); detail.uuid = true; }
  if (hw.BOARD) { parts.push('board:' + hw.BOARD); used.push('board'); detail.board = true; }
  if (disk) { parts.push('disk:' + disk); used.push('disk'); detail.disk = true; }

  // Refuerzo / fallback con identificadores del SO (MAC ordenadas + hostname). Si no hubo
  // identificadores de hardware, estos garantizan un HWID no trivial.
  if (allowOsFallback) {
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
  }

  if (used.length === 0) return null;

  const hwid = crypto.createHash('sha256').update(parts.join('|')).digest('hex');
  return { hwid, components: used, detail };
}

function computeHardwareId() {
  if (_hwidCache) return _hwidCache;
  const hw = readWindowsHardwareIds();
  _hwidCache = buildHardwareResult(hw, { allowOsFallback: true });
  return _hwidCache;
}

function usesWindowsHardware(result) {
  return !!(result && result.detail && (
    result.detail.cpu || result.detail.uuid || result.detail.board || result.detail.disk
  ));
}

function addUniqueHwid(list, hwid) {
  const h = String(hwid || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) return;
  if (!list.includes(h)) list.push(h);
}

function computeWindowsHardwareHwidVariants(timeoutMs = CIM_TIMEOUT_MS) {
  const hw = readWindowsHardwareIds(timeoutMs);
  const out = [];
  const disks = [
    hw.DISK,
    ...(Array.isArray(hw.DISKS) ? hw.DISKS : [])
  ].filter(Boolean);

  const primary = buildHardwareResult(hw, { allowOsFallback: false });
  if (primary && usesWindowsHardware(primary)) addUniqueHwid(out, primary.hwid);

  // Candidato sin disco: permite recuperar si Windows cambió el disco "primero" o si un
  // USB/SSD externo alteró el orden de Win32_DiskDrive.
  const noDisk = buildHardwareResult({ ...hw, DISK: null }, { disk: null, allowOsFallback: false });
  if (noDisk && usesWindowsHardware(noDisk)) addUniqueHwid(out, noDisk.hwid);

  for (const disk of disks) {
    const withDisk = buildHardwareResult({ ...hw, DISK: disk }, { allowOsFallback: false });
    if (withDisk && usesWindowsHardware(withDisk)) addUniqueHwid(out, withDisk.hwid);
  }

  return out;
}

// ── Caché persistente del HWID entre sesiones ─────────────────────────────────
//
// Problema: PowerShell/CIM puede tardar más que su timeout (12 s) en ciertos
// arranques (carga del sistema, actualizaciones en curso, etc.). Cuando ocurre,
// computeHardwareId() cae al fallback MAC/hostname, produciendo un HWID distinto
// al que usó el arranque donde SÍ funcionó CIM. El archivo de licencia queda
// cifrado con el HWID "antiguo" y el nuevo no puede descifrarlo → __tampered.
//
// Solución: persistir el HWID CIM-based en userData/hwid_cache.json. En los
// arranques donde CIM falle, se usa el HWID cacheado → mismo HWID → descifra OK.

function hwidCachePath(app) {
  return path.join(app.getPath('userData'), HWID_CACHE_FILE);
}

function normalizeCachedHwid(hwid) {
  const h = String(hwid || '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(h) ? h : null;
}

/** Lee HWIDs persistidos de sesiones anteriores. Soporta el formato viejo `{ hwid }`. */
function loadHwidCacheCandidates(app) {
  try {
    const p = hwidCachePath(app);
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const out = [];
    if (data && typeof data.hwid === 'string') addUniqueHwid(out, data.hwid);
    if (data && Array.isArray(data.hwids)) {
      for (const h of data.hwids) addUniqueHwid(out, h);
    }
    return out;
  } catch (_e) { return []; }
}

/** Lee el HWID preferido de la última sesión estable. Null si no existe. */
function loadHwidCache(app) {
  const candidates = loadHwidCacheCandidates(app);
  return candidates.length ? candidates[0] : null;
}

/** Persiste HWIDs conocidos, conservando un historial corto para recuperación. Best-effort. */
function saveHwidCache(app, hwid, alsoRemember = []) {
  try {
    const primary = normalizeCachedHwid(hwid);
    if (!primary) return;
    const merged = [];
    addUniqueHwid(merged, primary);
    for (const h of alsoRemember || []) addUniqueHwid(merged, h);
    for (const h of loadHwidCacheCandidates(app)) addUniqueHwid(merged, h);
    fs.writeFileSync(
      hwidCachePath(app),
      JSON.stringify({ hwid: primary, hwids: merged.slice(0, HWID_CACHE_MAX), ts: Date.now() }),
      { mode: 0o600 }
    );
  } catch (_e) { /* caché es best-effort, no bloquea el arranque */ }
}

/**
 * Resuelve el HWID más estable disponible para este arranque:
 *   1. CIM tuvo éxito → usa ese (más estable) y actualiza el caché.
 *   2. CIM falló pero existe caché de sesión anterior → usa el HWID cacheado.
 *   3. Sin caché → usa el fallback MAC/hostname de computeHardwareId().
 *
 * Esta función DEBE usarse en lugar de computeHardwareId().hwid en toda operación
 * que toque el archivo de licencia (evaluate, activate, verifyOnline, deactivate).
 */
function resolveHwid(app) {
  const result = computeHardwareId();
  const usedHardware = usesWindowsHardware(result);

  if (usedHardware) {
    // CIM disponible: es el HWID más estable; persistir para reinicios donde CIM no responda.
    if (app) saveHwidCache(app, result.hwid);
    return result.hwid;
  }

  // CIM no disponible: intentar el HWID de la última sesión exitosa para mantener consistencia.
  if (app) {
    const cached = loadHwidCache(app);
    if (cached) return cached;
  }

  // Sin caché: retornar el fallback MAC/hostname (mejor que nada).
  return result.hwid;
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

function attachLocalMeta(payload, decryptedWithHwid) {
  if (payload && typeof payload === 'object') {
    Object.defineProperty(payload, '__decryptedWithHwid', {
      value: normalizeCachedHwid(decryptedWithHwid),
      enumerable: false,
      configurable: true
    });
  }
  return payload;
}

function stripLocalMeta(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const clean = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!k.startsWith('__')) clean[k] = v;
  }
  return clean;
}

/**
 * Calcula un HWID alternativo basado en MACs de red (mismo algoritmo que el fallback
 * de computeHardwareId cuando CIM falla). Usado para recuperación cuando el HWID
 * primario (CIM) no puede descifrar el archivo (ej: archivo fue cifrado en un arranque
 * donde CIM falló y se usó el fallback MAC, pero ahora CIM sí funciona).
 */
function computeMacFallbackHwid() {
  try {
    const os = require('os');
    const ifaces = os.networkInterfaces();
    const macSet = new Set();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name] || []) {
        if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
          macSet.add(iface.mac.toLowerCase());
        }
      }
    }
    if (macSet.size) {
      return crypto.createHash('sha256').update('mac:' + [...macSet].sort().join(',')).digest('hex');
    }
    return crypto.createHash('sha256').update('host:' + require('os').hostname()).digest('hex');
  } catch (_e) {
    return null;
  }
}

function readLocal(app, hwid) {
  try {
    const p = licenseFilePath(app);
    if (!fs.existsSync(p)) return null;
    const fileObj = JSON.parse(fs.readFileSync(p, 'utf8'));

    // Intento primario: HWID actual (CIM estable o cacheado según resolveHwid).
    try {
      return attachLocalMeta(decryptPayload(fileObj, hwid), hwid);
    } catch (_primaryErr) {
      // El HWID primario no puede descifrar el archivo. Construir lista de candidatos
      // alternativos antes de declarar "manipulado":
      //   1. MAC fallback: cubre el caso inverso (archivo cifrado en arranque con CIM,
      //      ahora se usa MAC por timeout).
      //   2. HWIDs cacheados: cubren transición CIM↔MAC o cambios menores donde el caché
      //      aún tiene el HWID anterior.
      //   3. Relectura CIM extendida: cubre instalaciones pre-parche que no tenían caché y
      //      arrancaron justo cuando PowerShell/CIM estaba lento.
      const candidates = [];
      const macHwid = computeMacFallbackHwid();
      if (macHwid && macHwid !== hwid) candidates.push(macHwid);

      for (const cachedHwid of loadHwidCacheCandidates(app)) {
        if (cachedHwid !== hwid && cachedHwid !== macHwid) candidates.push(cachedHwid);
      }

      for (const candidate of candidates) {
        try {
          const payload = decryptPayload(fileObj, candidate);
          // Recuperación exitosa: recordar ambos. Si el arranque tiene un HWID de hardware
          // real, re-ciframos con ese HWID; si cayó a MAC/host por fallo de CIM, mantenemos
          // el candidato bueno y evitamos convertir un fallo temporal en una reactivación.
          if (usesWindowsHardware(computeHardwareId())) {
            saveHwidCache(app, hwid, [candidate]);
            writeLocal(app, hwid, payload);
          } else {
            saveHwidCache(app, candidate, [hwid]);
          }
          return attachLocalMeta(payload, candidate);
        } catch (_e) {
          // Siguiente candidato.
        }
      }

      const recoveryCandidates = computeWindowsHardwareHwidVariants(CIM_RECOVERY_TIMEOUT_MS);
      for (const candidate of recoveryCandidates) {
        if (!candidate || candidate === hwid || candidates.includes(candidate)) continue;
        try {
          const payload = decryptPayload(fileObj, candidate);
          saveHwidCache(app, candidate, [hwid, ...candidates]);
          return attachLocalMeta(payload, candidate);
        } catch (_e) {
          // Siguiente candidato de recuperación.
        }
      }

      return { __tampered: true };
    }
  } catch (_e) {
    return { __tampered: true };
  }
}

function writeLocal(app, hwid, payload) {
  const p = licenseFilePath(app);
  const enc = encryptPayload(stripLocalMeta(payload), hwid);
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

/** NEXUS-DUAL: contraparte en backend/services/licenciaService.js */
function parseTokenExpiry(ex) {
  if (ex == null || ex === '') return null;
  if (typeof ex === 'number' || /^\d+$/.test(String(ex).trim())) {
    const n = Number(ex);
    if (!Number.isFinite(n)) return null;
    const ms = n < 1e12 ? n * 1000 : n;
    return new Date(ms);
  }
  return new Date(ex);
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
      const exp = parseTokenExpiry(payload.ex);
      if (!exp || Number.isNaN(exp.getTime())) return { ok: false, motivo: 'Fecha de expiración inválida' };
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
  const hwid = resolveHwid(app);
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
  saveHwidCache(app, hwid);
  return { ok: true, info: publicInfo(payload) };
}

/**
 * Verificación periódica online. Actualiza token/estado y lastVerifiedAt.
 * @returns {Promise<{ ok:boolean, blocked?:boolean, reason?:string, info?:object }>}
 */
async function verifyOnline(app) {
  const hwid = resolveHwid(app);
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
    saveHwidCache(app, hwid);
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
 * @returns {{ ok:boolean, state:string, reason?:string, info?:object, needsOnlineSoon?:boolean, licenseKey?:string }}
 *   state: 'none' | 'tampered' | 'foreign' | 'expired' | 'suspended' | 'revoked' |
 *          'grace_exceeded' | 'hwid_drifted' | 'ok'
 *
 *   'hwid_drifted': el token es criptográficamente válido para un HWID alternativo conocido
 *   (cambio CIM↔MAC). Se incluye licenseKey para que evaluateLicenseGate() pueda hacer
 *   re-activación silenciosa sin interrumpir al usuario.
 */
function evaluate(app) {
  // Usar resolveHwid para obtener el HWID más estable disponible (CIM > caché > MAC).
  const hwid = resolveHwid(app);
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
  const currentHasHardware = usesWindowsHardware(computeHardwareId());
  let tokenHwid = hwid;
  let off = verifyTokenOffline(local.token, tokenHwid);
  if (!off.ok) {
    // Antes de rechazar como "otro equipo" o "manipulado", verificar si el token es válido
    // para un HWID alternativo conocido (escenario: HWID derivó entre CIM y MAC entre sesiones).
    // Si el arranque actual no tiene IDs de hardware reales (CIM falló), el alternativo es
    // la identidad buena y podemos continuar offline. Si sí hay hardware real pero difiere,
    // se pide reactivación silenciosa para emitir un token del HWID actual.
    if (/otro equipo/i.test(off.motivo) && local.licenseKey) {
      const altHwids = new Set([
        local.__decryptedWithHwid,
        computeMacFallbackHwid(),
        ...(app ? loadHwidCacheCandidates(app) : [])
      ].filter(h => h && h !== hwid));

      for (const altHwid of altHwids) {
        const altOff = verifyTokenOffline(local.token, altHwid);
        if (altOff.ok) {
          if (!currentHasHardware) {
            tokenHwid = altHwid;
            off = altOff;
            saveHwidCache(app, altHwid, [hwid]);
            break;
          }
          // Token válido para un HWID anterior conocido → HWID derivó, no es fraude.
          return {
            ok: false,
            state: 'hwid_drifted',
            reason: 'El identificador de hardware cambió entre sesiones; reconectando con el servidor...',
            licenseKey: local.licenseKey,
            info: publicInfo(local)
          };
        }
      }
    }

    if (!off.ok) {
      const st = /otro equipo/i.test(off.motivo) ? 'foreign'
        : /vencida|expir/i.test(off.motivo) ? 'expired'
        : 'tampered';
      return { ok: false, state: st, reason: off.motivo, info: publicInfo(local) };
    }
  }
  saveHwidCache(app, tokenHwid, tokenHwid === hwid ? [] : [hwid]);

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
  const hwid = resolveHwid(app);
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
  resolveHwid,
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
