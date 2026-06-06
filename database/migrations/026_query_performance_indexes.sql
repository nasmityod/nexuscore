-- Índices para filtros por estado+fecha, liquidaciones Cashea y líneas por producto.

CREATE INDEX IF NOT EXISTS idx_ventas_estado_fecha ON ventas (estado, fecha_venta);

CREATE INDEX IF NOT EXISTS idx_ventas_usuario_id ON ventas (usuario_id);

CREATE INDEX IF NOT EXISTS idx_ventas_cashea_liq_batch_id ON ventas_cashea (liq_batch_id)
WHERE liq_batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_detalles_ventas_prod_venta ON detalles_ventas (producto_id, venta_id);
