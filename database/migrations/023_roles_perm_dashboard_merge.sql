-- Nexus-Core 023: corrige roles cuyo JSON no incluye «dashboard» (semilla vieja u objeto vacío).
-- Mezcla con la matriz 009 mediante || para no perder claves posteriores (tasas_edit, cashea_admin, etc.).
-- No afecta a «admin» (no está listado aquí).

UPDATE roles
SET permisos = COALESCE(permisos, '{}'::jsonb)
  || '{"dashboard":true,"pos_sales":true,"ventas_ver":true,"ventas_anular":false,"caja_operar":false,"clientes_ver":true,"clientes_edit":false,"inventario_ver":true,"inventario_edit":false,"compras_all":false,"proveedores_all":false,"reportes_all":false,"config_read":false,"config_write":false,"tasas_ver":true,"usuarios_all":false,"pdf_ver":true}'::jsonb
WHERE nombre = 'vendedor'
  AND NOT (COALESCE(permisos, '{}'::jsonb) ? 'dashboard');

UPDATE roles
SET permisos = COALESCE(permisos, '{}'::jsonb)
  || '{"dashboard":true,"pos_sales":true,"ventas_ver":true,"ventas_anular":false,"caja_operar":true,"clientes_ver":true,"clientes_edit":true,"inventario_ver":true,"inventario_edit":false,"compras_all":false,"proveedores_all":false,"reportes_all":true,"config_read":true,"config_write":false,"tasas_ver":true,"usuarios_all":false,"pdf_ver":true}'::jsonb
WHERE nombre = 'cajero'
  AND NOT (COALESCE(permisos, '{}'::jsonb) ? 'dashboard');

UPDATE roles
SET permisos = COALESCE(permisos, '{}'::jsonb)
  || '{"dashboard":true,"pos_sales":false,"ventas_ver":true,"ventas_anular":false,"caja_operar":false,"clientes_ver":false,"clientes_edit":false,"inventario_ver":true,"inventario_edit":true,"compras_all":true,"proveedores_all":true,"reportes_all":false,"config_read":false,"config_write":false,"tasas_ver":true,"usuarios_all":false,"pdf_ver":true}'::jsonb
WHERE nombre = 'almacenista'
  AND NOT (COALESCE(permisos, '{}'::jsonb) ? 'dashboard');

UPDATE roles
SET permisos = COALESCE(permisos, '{}'::jsonb)
  || '{"dashboard":true,"pos_sales":true,"ventas_ver":true,"ventas_anular":true,"caja_operar":true,"clientes_ver":true,"clientes_edit":true,"inventario_ver":true,"inventario_edit":true,"compras_all":true,"proveedores_all":true,"reportes_all":true,"config_read":true,"config_write":true,"tasas_ver":true,"usuarios_all":true,"pdf_ver":true}'::jsonb
WHERE nombre = 'supervisor'
  AND NOT (COALESCE(permisos, '{}'::jsonb) ? 'dashboard');
