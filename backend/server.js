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
  runPatch022AnulacionCreditoReversa,
  runPatch023RolesPermDashboardMerge,
  runPatch024FixIdempotencyIndex,
  runPatch025UsuarioPermisosOverride,
  runPatch026QueryPerformanceIndexes,
  runPatch027CasheaNivelesConfigExpress,
  runPatch028MonedaCostoProducto,
  runPatch029VentasTotalRefUsdBcv,
  runPatch030VentasTasaBcvAplicada,
  runPatch031IdempotenciaIndiceReconciliar,
  runPatch032VentasCasheaPctInicialNumeric,
  runPatch033CasheaTarifasComisionOficial,
  runPatch034TasaBcvFeriadosVe2026,
  runPatch035NomenclaturaTasaUsdSinParalela,
  runPatch036SetupAdminLegacy,
  runPatch037TotalBsBcvModoMoneda,
  runPatch038CasheaPctInicialSemilla60,
  runPatch039CuentasPagar,
  runPatch040CuentasPagarPermisoRoles,
  runPatch041DescuentoCobroDivisa,
  runPatch042ConfiguracionActualizadoPor,
  runPatch043LicenciaProfesional,
  cleanupSesionesHuerfanas,
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
const casheaRoutes        = require('./routes/cashea.routes');
const devolucionesRoutes  = require('./routes/devoluciones.routes');
const licenciaRoutes      = require('./routes/licencia.routes');
const setupRoutes         = require('./routes/setup.routes');
const cuentasPagarRoutes  = require('./routes/cuentasPagar.routes');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.disable('x-powered-by');

// Validación obligatoria en arranque (regla VARIABLES-DE-ENTORNO):
// si NODE_ENV=production y JWT_SECRET es el fallback de desarrollo o está vacío,
// el servidor DEBE abortar inmediatamente. Esto evita firmar tokens con un secret
// público en producción si alguien olvidó configurar el .env.
(function assertSecretsForProduction() {
  const isProduction = process.env.NODE_ENV === 'production';
  if (!isProduction) return;

  const DEV_FALLBACK = 'nexus-core-dev-jwt-secret-cambiar-en-produccion';
  const secret = process.env.JWT_SECRET;
  const insecure = !secret || String(secret).trim() === '' || secret === DEV_FALLBACK;

  if (insecure) {
    const msg =
      '[Nexus-Core] FATAL: JWT_SECRET no configurado o usa el valor por defecto inseguro. ' +
      'Define JWT_SECRET (≥48 bytes hex) en el entorno de producción antes de iniciar.';
    console.error(msg);
    logger.error(msg);
    process.exit(1);
  }

  if (!process.env.NEXUS_LICENSE_PUBLIC_KEY) {
    logger.warn(
      '[Nexus-Core] NEXUS_LICENSE_PUBLIC_KEY no definida; se usará la clave pública embebida por defecto.'
    );
  }

  const pgPwd = process.env.PG_PASSWORD;
  if (!pgPwd || String(pgPwd).trim() === '') {
    logger.warn(
      '[Nexus-Core] PG_PASSWORD está vacío en producción. Configure la contraseña en el archivo de entorno.'
    );
  }
})();

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
app.use('/api/setup/admin-inicial', loginRateLimiter);
// activar-inicial es sin JWT: rate-limit igual que login para evitar fuerza bruta de códigos
app.use('/api/licencia/activar-inicial', loginRateLimiter);
app.use('/api/auth', authRoutes);

