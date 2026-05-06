-- ============================================
-- NEXUS-CORE DATABASE SCHEMA v1.0
-- PostgreSQL 12+
-- Multimoneda Venezuela — migración inicial
-- ============================================

-- CONFIGURACIÓN DEL SISTEMA
CREATE TABLE configuracion (
    id SERIAL PRIMARY KEY,
    clave VARCHAR(100) UNIQUE NOT NULL,
    valor TEXT NOT NULL,
    descripcion TEXT,
    categoria VARCHAR(50),
    actualizado_en TIMESTAMP DEFAULT NOW()
);

INSERT INTO configuracion (clave, valor, categoria) VALUES
('tasa_bcv',      '489.5547', 'moneda'),
('tasa_usd', '625.0000', 'moneda'),
('margen_ganancia_default', '30', 'precios'),
('margen_ganancia_minimo',  '5',  'precios'),
('nombre_empresa',    'Mi Local',       'empresa'),
('rif_empresa',       'J-000000000',    'empresa'),
('direccion_empresa', '',               'empresa'),
('telefono_empresa',  '',               'empresa'),
('moneda_principal',  'USD',            'moneda'),
('impuesto_iva',      '0',              'impuestos'),
('stock_alerta_dias', '7',              'alertas'),
('backup_automatico',        'true',    'sistema'),
('backup_intervalo_horas',   '24',      'sistema');

-- USUARIOS Y ROLES
CREATE TABLE roles (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(50) UNIQUE NOT NULL,
    permisos JSONB NOT NULL DEFAULT '{}'::JSONB
);

INSERT INTO roles (nombre, permisos) VALUES
('admin', '{"all": true}'::JSONB),
('cajero', '{"ventas": true, "inventario": false}'::JSONB),
('almacenista', '{"ventas": false, "inventario": true}'::JSONB),
('supervisor', '{"ventas": true, "inventario": true, "reportes": true}'::JSONB);

CREATE TABLE usuarios (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    nombre_completo VARCHAR(100) NOT NULL,
    rol_id INTEGER REFERENCES roles(id),
    activo BOOLEAN DEFAULT TRUE,
    ultimo_acceso TIMESTAMP,
    creado_en TIMESTAMP DEFAULT NOW()
);

-- CATEGORÍAS (jerárquicas)
CREATE TABLE categorias (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    descripcion TEXT,
    categoria_padre_id INTEGER REFERENCES categorias(id),
    icono VARCHAR(50),
    color_hex VARCHAR(7) DEFAULT '#6366f1',
    activa BOOLEAN DEFAULT TRUE,
    creado_en TIMESTAMP DEFAULT NOW()
);

-- PROVEEDORES
CREATE TABLE proveedores (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(150) NOT NULL,
    rif VARCHAR(20),
    contacto_nombre VARCHAR(100),
    telefono VARCHAR(20),
    email VARCHAR(100),
    direccion TEXT,
    pais VARCHAR(50) DEFAULT 'Venezuela',
    moneda_trabajo VARCHAR(3) DEFAULT 'USD',
    condicion_pago VARCHAR(50),
    notas TEXT,
    activo BOOLEAN DEFAULT TRUE,
    creado_en TIMESTAMP DEFAULT NOW()
);

-- PRODUCTOS
CREATE TABLE productos (
    id SERIAL PRIMARY KEY,
    codigo_barras VARCHAR(50) UNIQUE,
    codigo_interno VARCHAR(30) UNIQUE,
    nombre VARCHAR(200) NOT NULL,
    descripcion TEXT,
    categoria_id INTEGER REFERENCES categorias(id),
    proveedor_id INTEGER REFERENCES proveedores(id),

    stock_actual DECIMAL(12,3) DEFAULT 0,
    stock_minimo DECIMAL(12,3) DEFAULT 1,
    stock_maximo DECIMAL(12,3),
    unidad_medida VARCHAR(20) DEFAULT 'unidad',

    costo_usd               DECIMAL(12,4) DEFAULT 0,
    costo_promedio_ponderado_usd DECIMAL(12,4) DEFAULT 0,

    margen_ganancia_pct     DECIMAL(5,2) DEFAULT 30,

    precio_manual_usd       DECIMAL(12,4),
    precio_mayorista_usd    DECIMAL(12,4),
    precio_especial_usd     DECIMAL(12,4),

    aplica_iva BOOLEAN DEFAULT TRUE,

    maneja_lotes     BOOLEAN DEFAULT FALSE,
    fecha_vencimiento DATE,

    imagen_path       VARCHAR(255),
    ubicacion_almacen VARCHAR(50),
    notas             TEXT,
    activo            BOOLEAN DEFAULT TRUE,
    creado_por        INTEGER REFERENCES usuarios(id),
    creado_en         TIMESTAMP DEFAULT NOW(),
    actualizado_en    TIMESTAMP DEFAULT NOW()
);

