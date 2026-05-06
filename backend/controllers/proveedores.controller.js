'use strict';

const { db } = require('../config/database');
const { asyncHandler, httpError } = require('../utils/asyncHandler');

const INSERTABLE = [
  'nombre',
  'rif',
  'contacto_nombre',
  'telefono',
  'email',
  'direccion',
  'pais',
  'moneda_trabajo',
  'condicion_pago',
  'notas',
  'activo'
];

function normalizeNullable(v) {
  if (v === undefined) return undefined;
  if (v === '' || v === null) return null;
  return v;
}

function proveedoresSearchClause(req, paramIndex) {
  const q = req.query.q ? String(req.query.q).trim() : '';
  if (!q.length) return { clause: '', params: [] };
  return {
    clause: ` AND (
      pr.nombre ILIKE $${paramIndex} OR COALESCE(pr.rif, '') ILIKE $${paramIndex}
      OR COALESCE(pr.contacto_nombre, '') ILIKE $${paramIndex}
      OR COALESCE(pr.telefono, '') ILIKE $${paramIndex}
    )`,
    params: [`%${q}%`]
  };
}

async function list(req, res) {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const mainSearch = proveedoresSearchClause(req, 3);
  const mainParams = [limit, offset, ...mainSearch.params];

  const rows = await db.any(
    `SELECT pr.* FROM proveedores pr WHERE 1=1 ${mainSearch.clause}
     ORDER BY pr.nombre ASC LIMIT $1 OFFSET $2`,
    mainParams
  );

  const cntSearch = proveedoresSearchClause(req, 1);
  const totalRow = await db.one(
    `SELECT COUNT(*)::int AS total FROM proveedores pr WHERE 1=1 ${cntSearch.clause}`,
    cntSearch.params
  );

  res.json({ data: rows, total: totalRow.total, limit, offset });
}

async function getById(req, res) {
  const id = Number(req.params.id);
  if (!id || id < 1) throw httpError(400, 'ID inválido');

  const row = await db.oneOrNone(`SELECT * FROM proveedores WHERE id = $1`, [id]);
  if (!row) throw httpError(404, 'Proveedor no encontrado');
  res.json(row);
}

async function create(req, res) {
  const body = req.body || {};
  if (!body.nombre || String(body.nombre).trim().length === 0) {
    throw httpError(400, 'El nombre es obligatorio');
  }

  const cols = [];
  const vals = [];
  const placeholders = [];

  for (let i = 0; i < INSERTABLE.length; i += 1) {
    const key = INSERTABLE[i];
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    let v = body[key];
    if (key === 'nombre' && typeof v === 'string') v = v.trim();
    if (['rif', 'contacto_nombre', 'telefono', 'email', 'direccion', 'notas', 'condicion_pago'].includes(key)) {
      v = normalizeNullable(v);
    }
    cols.push(key);
    vals.push(v);
    placeholders.push(`$${vals.length}`);
  }

  if (!cols.includes('nombre')) {
    cols.push('nombre');
    vals.push(String(body.nombre).trim());
    placeholders.push(`$${vals.length}`);
  }

  const sql = `INSERT INTO proveedores (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;
  const inserted = await db.one(sql, vals);
  res.status(201).json(inserted);
}

async function update(req, res) {
  const id = Number(req.params.id);
  if (!id || id < 1) throw httpError(400, 'ID inválido');

  const prev = await db.oneOrNone(`SELECT id FROM proveedores WHERE id = $1`, [id]);
  if (!prev) throw httpError(404, 'Proveedor no encontrado');

  const body = req.body || {};
  const pairs = [];
  const vals = [];
  const skip = new Set(['id', 'creado_en']);

  Object.keys(body).forEach((key) => {
    if (skip.has(key)) return;
    if (!INSERTABLE.includes(key)) return;
    pairs.push(`${key} = $${pairs.length + 1}`);
    let v = body[key];
    if (key === 'nombre' && typeof v === 'string') v = v.trim();
    if (['rif', 'contacto_nombre', 'telefono', 'email', 'direccion', 'notas', 'condicion_pago'].includes(key)) {
      v = normalizeNullable(v);
    }
    vals.push(v);
  });

  if (pairs.length === 0) throw httpError(400, 'No hay campos para actualizar');
  vals.push(id);

  const updated = await db.one(
    `UPDATE proveedores SET ${pairs.join(', ')} WHERE id = $${vals.length} RETURNING *`,
    vals
  );

  res.json(updated);
}

async function softDelete(req, res) {
  const id = Number(req.params.id);
  if (!id || id < 1) throw httpError(400, 'ID inválido');

  const updated = await db.oneOrNone(
    `UPDATE proveedores SET activo = FALSE WHERE id = $1 RETURNING *`,
    [id]
  );
  if (!updated) throw httpError(404, 'Proveedor no encontrado');
  res.json(updated);
}

module.exports = {
  list: asyncHandler(list),
  getById: asyncHandler(getById),
  create: asyncHandler(create),
  update: asyncHandler(update),
  softDelete: asyncHandler(softDelete)
};
