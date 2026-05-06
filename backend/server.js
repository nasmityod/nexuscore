'use strict';

// Carga .env antes que cualquier otro módulo lea process.env.
// En producción empaquetada no habrá .env; las variables vienen del entorno del sistema.
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { db, initDatabaseWithRetry, closeDatabase } = require('./config/database');
const {
  runBootstrapMigrations, runSchemaUpgrades,
  runPatch007HistorialTasas, runPatch008CajaMultimoneda, runPatch009RolesPermMatrix,
  runPatch010TasasEditAdminOnly, runPatch011HistorialTasasTrigger, runPatch012CasheaIntegration,
  runPatch013SearchPerformance, runPatch014IvaDefaultZero, runPatch015VentasTotalBsDescMax,
  runPatch016CreditoSequence, runPatch017Devoluciones, runPatch018CarteraMissingColumns,
  runPatch019StockConstraints, runPatch020SesionesHuerfanas, runPatch021IdempotencyVentas,
  runPatch022AnulacionCreditoReversa, cleanupSesionesHuerfanas,
  ensureSemillaAdminSiFalta
} = require('./config/migrations');
const { logger } = require('./config/logger');
const { errorHandlerMiddleware } = require('./middleware/errorHandler.middleware');

const authRoutes = require('./routes/auth.routes');
const { requireAuth } = require('./middleware/auth.middleware');

