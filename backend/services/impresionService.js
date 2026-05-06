'use strict';

/**
 * Módulo H: Impresión directa a impresora térmica sin diálogo del sistema.
 * Usa node-thermal-printer. Si la impresora no está disponible, devuelve gracefully.
 */

let ThermalPrinter, PrinterTypes;
try {
  const ntp = require('node-thermal-printer');
  ThermalPrinter = ntp.printer || ntp.ThermalPrinter || ntp.default;
  PrinterTypes   = ntp.types   || ntp.PrinterTypes;
} catch (e) {
  // Módulo no disponible — modo sin impresora
}

const { db } = require('../config/database');

class ImpresionService {
  /* ─── Obtener config de impresora desde BD ─── */
  static async _getConfig() {
    const rows = await db.any(
      `SELECT clave, valor FROM configuracion WHERE clave IN
       ('impresora_nombre','impresora_interfaz','empresa_nombre','empresa_rif','empresa_telefono','empresa_direccion','impresora_activa')`
    );
    const cfg = {};
    rows.forEach((r) => { cfg[r.clave] = r.valor; });
    return cfg;
  }

  /* ─── Crear instancia de impresora ─── */
  static async _crearImpresora(cfg) {
    if (!ThermalPrinter) throw new Error('node-thermal-printer no está disponible');
    if (cfg.impresora_activa === 'false' || cfg.impresora_activa === '0') {
      throw new Error('Impresora desactivada en configuración');
    }

    const interfaz = cfg.impresora_interfaz || 'tcp://192.168.1.100:9100';
    const tipo = interfaz.startsWith('tcp://') ? (PrinterTypes ? PrinterTypes.EPSON : 'EPSON') : (PrinterTypes ? PrinterTypes.EPSON : 'EPSON');

    const printer = new ThermalPrinter({
      type:      tipo,
      interface: interfaz,
      options:   { timeout: 3000 }
    });

    return printer;
  }

  /* ─── Imprimir ticket de venta ─── */
  static async imprimirTicket(ventaId) {
    try {
      const cfg = await ImpresionService._getConfig();
      const printer = await ImpresionService._crearImpresora(cfg);

      // Cargar datos de la venta
      const venta = await db.oneOrNone(
        `SELECT v.*, c.nombre AS cliente_nombre, u.nombre AS cajero_nombre
         FROM ventas v
         LEFT JOIN clientes c ON c.id = v.cliente_id
         LEFT JOIN usuarios u ON u.id = v.usuario_id
         WHERE v.id = $1`,
        [ventaId]
      );
      if (!venta) throw new Error('Venta no encontrada');

      const detalles = await db.any(
        `SELECT dv.*, p.nombre AS producto_nombre
         FROM detalles_ventas dv
         JOIN productos p ON p.id = dv.producto_id
         WHERE dv.venta_id = $1`,
        [ventaId]
      );

      // Tasas actuales
      const tasas = await db.oneOrNone(
        `SELECT valor::numeric FROM configuracion WHERE clave = 'tasa_usd' LIMIT 1`
      );

      // Formatear números
      const fUsd = (v) => Number(v || 0).toFixed(2);
      const fBs  = (v) => Number(v || 0).toFixed(2);

      // Construir ticket
      printer.alignCenter();
      printer.bold(true);
      printer.setTextSize(1, 1);
      printer.println(String(cfg.empresa_nombre || 'Mi Negocio').toUpperCase());
      printer.bold(false);
      printer.setTextSize(0, 0);
      if (cfg.empresa_rif)       printer.println('RIF: ' + cfg.empresa_rif);
      if (cfg.empresa_telefono)  printer.println('Tel: ' + cfg.empresa_telefono);
      if (cfg.empresa_direccion) printer.println(cfg.empresa_direccion);

      printer.drawLine();
      printer.alignLeft();
      printer.println('Factura: ' + (venta.numero_venta || '#' + venta.id));
      printer.println('Fecha:   ' + new Date(venta.fecha_venta).toLocaleString('es-VE'));
      printer.println('Cajero:  ' + (venta.cajero_nombre || '—'));
      if (venta.cliente_nombre) printer.println('Cliente: ' + venta.cliente_nombre);
      printer.drawLine();

      // Detalle de items
      detalles.forEach((item) => {
        const nombre = String(item.producto_nombre || '').substring(0, 22);
        const subtotal = '$' + fUsd(item.subtotal_usd);
        const espacios = Math.max(1, 32 - nombre.length - subtotal.length);
        printer.println(nombre + ' '.repeat(espacios) + subtotal);
        printer.println('  ' + fUsd(item.cantidad) + ' x $' + fUsd(item.precio_unitario_usd));
      });

      printer.drawLine();

      // Totales
      printer.alignRight();
      printer.println('TOTAL:  $' + fUsd(venta.total_usd) + ' USD');
      printer.println('        Bs. ' + fBs(venta.total_bs));
      if (venta.metodo_pago) printer.println('Pago:   ' + venta.metodo_pago.replace('_', ' ').toUpperCase());

      // Vuelto si aplica
      if (Number(venta.vuelto_usd) > 0) {
        printer.println('Vuelto: $' + fUsd(venta.vuelto_usd) + ' USD');
      }
      if (Number(venta.vuelto_bs) > 0) {
        printer.println('Vuelto: Bs. ' + fBs(venta.vuelto_bs));
      }

      printer.drawLine();
      printer.alignCenter();
      printer.println('¡Gracias por su compra!');
      if (tasas) printer.println('Tasa paralela: ' + Number(tasas.valor).toFixed(4));
      printer.cut();

      await printer.execute();
      return { ok: true };
    } catch (err) {
      // No lanzar el error al usuario — log y continuar
      require('../config/logger').logger.warn('ImpresionService: no se pudo imprimir', { error: err.message });
      return { ok: false, motivo: err.message };
    }
  }