-- LOTES DE PRODUCTOS
CREATE TABLE lotes_producto (
    id SERIAL PRIMARY KEY,
    producto_id INTEGER REFERENCES productos(id),
    numero_lote VARCHAR(50),
    fecha_vencimiento DATE,
    cantidad_inicial DECIMAL(12,3),
    cantidad_disponible DECIMAL(12,3),
    costo_usd DECIMAL(12,4),
    fecha_entrada TIMESTAMP DEFAULT NOW()
);

-- CLIENTES
CREATE TABLE clientes (
    id SERIAL PRIMARY KEY,
    tipo VARCHAR(20) DEFAULT 'natural',
    cedula_rif VARCHAR(20) UNIQUE,
    nombre VARCHAR(150) NOT NULL,
    telefono VARCHAR(20),
    email VARCHAR(100),
    direccion TEXT,
    limite_credito_usd DECIMAL(12,2) DEFAULT 0,
    descuento_habitual_porcentaje DECIMAL(5,2) DEFAULT 0,
    saldo_deuda_usd DECIMAL(12,2) DEFAULT 0,
    notas TEXT,
    activo BOOLEAN DEFAULT TRUE,
    creado_en TIMESTAMP DEFAULT NOW()
);

-- CAJAS / TERMINALES POS
CREATE TABLE cajas (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(50) NOT NULL,
    ubicacion VARCHAR(100),
    activa BOOLEAN DEFAULT TRUE
);

-- SESIONES DE CAJA
CREATE TABLE sesiones_caja (
    id SERIAL PRIMARY KEY,
    caja_id INTEGER REFERENCES cajas(id),
    usuario_id INTEGER REFERENCES usuarios(id),
    fecha_apertura TIMESTAMP DEFAULT NOW(),
    fecha_cierre TIMESTAMP,
    monto_apertura_usd DECIMAL(12,2) DEFAULT 0,
    monto_apertura_bs DECIMAL(14,2) DEFAULT 0,
    monto_cierre_usd DECIMAL(12,2),
    monto_cierre_bs DECIMAL(14,2),
    tasa_dia DECIMAL(10,4) NOT NULL,
    notas_cierre TEXT,
    estado VARCHAR(20) DEFAULT 'abierta'
);

-- VENTAS (cabecera)
CREATE TABLE ventas (
    id SERIAL PRIMARY KEY,
    numero_venta VARCHAR(20) UNIQUE NOT NULL,
    sesion_caja_id INTEGER REFERENCES sesiones_caja(id),
    cliente_id INTEGER REFERENCES clientes(id),
    usuario_id INTEGER REFERENCES usuarios(id),

    subtotal_usd DECIMAL(12,4) DEFAULT 0,
    descuento_porcentaje DECIMAL(5,2) DEFAULT 0,
    descuento_monto_usd DECIMAL(12,4) DEFAULT 0,
    iva_porcentaje DECIMAL(5,2) DEFAULT 0,
    iva_monto_usd DECIMAL(12,4) DEFAULT 0,
    total_usd DECIMAL(12,4) DEFAULT 0,
    total_bs DECIMAL(16,2) DEFAULT 0,
    tasa_cambio_aplicada DECIMAL(10,4) NOT NULL,

    metodo_pago VARCHAR(30),
    pagos JSONB DEFAULT '[]'::JSONB,

    estado VARCHAR(20) DEFAULT 'completada',
    motivo_anulacion TEXT,
    notas TEXT,

    fecha_venta TIMESTAMP DEFAULT NOW(),
    fecha_anulacion TIMESTAMP,
    anulada_por INTEGER REFERENCES usuarios(id)
);

-- DETALLE DE VENTAS
CREATE TABLE detalles_ventas (
    id SERIAL PRIMARY KEY,
    venta_id INTEGER REFERENCES ventas(id) ON DELETE CASCADE,
    producto_id INTEGER REFERENCES productos(id),
    lote_id INTEGER REFERENCES lotes_producto(id),

    cantidad DECIMAL(12,3) NOT NULL,
    precio_unitario_usd DECIMAL(12,4) NOT NULL,
    costo_unitario_usd DECIMAL(12,4) NOT NULL,
    descuento_porcentaje DECIMAL(5,2) DEFAULT 0,
    subtotal_usd DECIMAL(12,4) NOT NULL,

    margen_contribucion_usd DECIMAL(12,4),
    margen_porcentaje DECIMAL(5,2)
);