const productosRoutes = require('./routes/productos.routes');
const ventasRoutes = require('./routes/ventas.routes');
const inventarioRoutes = require('./routes/inventario.routes');
const clientesRoutes = require('./routes/clientes.routes');
const proveedoresRoutes = require('./routes/proveedores.routes');
const cajaRoutes = require('./routes/caja.routes');
const reportesRoutes = require('./routes/reportes.routes');
const configuracionRoutes = require('./routes/configuracion.routes');
const usuariosRoutes = require('./routes/usuarios.routes');
const pdfRoutes = require('./routes/pdf.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const comprasRoutes = require('./routes/compras.routes');
const casheaRoutes       = require('./routes/cashea.routes');
const devolucionesRoutes = require('./routes/devoluciones.routes');
const licenciaRoutes     = require('./routes/licencia.routes');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.disable('x-powered-by');

// CORS: permite peticiones desde file:// (origin: null) y localhost.
// El backend solo escucha en 127.0.0.1, por lo que no hay riesgo de acceso externo.
app.use(cors({
  origin: (origin, callback) => {
    // origin es null para carga desde file:// (Electron) o peticiones sin origen
    if (!origin || origin === 'null') return callback(null, true);
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    callback(new Error('CORS: origen no permitido'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', function (req, res) {
  db.one('SELECT 1 AS ok')
    .then(function () {
      res.json({ status: 'ok', db: 'connected' });
    })
    .catch(function (err) {
      res.status(503).json({ status: 'error', db: 'disconnected', message: err.message });
    });
});

app.get('/health/db', async (req, res) => {
  try {
    const row = await db.one('SELECT current_database() AS name, NOW() AS server_time');
    res.json({ ok: true, database: row.name, serverTime: row.server_time });
  } catch (err) {
    logger.error('health/db falló', { error: err.message });
    res.status(503).json({ ok: false, error: 'Sin conexión a PostgreSQL' });
  }
});

const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de acceso. Espera 15 minutos.' }
});

app.use('/api/auth/login', loginRateLimiter);
app.use('/api/auth', authRoutes);

const apiProtected = express.Router();
apiProtected.use(requireAuth);
apiProtected.use('/productos', productosRoutes);
apiProtected.use('/ventas', ventasRoutes);
apiProtected.use('/inventario', inventarioRoutes);
apiProtected.use('/clientes', clientesRoutes);
apiProtected.use('/proveedores', proveedoresRoutes);
apiProtected.use('/caja', cajaRoutes);
apiProtected.use('/reportes', reportesRoutes);
apiProtected.use('/configuracion', configuracionRoutes);
  apiProtected.use('/usuarios', usuariosRoutes);
  apiProtected.use('/pdf', pdfRoutes);
  apiProtected.use('/dashboard', dashboardRoutes);
  apiProtected.use('/compras', comprasRoutes);
apiProtected.use('/cashea', casheaRoutes);
apiProtected.use('/devoluciones', devolucionesRoutes);
apiProtected.use('/licencia', licenciaRoutes);

app.use('/api', apiProtected);

app.use(errorHandlerMiddleware);

let server;

async function start() {
  // Conexión a BD con retry: tolera arranques lentos del servicio Windows
  // y bloqueos transitorios de antivirus/firewall.
  await initDatabaseWithRetry(5, 3000, (attempt, max, lastErr) => {
    if (attempt > 1) {
      logger.info(`Reintento de conexión a BD (${attempt}/${max})`, {
        codigo: lastErr && lastErr.code,
        mensaje: lastErr && lastErr.message
      });
    }
  });

  try {
    const migrationResult = await runBootstrapMigrations(db);
    if (migrationResult.ran) {
      console.log('Base de Datos Nexus-Core inicializada con éxito');
    }
    const upgradeResult = await runSchemaUpgrades(db);
    if (upgradeResult.ran) {
      logger.info('Parche de esquema 006 aplicado (productos: solo costo_usd)');
    }
    const patch007 = await runPatch007HistorialTasas(db);
    if (patch007.ran) {
      logger.info('Parche 007 aplicado: historial_tasas con trigger automático');
    }
    const patch008 = await runPatch008CajaMultimoneda(db);
    if (patch008.ran) {
      logger.info('Parche 008 aplicado: Módulo D — caja multimoneda conteos físicos');
    }
    const patch009 = await runPatch009RolesPermMatrix(db);
    if (patch009.ran) {
      logger.info('Parche 009 aplicado: roles, permisos y rol vendedor');
    }
    const patch010 = await runPatch010TasasEditAdminOnly(db);
    if (patch010.ran) {
      logger.info('Parche 010 aplicado: solo administrador puede modificar tasas');
    }
    const patch011 = await runPatch011HistorialTasasTrigger(db);
    if (patch011.ran) {
      logger.info('Parche 011 aplicado: trigger historial_tasas compatible con PostgreSQL 11–13');
    }
    const patch012 = await runPatch012CasheaIntegration(db);
    if (patch012.ran) {
      logger.info('Parche 012 aplicado: integración Cashea');
    }
    const patch013 = await runPatch013SearchPerformance(db);
    if (patch013.ran) {
      logger.info('Parche 013 aplicado: busqueda rapida de productos');
    }
    const patch014 = await runPatch014IvaDefaultZero(db);
    if (patch014.ran) {
      logger.info('Parche 014 aplicado: IVA por defecto 0%');
    }
    const patch015 = await runPatch015VentasTotalBsDescMax(db);
    if (patch015.ran) {
      logger.info('Parche 015 aplicado: ventas.total_bs_cliente + venta_descuento_max_pct');
    }
    const patch017 = await runPatch017Devoluciones(db);
    if (patch017.ran) {
      logger.info('Parche 017 aplicado: tabla devoluciones');
    }
    const patch018 = await runPatch018CarteraMissingColumns(db);
    if (patch018.ran) {
      logger.info('Parche 018 aplicado: columnas faltantes cartera (actualizado_en, pagos_credito)');
    }
    const patch016 = await runPatch016CreditoSequence(db);
    if (patch016.ran) {
      logger.info('Parche 016 aplicado: SEQUENCE numero_venta + crédito USD BCV en cuentas_cobrar');
    }
    const patch019 = await runPatch019StockConstraints(db);
    if (patch019.ran) {
      logger.info('Parche 019 aplicado: CHECK stock>=0 + guarda en trigger venta');
    }
    const patch020 = await runPatch020SesionesHuerfanas(db);
    if (patch020.ran) {
      logger.info('Parche 020 aplicado: cierre automático de sesiones huérfanas');
    }
    const patch021 = await runPatch021IdempotencyVentas(db);
    if (patch021.ran) {
      logger.info('Parche 021 aplicado: idempotency_key en ventas (anti doble-cobro)');
    }
    const patch022 = await runPatch022AnulacionCreditoReversa(db);
    if (patch022.ran) {
      logger.info('Parche 022 aplicado: estado anulada en cuentas_cobrar');
    }
    const adminSeed = await ensureSemillaAdminSiFalta(db);
    if (adminSeed.ran) {
      if (adminSeed.created) {
        logger.info('Semilla: usuario admin creado (faltaba en usuarios)');
      }
      if (adminSeed.repairedRol) {
        logger.info('Semilla: usuario admin reasignado al rol administrador');
      }
    }

    // ── Cleanup de sesiones huérfanas (cierres forzados, cortes de luz, kill -9) ──
    // Cierra automáticamente cualquier sesión 'abierta' con más de 24h de antigüedad.
    // El watchdog también puede ejecutarse manualmente desde el panel admin.
    try {
      const cleanup = await cleanupSesionesHuerfanas(db, 24);
      if (cleanup.cerradas > 0) {
        logger.warn(`${cleanup.cerradas} sesión(es) de caja huérfana(s) cerradas automáticamente al arrancar`);
      }
    } catch (cleanupErr) {
      logger.warn('Cleanup de sesiones huérfanas omitido', { error: cleanupErr.message });
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error('[Nexus-Core] Error en migraciones automáticas:', message);
    if (err && err.stack) console.error(err.stack);
    logger.error('Migraciones automáticas fallaron', { error: message, stack: err && err.stack });
    throw err;
  }

  server = app.listen(PORT, '127.0.0.1', () => {
    logger.info(`Nexus-Core backend en http://127.0.0.1:${PORT}`);
  });
  return server;
}

async function shutdown() {
  try {
    const SyncService = require('./services/syncService');
    const r = await SyncService.runFullBackup({ source: 'app_shutdown' });
    if (r.ok) {
      logger.info('Respaldo al cerrar la aplicación completado', { file: r.fileName });
    } else {
      logger.warn('Respaldo al cerrar no se completó', { error: r.error });
    }
  } catch (err) {
    logger.warn('Respaldo al cerrar omitido o con error', { error: err.message });
  }

  return new Promise((resolve) => {
    if (server) {
      server.close(() => {
        closeDatabase();
        resolve();
      });
    } else {
      closeDatabase();
      resolve();
    }
  });
}

if (require.main === module) {
  start().catch((err) => {
    logger.error('No se pudo iniciar el servidor', { error: err.message });
    process.exit(1);
  });

  process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));
}

module.exports = { app, PORT, start, shutdown };