// Licencia y setup inicial deben ir ANTES de app.use('/api', apiProtected).
app.use('/api/licencia', licenciaRoutes);
app.use('/api/setup', setupRoutes);

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
apiProtected.use('/cuentas-pagar', cuentasPagarRoutes);

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
    const SyncService = require('./services/syncService');
    await SyncService.ensurePgDumpReady(db);
  } catch (pgDumpErr) {
    logger.warn('pg_dump: detección automática omitida al arrancar', { error: pgDumpErr.message });
  }

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
    const patch023 = await runPatch023RolesPermDashboardMerge(db);
    if (patch023.ran) {
      logger.info('Parche 023 aplicado: permisos de roles sin dashboard (merge matriz)');
    }
    const patch024 = await runPatch024FixIdempotencyIndex(db);
    if (patch024.ran) {
      logger.info('Parche 024 aplicado: índice idempotency_key por (usuario_id, key)');
    }
    const patch025 = await runPatch025UsuarioPermisosOverride(db);
    if (patch025.ran) {
      logger.info('Parche 025 aplicado: columna permisos_override en usuarios');
    }
    const patch026 = await runPatch026QueryPerformanceIndexes(db);
    if (patch026.ran) {
      logger.info('Parche 026 aplicado: índices consultas ventas/cashea/detalles');
    }
    const patch027 = await runPatch027CasheaNivelesConfigExpress(db);
    if (patch027.ran) {
      logger.info('Parche 027 aplicado: Cashea 6 niveles, Express, día de pago configurable');
    }
    const patch028 = await runPatch028MonedaCostoProducto(db);
    if (patch028.ran) {
      logger.info('Parche 028 aplicado: metadato moneda_costo en productos y ajustes_inventario');
    }
    const patch029 = await runPatch029VentasTotalRefUsdBcv(db);
    if (patch029.ran) {
      logger.info('Parche 029 aplicado: ventas.total_ref_usd_bcv (histórico $ BCV)');
    }
    const patch030 = await runPatch030VentasTasaBcvAplicada(db);
    if (patch030.ran) {
      logger.info('Parche 030 aplicado: ventas.tasa_bcv_aplicada');
    }
    const patch031 = await runPatch031IdempotenciaIndiceReconciliar(db);
    if (patch031.ran) {
      logger.info('Parche 031 aplicado: índice idempotency ventas reconciliado (usuario_id + key)');
    }
    const patch032 = await runPatch032VentasCasheaPctInicialNumeric(db);
    if (patch032.ran) {
      logger.info('Parche 032 aplicado: ventas_cashea.pct_inicial NUMERIC(5,2)');
    }
    const patch033 = await runPatch033CasheaTarifasComisionOficial(db);
    if (patch033.ran) {
      logger.info('Parche 033 aplicado: tarifas comisión Cashea oficial por línea/modo');
    }
    const patch034 = await runPatch034TasaBcvFeriadosVe2026(db);
    if (patch034.ran) {
      logger.info('Parche 034 aplicado: calendario feriados VE 2026 (tasa BCV)');
    }
    const patch035 = await runPatch035NomenclaturaTasaUsdSinParalela(db);
    if (patch035.ran) {
      logger.info('Parche 035 aplicado: nomenclatura tasa USD sin paralela');
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
    const patch036 = await runPatch036SetupAdminLegacy(db);
    if (patch036.ran) {
      logger.info('Parche 036 aplicado: setup admin instalaciones legacy', {
        marcarCompletado: patch036.marcarCompletado
      });
    }
    const patch037 = await runPatch037TotalBsBcvModoMoneda(db);
    if (patch037.ran) {
      logger.info('Parche 037 aplicado: total_bs_bcv_operativo + modo_moneda_operacion');
    }
    const patch038 = await runPatch038CasheaPctInicialSemilla60(db);
    if (patch038.ran) {
      logger.info('Parche 038 aplicado: pct_inicial_semilla 60% (nivel Semilla Lv1)');
    }
    const patch039 = await runPatch039CuentasPagar(db);
    if (patch039.ran) {
      logger.info('Parche 039 aplicado: módulo Cuentas por Pagar (cuentas_pagar + pagos_proveedor)');
    }
    const patch040 = await runPatch040CuentasPagarPermisoRoles(db);
    if (patch040.ran) {
      logger.info('Parche 040 aplicado: permiso cuentas_pagar_all en roles + índice único compra_id');
    }
    const patch041 = await runPatch041DescuentoCobroDivisa(db);
    if (patch041.ran) {
      logger.info('Parche 041 aplicado: descuento cobro divisa (config + columnas ventas)');
    }
    const patch043 = await runPatch043LicenciaProfesional(db);
    if (patch043.ran) {
      logger.info('Parche 043 aplicado: bitácora local de verificaciones de licencia');
    }
    const patch042 = await runPatch042ConfiguracionActualizadoPor(db);
    if (patch042.ran) {
      logger.info('Parche 042 aplicado: columna actualizado_por en tabla configuracion');
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

  // Importante: async start() debe esperar el evento 'listening'. Si resolvemos antes,
  // Electron puede llamar a /api/licencia/estado demasiado pronto y fallar con ECONNREFUSED,
  // mostrando la activación aunque la licencia esté en la BD.
  await new Promise((resolve, reject) => {
    server = app.listen(PORT, '127.0.0.1');
    server.once('listening', () => {
      logger.info(`Nexus-Core backend en http://127.0.0.1:${PORT}`);
      resolve();
    });
    server.once('error', reject);
  });

  try {
    const BackupScheduler = require('./services/backupScheduler');
    await BackupScheduler.start(db);
  } catch (err) {
    logger.warn('Programa de respaldos automáticos periódicos no iniciado', { error: err.message });
  }

  try {
    const BcvTasaAutoService = require('./services/bcvTasaAutoService');
    await BcvTasaAutoService.start(db);
  } catch (err) {
    logger.warn('Sincronización automática tasa BCV no iniciada', { error: err.message });
  }

  return server;
}

async function shutdown() {
  try {
    const BackupScheduler = require('./services/backupScheduler');
    BackupScheduler.stop();
  } catch (err) {
    logger.warn('BackupScheduler.stop omitido', { error: err.message });
  }

  try {
    const BcvTasaAutoService = require('./services/bcvTasaAutoService');
    BcvTasaAutoService.stop();
  } catch (err) {
    logger.warn('BcvTasaAutoService.stop omitido', { error: err.message });
  }

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
