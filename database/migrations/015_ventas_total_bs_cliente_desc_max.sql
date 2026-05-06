-- Auditoría: total Bs declarado por el cliente vs total_bs servidor (fuente de verdad).
ALTER TABLE ventas
  ADD COLUMN IF NOT EXISTS total_bs_cliente DECIMAL(16,2);

COMMENT ON COLUMN ventas.total_bs_cliente IS
  'Total Bs enviado por el cliente al registrar la venta (huella forense). total_bs es el valor calculado en servidor.';

-- Tope global de descuento % en cabecera de venta (roles restringidos; admin/supervisor sin límite práctico en código).
INSERT INTO configuracion (clave, valor, categoria)
VALUES ('venta_descuento_max_pct', '25', 'ventas')
ON CONFLICT (clave) DO NOTHING;