  /* ─── Imprimir cierre de caja ─── */
  static async imprimirCierre(sesionId) {
    try {
      const cfg = await ImpresionService._getConfig();
      const printer = await ImpresionService._crearImpresora(cfg);

      const sesion = await db.oneOrNone(
        `SELECT sc.*, u.nombre AS cajero_nombre
         FROM sesiones_caja sc
         LEFT JOIN usuarios u ON u.id = sc.usuario_id
         WHERE sc.id = $1`,
        [sesionId]
      );
      if (!sesion) throw new Error('Sesión no encontrada');

      printer.alignCenter();
      printer.bold(true);
      printer.println('CIERRE DE CAJA');
      printer.bold(false);
      printer.println(String(cfg.empresa_nombre || 'Mi Negocio').toUpperCase());
      printer.drawLine();
      printer.alignLeft();
      printer.println('Cajero:   ' + (sesion.cajero_nombre || '—'));
      printer.println('Apertura: ' + new Date(sesion.fecha_apertura).toLocaleString('es-VE'));
      printer.println('Cierre:   ' + (sesion.fecha_cierre ? new Date(sesion.fecha_cierre).toLocaleString('es-VE') : 'Ahora'));
      printer.drawLine();

      const data = sesion.datos_cierre || {};
      printer.println('Total ventas:  $' + Number(data.total_usd_sistema || 0).toFixed(2));
      printer.println('Efectivo USD:  $' + Number(data.efectivo_usd_contado || sesion.efectivo_usd_cierre || 0).toFixed(2));
      printer.println('Efectivo Bs:   Bs. ' + Number(sesion.efectivo_bs_cierre || 0).toFixed(2));

      if (data.diferencia_usd !== undefined) {
        const dif = Number(data.diferencia_usd);
        printer.println('Diferencia:    ' + (dif >= 0 ? '+' : '') + dif.toFixed(2) + ' USD');
      }

      printer.drawLine();
      printer.alignCenter();
      printer.println('Firma: ___________________');
      printer.cut();

      await printer.execute();
      return { ok: true };
    } catch (err) {
      require('../config/logger').logger.warn('ImpresionService: no se pudo imprimir cierre', { error: err.message });
      return { ok: false, motivo: err.message };
    }
  }

  /* ─── Prueba de impresora ─── */
  static async imprimirPrueba() {
    try {
      const cfg = await ImpresionService._getConfig();
      const printer = await ImpresionService._crearImpresora(cfg);

      printer.alignCenter();
      printer.bold(true);
      printer.println('PRUEBA DE IMPRESORA');
      printer.bold(false);
      printer.println('Nexus-Core POS');
      printer.println(new Date().toLocaleString('es-VE'));
      printer.drawLine();
      printer.println('Si ves esto, la impresora');
      printer.println('esta funcionando bien!');
      printer.drawLine();
      printer.cut();

      await printer.execute();
      return { ok: true };
    } catch (err) {
      require('../config/logger').logger.warn('ImpresionService: no se pudo imprimir prueba', { error: err.message });
      return { ok: false, motivo: err.message };
    }
  }
}

module.exports = ImpresionService;
