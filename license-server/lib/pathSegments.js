'use strict';

/** Normaliza req.query.path de un catch-all Vercel ([...path]) a segmentos decodificados. */
function pathSegments(req) {
  const p = req.query && req.query.path;
  if (p == null || p === '') return [];
  if (Array.isArray(p)) return p.map((s) => decodeURIComponent(String(s)));
  return String(p).split('/').filter(Boolean).map((s) => decodeURIComponent(s));
}

module.exports = { pathSegments };
