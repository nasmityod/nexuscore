-- Nexus-Core 009: matriz de permisos por rol + rol vendedor
-- Idempotente: puede ejecutarse en bootstrap (BD nueva) o vía parche 009.

INSERT INTO roles (nombre, permisos)
VALUES (
  'vendedor',
  '{"dashboard":true,"pos_sales":true,"ventas_ver":true,"ventas_anular":false,"caja_operar":false,"clientes_ver":true,"clientes_edit":false,"inventario_ver":true,"inventario_edit":false,"compras_all":false,"proveedores_all":false,"reportes_all":false,"config_read":false,"config_write":false,"tasas_ver":true,"usuarios_all":false,"pdf_ver":true}'::jsonb
)
ON CONFLICT (nombre) DO UPDATE SET permisos = EXCLUDED.permisos;

UPDATE roles SET permisos = '{"all":true}'::jsonb WHERE nombre = 'admin';

UPDATE roles SET permisos = '{"dashboard":true,"pos_sales":true,"ventas_ver":true,"ventas_anular":false,"caja_operar":true,"clientes_ver":true,"clientes_edit":true,"inventario_ver":true,"inventario_edit":false,"compras_all":false,"proveedores_all":false,"reportes_all":true,"config_read":true,"config_write":false,"tasas_ver":true,"usuarios_all":false,"pdf_ver":true}'::jsonb WHERE nombre = 'cajero';

UPDATE roles SET permisos = '{"dashboard":true,"pos_sales":false,"ventas_ver":true,"ventas_anular":false,"caja_operar":false,"clientes_ver":false,"clientes_edit":false,"inventario_ver":true,"inventario_edit":true,"compras_all":true,"proveedores_all":true,"reportes_all":false,"config_read":false,"config_write":false,"tasas_ver":true,"usuarios_all":false,"pdf_ver":true}'::jsonb WHERE nombre = 'almacenista';

UPDATE roles SET permisos = '{"dashboard":true,"pos_sales":true,"ventas_ver":true,"ventas_anular":true,"caja_operar":true,"clientes_ver":true,"clientes_edit":true,"inventario_ver":true,"inventario_edit":true,"compras_all":true,"proveedores_all":true,"reportes_all":true,"config_read":true,"config_write":true,"tasas_ver":true,"usuarios_all":true,"pdf_ver":true}'::jsonb WHERE nombre = 'supervisor';