-- VENTAS EN SUSPENSO
CREATE TABLE ventas_suspendidas (
    id SERIAL PRIMARY KEY,
    referencia VARCHAR(50),
    usuario_id INTEGER REFERENCES usuarios(id),
    sesion_caja_id INTEGER REFERENCES sesiones_caja(id),
    items JSONB NOT NULL,
    cliente_id INTEGER REFERENCES clientes(id),
    subtotal_usd DECIMAL(12,4),
    tasa_momento DECIMAL(10,4),
    creado_en TIMESTAMP DEFAULT NOW()
);

-- AJUSTES DE INVENTARIO
CREATE TABLE ajustes_inventario (
    id SERIAL PRIMARY KEY,
    producto_id INTEGER REFERENCES productos(id),
    lote_id INTEGER REFERENCES lotes_producto(id),
    tipo VARCHAR(30) NOT NULL,

    cantidad DECIMAL(12,3) NOT NULL,
    cantidad_anterior DECIMAL(12,3),
    cantidad_nueva DECIMAL(12,3),
    costo_unitario_usd DECIMAL(12,4),

    referencia_id INTEGER,
    referencia_tipo VARCHAR(20),

    motivo TEXT,
    usuario_id INTEGER REFERENCES usuarios(id),
    fecha TIMESTAMP DEFAULT NOW()
);

-- COMPRAS
CREATE TABLE compras (
    id SERIAL PRIMARY KEY,
    numero_compra VARCHAR(20) UNIQUE NOT NULL,
    proveedor_id INTEGER REFERENCES proveedores(id),
    usuario_id INTEGER REFERENCES usuarios(id),

    subtotal_usd DECIMAL(12,4) DEFAULT 0,
    flete_usd DECIMAL(12,4) DEFAULT 0,
    arancel_usd DECIMAL(12,4) DEFAULT 0,
    total_usd DECIMAL(12,4) DEFAULT 0,
    total_bs DECIMAL(16,2) DEFAULT 0,
    tasa_cambio DECIMAL(10,4),

    estado VARCHAR(20) DEFAULT 'pendiente',
    fecha_compra TIMESTAMP DEFAULT NOW(),
    fecha_recepcion TIMESTAMP,
    notas TEXT
);

CREATE TABLE detalles_compras (
    id SERIAL PRIMARY KEY,
    compra_id INTEGER REFERENCES compras(id) ON DELETE CASCADE,
    producto_id INTEGER REFERENCES productos(id),
    cantidad_pedida DECIMAL(12,3),
    cantidad_recibida DECIMAL(12,3) DEFAULT 0,
    costo_unitario_usd DECIMAL(12,4),
    subtotal_usd DECIMAL(12,4)
);

-- CUENTAS POR COBRAR
CREATE TABLE cuentas_cobrar (
    id SERIAL PRIMARY KEY,
    venta_id INTEGER REFERENCES ventas(id),
    cliente_id INTEGER REFERENCES clientes(id),
    monto_original_usd DECIMAL(12,4),
    monto_pagado_usd DECIMAL(12,4) DEFAULT 0,
    saldo_pendiente_usd DECIMAL(12,4),
    fecha_vencimiento DATE,
    estado VARCHAR(20) DEFAULT 'pendiente',
    creado_en TIMESTAMP DEFAULT NOW()
);

-- PAGOS DE CUENTAS POR COBRAR
CREATE TABLE pagos_credito (
    id SERIAL PRIMARY KEY,
    cuenta_cobrar_id INTEGER REFERENCES cuentas_cobrar(id),
    monto_usd DECIMAL(12,4),
    monto_bs DECIMAL(14,2),
    tasa_cambio DECIMAL(10,4),
    metodo_pago VARCHAR(30),
    referencia VARCHAR(100),
    usuario_id INTEGER REFERENCES usuarios(id),
    fecha TIMESTAMP DEFAULT NOW()
);

