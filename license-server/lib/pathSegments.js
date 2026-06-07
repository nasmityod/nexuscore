'use strict';

/**
 * Segmentos de ruta para routers catch-all.
 * En Vercel (sin Next.js) los rewrites envían todo a cada api/.../index.js;
 * el path real se lee desde req.url con apiPrefix.
 */
function pathSegments(req, apiPrefix) {
  if (apiPrefix) {
    const pathname = String(req.url || '').split('?')[0];
    const base = String(apiPrefix).replace(/\/$/, '');
    if (pathname === base) return [];
    const needle = base + '/';
    if (pathname.startsWith(needle)) {
      return pathname
        .slice(needle.length)
        .split('/')
        .filter(Boolean)
        .map((s) => decodeURIComponent(s));
    }
  }

  const p = req.query && req.query.path;
  if (p == null || p === '') return [];
  if (Array.isArray(p)) return p.map((s) => decodeURIComponent(String(s)));
  return String(p).split('/').filter(Boolean).map((s) => decodeURIComponent(s));
}

module.exports = { pathSegments };
