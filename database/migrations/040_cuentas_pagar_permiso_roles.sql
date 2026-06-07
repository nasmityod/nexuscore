-- 040: Permiso cuentas_pagar_all en matriz de roles + integridad CxP por compra
-- Idempotente: usa jsonb || merge y CREATE UNIQUE INDEX IF NOT EXISTS.
--
-- Contexto:
--   El módulo Cuentas por Pagar (parche 039) define el permiso 'cuentas_pagar_all',
--   pero la matriz de permisos persistida en roles.permisos (parches 009/023) no lo
--   contenía. Sin esta clave, el JWT emitido en login no la incluye y el frontend
--   oculta el menú a los roles que deberían operar CxP (almacenista, supervisor).

-- 1. Roles que operan compras/proveedores también gestionan sus cuentas por pagar.
UPDATE roles
   SET permisos = permisos || '{"cuentas_pagar_all":true}'::jsonb
 WHERE nombre IN ('almacenista', 'supervisor')
   AND COALESCE((permisos ->> 'cuentas_pagar_all')::boolean, FALSE) IS DISTINCT FROM TRUE;

-- 2. Roles que NO gestionan CxP: dejar la clave explícita en false (solo si falta),
--    para que la UI de permisos pueda mostrar/editar el toggle de forma consistente.
UPDATE roles
   SET permisos = permisos || '{"cuentas_pagar_all":false}'::jsonb
 WHERE nombre IN ('vendedor', 'cajero')
   AND NOT (permisos ? 'cuentas_pagar_all');

-- 3. Integridad: una compra solo puede generar UNA cuenta por pagar.
--    Refuerza a nivel de BD lo que la ruta /api/compras/:id/recibir ya valida.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cuentas_pagar_compra_unica
  ON cuentas_pagar(compra_id)
  WHERE compra_id IS NOT NULL;