-- AUDITORÍA
CREATE TABLE auditoria (
    id BIGSERIAL PRIMARY KEY,
    usuario_id INTEGER REFERENCES usuarios(id),
    accion VARCHAR(100) NOT NULL,
    tabla_afectada VARCHAR(50),
    registro_id INTEGER,
    datos_anteriores JSONB,
    datos_nuevos JSONB,
    ip_address VARCHAR(45),
    fecha TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- ÍNDICES
-- ============================================
CREATE INDEX idx_productos_barcode ON productos(codigo_barras);
CREATE INDEX idx_productos_categoria ON productos(categoria_id);
CREATE INDEX idx_productos_stock ON productos(stock_actual) WHERE activo = TRUE;
CREATE INDEX idx_ventas_fecha ON ventas(fecha_venta);
CREATE INDEX idx_ventas_cliente ON ventas(cliente_id);
CREATE INDEX idx_ventas_estado ON ventas(estado);
CREATE INDEX idx_detalles_venta ON detalles_ventas(venta_id);
CREATE INDEX idx_detalles_producto ON detalles_ventas(producto_id);
CREATE INDEX idx_ajustes_producto ON ajustes_inventario(producto_id);
CREATE INDEX idx_ajustes_fecha ON ajustes_inventario(fecha);
CREATE INDEX idx_auditoria_usuario ON auditoria(usuario_id);
CREATE INDEX idx_auditoria_fecha ON auditoria(fecha);

-- ============================================
-- FUNCIONES Y TRIGGERS — STOCK AUTOMÁTICO
-- PostgreSQL 12+: EXECUTE { FUNCTION | PROCEDURE } en CREATE TRIGGER
-- ============================================

-- Salida de stock al registrar línea de venta (no aplica si la venta está anulada)
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

    SELECT stock_actual INTO STRICT v_prev
    FROM productos WHERE id = NEW.producto_id
    FOR UPDATE;

    UPDATE productos
    SET stock_actual = stock_actual - NEW.cantidad,
        actualizado_en = NOW()
    WHERE id = NEW.producto_id;

    INSERT INTO ajustes_inventario (
        producto_id,
        lote_id,
        tipo,
        cantidad,
        cantidad_anterior,
        cantidad_nueva,
        costo_unitario_usd,
        referencia_id,
        referencia_tipo,
        usuario_id
    ) VALUES (
        NEW.producto_id,
        NEW.lote_id,
        'salida_venta',
        NEW.cantidad,
        v_prev,
        v_prev - NEW.cantidad,
        NEW.costo_unitario_usd,
        NEW.venta_id,
        'venta',
        v_user
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stock_en_venta
    AFTER INSERT ON detalles_ventas
    FOR EACH ROW
    EXECUTE PROCEDURE actualizar_stock_venta();

-- Costo promedio ponderado y entrada de stock al recibir mercancía (detalle de compra)
CREATE OR REPLACE FUNCTION calcular_costo_promedio()
RETURNS TRIGGER AS $$
DECLARE
    v_stock_actual DECIMAL(12,3);
    v_costo_actual DECIMAL(12,4);
    v_nuevo_costo DECIMAL(12,4);
    v_qty DECIMAL(12,3);
    v_prev DECIMAL(12,3);
BEGIN
    v_qty := COALESCE(NEW.cantidad_recibida, 0);
    IF v_qty <= 0 OR NEW.producto_id IS NULL OR NEW.costo_unitario_usd IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT stock_actual, costo_promedio_ponderado_usd
    INTO v_stock_actual, v_costo_actual
    FROM productos WHERE id = NEW.producto_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    v_prev := v_stock_actual;

    IF (v_stock_actual + v_qty) > 0 THEN
        v_nuevo_costo := (v_stock_actual * v_costo_actual + v_qty * NEW.costo_unitario_usd)
                         / (v_stock_actual + v_qty);
    ELSE
        v_nuevo_costo := NEW.costo_unitario_usd;
    END IF;

    UPDATE productos SET
        stock_actual = stock_actual + v_qty,
        costo_promedio_ponderado_usd = v_nuevo_costo,
        actualizado_en = NOW()
    WHERE id = NEW.producto_id;

    INSERT INTO ajustes_inventario (
        producto_id,
        tipo,
        cantidad,
        cantidad_anterior,
        cantidad_nueva,
        costo_unitario_usd,
        referencia_id,
        referencia_tipo,
        usuario_id
    ) VALUES (
        NEW.producto_id,
        'entrada_compra',
        v_qty,
        v_prev,
        v_prev + v_qty,
        NEW.costo_unitario_usd,
        NEW.compra_id,
        'compra',
        (SELECT usuario_id FROM compras WHERE id = NEW.compra_id)
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_costo_promedio_compra
    AFTER INSERT ON detalles_compras
    FOR EACH ROW
    EXECUTE PROCEDURE calcular_costo_promedio();

