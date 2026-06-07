'use strict';

/**
 * Permisos por clave (valor true = permitido).
 * Se usa como respaldo si el JWT no trae `permisos` (sesiones antiguas).
 * La fuente de verdad preferida es roles.permisos en BD (parche 009).
 */
const FALLBACK_BY_ROLE = {
  admin: { all: true },
  vendedor: {
    dashboard: true,
    pos_sales: true,
    ventas_ver: true,
    ventas_anular: false,
    caja_operar: false,
    clientes_ver: true,
    clientes_edit: false,
    inventario_ver: true,
    inventario_edit: false,
    compras_all: false,
    proveedores_all: false,
    cuentas_pagar_all: false,
    reportes_all: false,
    config_read: false,
    config_write: false,
    tasas_ver: true,
    tasas_edit: false,
    usuarios_all: false,
    pdf_ver: true
  },
  cajero: {
    dashboard: true,
    pos_sales: true,
    ventas_ver: true,
    ventas_anular: false,
    caja_operar: true,
    clientes_ver: true,
    clientes_edit: true,
    inventario_ver: true,
    inventario_edit: false,
    compras_all: false,
    proveedores_all: false,
    cuentas_pagar_all: false,
    reportes_all: true,
    config_read: true,
    config_write: false,
    tasas_ver: true,
    tasas_edit: false,
    usuarios_all: false,
    pdf_ver: true
  },
  almacenista: {
    dashboard: true,
    pos_sales: false,
    ventas_ver: true,
    ventas_anular: false,
    caja_operar: false,
    clientes_ver: false,
    clientes_edit: false,
    inventario_ver: true,
    inventario_edit: true,
    compras_all: true,
    proveedores_all: true,
    cuentas_pagar_all: true,
    reportes_all: false,
    config_read: false,
    config_write: false,
    tasas_ver: true,
    tasas_edit: false,
    usuarios_all: false,
    pdf_ver: true
  },
  supervisor: {
    dashboard: true,
    pos_sales: true,
    ventas_ver: true,
    ventas_anular: true,
    caja_operar: true,
    clientes_ver: true,
    clientes_edit: true,
    inventario_ver: true,
    inventario_edit: true,
    compras_all: true,
    proveedores_all: true,
    cuentas_pagar_all: true,
    reportes_all: true,
    config_read: true,
    config_write: true,
    tasas_ver: true,
    tasas_edit: false,
    usuarios_all: true,
    pdf_ver: true,
    cashea_admin: true
  }
};

module.exports = { FALLBACK_BY_ROLE };
