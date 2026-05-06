'use strict';

/**
 * POST /api/license/generate
 *
 * Endpoint PRIVADO — solo lo llamas TÚ desde Postman, curl o tu panel.
 * Firma un payload Ed25519 con la clave privada que vive en Vercel.
 * El cliente solo recibe la clave resultante, nunca la clave privada.
 *
 * Autenticación: header  Authorization: Bearer <NEXUS_ADMIN_API_KEY>
 *
 * Body JSON:
 *   hwid        string  requerido   Hardware ID del equipo del cliente
 *   empresa     string  requerido   Nombre del negocio del cliente
 *   edition     string  opcional    "basico" | "profesional" | "enterprise"  (default: "profesional")
 *   expiraEn    string  opcional    "YYYY-MM-DD" — null / omitir = perpetua
 */

const { createPrivateKey, sign } = require('crypto');

// ── Helpers ────────────────────────────────────────────────────────────────

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sha256(str) {
  return require('crypto').createHash('sha256').update(str).digest('hex');
}

// ── Handler principal ──────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // Solo POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  // Autenticación
  const adminKey = process.env.NEXUS_ADMIN_API_KEY;
  if (!adminKey) {
    return res.status(500).json({ error: 'Servidor mal configurado: falta NEXUS_ADMIN_API_KEY' });
  }
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${adminKey}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  // Clave privada
  const privatePem = process.env.NEXUS_LICENSE_PRIVATE_KEY;
  if (!privatePem) {
    return res.status(500).json({ error: 'Servidor mal configurado: falta NEXUS_LICENSE_PRIVATE_KEY' });
  }

  // Parsear body
  const { hwid, empresa, edition, expiraEn } = req.body || {};
  if (!hwid || !String(hwid).trim()) {
    return res.status(400).json({ error: 'El campo "hwid" es obligatorio' });
  }
  if (!empresa || !String(empresa).trim()) {
    return res.status(400).json({ error: 'El campo "empresa" es obligatorio' });
  }

  // Validar expiraEn si se provee
  if (expiraEn) {
    const d = new Date(expiraEn);
    if (Number.isNaN(d.getTime())) {
      return res.status(400).json({ error: 'expiraEn debe ser YYYY-MM-DD o null' });
    }
    if (d < new Date()) {
      return res.status(400).json({ error: 'La fecha de expiración ya pasó' });
    }
  }

  try {
    // Construir payload
    const payload = {
      h:   sha256(hwid.trim()),          // hash del HWID (no reversible)
      e:   empresa.trim(),
      ed:  edition  || 'profesional',
      ex:  expiraEn || null,             // null = perpetua
      iat: Math.floor(Date.now() / 1000) // timestamp de emisión
    };

    const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)));

    // Firmar con clave privada Ed25519
    const privKey = createPrivateKey(privatePem.replace(/\\n/g, '\n'));
    const signature = sign(null, Buffer.from(payloadB64), privKey);
    const sigB64    = b64url(signature);

    const licenseKey = `NC1.${payloadB64}.${sigB64}`;

    // Registrar en log (Vercel lo captura en Functions → Logs)
    console.log('[license:generate]', {
      hwid:     hwid.trim().slice(0, 8) + '...',
      empresa:  payload.e,
      edition:  payload.ed,
      expira:   payload.ex || 'perpetua',
      emitida:  new Date().toISOString(),
    });

    return res.status(200).json({
      ok: true,
      licenseKey,
      info: {
        empresa:  payload.e,
        edition:  payload.ed,
        expira:   payload.ex || 'Perpetua',
        emitida:  new Date(payload.iat * 1000).toISOString(),
      },
    });

  } catch (err) {
    console.error('[license:generate] Error al firmar:', err.message);
    return res.status(500).json({ error: 'Error interno al generar la licencia' });
  }
};
