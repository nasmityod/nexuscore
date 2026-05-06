-- ============================================
-- 019_stock_constraints.sql
-- Integridad fuerte de stock: nunca negativo + guarda en trigger
-- ============================================

-- 1) Constraint a nivel BD: stock_actual no puede quedar negativo
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'productos' AND constraint_name = 'chk_productos_stock_no_negativo'
  ) THEN
    ALTER TABLE productos
      ADD CONSTRAINT chk_productos_stock_no_negativo
      CHECK (stock_actual >= 0) NOT VALID;

    -- Validar el constraint solo si todos los productos cumplen.
    -- Si alguno tiene stock negativo histórico, lo dejamos NOT VALID
    -- para no romper la migración; un reporte separado los corrige.
    BEGIN
      ALTER TABLE productos
        VALIDATE CONSTRAINT chk_productos_stock_no_negativo;
    EXCEPTION WHEN check_violation THEN
      RAISE NOTICE 'Hay productos con stock negativo. Constraint queda NOT VALID. Corregir manualmente.';
    END;
  END IF;
END $$;

-- 2) Reemplazar el trigger de venta con guarda explícita
CREATE OR REPLACE FUNCTION actualizar_stock_venta()
RETURNS TRIGGER AS $$
DECLARE
    v_prev DECIMAL(12,3);
    v_user INTEGER;
    v_estado VARCHAR(20);
BEGIN
    IF NEW.producto_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT estado, usuario_id INTO STRICT v_estado, v_user
    FROM ventas WHERE id = NEW.venta_id;

    IF v_estado = 'anulada' THEN
        RETURN NEW;
    END IF;

    -- Lock + lectura de stock previo
    SELECT stock_actual INTO STRICT v_prev
    FROM productos WHERE id = NEW.producto_id
    FOR UPDATE;

    -- Guarda explícita: rechazar si la venta dejaría stock negativo
    IF (v_prev - NEW.cantidad) < 0 THEN
        RAISE EXCEPTION 'STOCK_INSUFICIENTE: producto %, disponible %, solicitado %',
            NEW.producto_id, v_prev, NEW.cantidad
            USING ERRCODE = 'check_violation';
    END IF;

    UPDATE productos
    SET stock_actual = stock_actual - NEW.cantidad,
        actualizado_en = NOW()
    WHERE id = NEW.producto_id;

    INSERT INTO ajustes_inventario (
        producto_id, lote_id, tipo,
        cantidad, cantidad_anterior, cantidad_nueva,
        costo_unitario_usd, referencia_id, referencia_tipo, usuario_id
    ) VALUES (
        NEW.producto_id, NEW.lote_id, 'salida_venta',
        NEW.cantidad, v_prev, v_prev - NEW.cantidad,
        NEW.costo_unitario_usd, NEW.venta_id, 'venta', v_user
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- El trigger ya existe y apunta a la función con el mismo nombre,
-- por lo que CREATE OR REPLACE FUNCTION basta.
