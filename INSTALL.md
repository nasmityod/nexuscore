# Instalación de Nexus-Core POS

Guía paso a paso para instalar Nexus-Core en un PC cliente con Windows 10/11.

---

## 1. Requisitos mínimos

| Recurso | Mínimo | Recomendado |
|---|---|---|
| Sistema operativo | Windows 10 (64 bits) | Windows 11 |
| RAM | 4 GB | 8 GB |
| Disco libre | 2 GB | 10 GB |
| PostgreSQL | 12.x | 15.x |
| Permisos | Administrador local (solo durante instalación) | — |

---

## 2. Instalar PostgreSQL

1. Descargar el instalador oficial: <https://www.postgresql.org/download/windows/>
2. Ejecutar el instalador como administrador. Recomendado: **PostgreSQL 15** o superior.
3. Durante la instalación:
   - **Contraseña del usuario `postgres`**: anotar bien (se necesitará en el `.env` de Nexus-Core).
   - **Puerto**: dejar `5432` (por defecto).
   - **Locale**: `Spanish, Venezuela` o `Default`.
4. Al terminar, **NO marques** "Launch Stack Builder" — no se necesita.
5. Verificar que el servicio esté ejecutándose:
   - Win + R → `services.msc` → buscar `postgresql-x64-15` (o la versión instalada).
   - Estado debe ser **"En ejecución"**, tipo de inicio **"Automático"**.

---

## 3. Instalar Nexus-Core POS

### Opción A — Instalador (.exe) [recomendado]

1. Ejecutar `NexusCore-POS-Setup-x.y.z.exe`.
2. Aceptar el contrato de licencia.
3. Elegir directorio (por defecto: `C:\Program Files\NexusCore POS`).
4. Marcar "Crear acceso directo en escritorio".
5. Finalizar instalación.

### Opción B — Versión portable

1. Descomprimir `NexusCore-POS-portable-x.y.z.zip` en una carpeta como `C:\NexusCore`.
2. Ejecutar `NexusCore POS.exe` desde esa carpeta.

---

## 4. Configurar la conexión a PostgreSQL

En el directorio donde quedó instalada la aplicación, crear (o editar) el archivo `.env`:

```env
# ── PostgreSQL ──
PG_HOST=127.0.0.1
PG_PORT=5432
PG_DATABASE=nexuscore
PG_USER=postgres
PG_PASSWORD=<contraseña que pusiste al instalar PostgreSQL>

# ── Seguridad (OBLIGATORIO en producción) ──
# Generar un secret aleatorio de 64+ caracteres. Ejemplo en PowerShell:
#   [Convert]::ToBase64String((1..48 | %{Get-Random -Max 256}))
JWT_SECRET=<reemplazar con valor aleatorio>
JWT_EXPIRES_IN=12h

NODE_ENV=production

# ── Backend ──
PORT=3000

# ── Pool de conexiones ──
PG_POOL_MAX=10
PG_CONNECTION_TIMEOUT_MS=10000
```

> ⚠️ Si `JWT_SECRET` queda vacío o usa el valor por defecto, la app rechazará arrancar en producción.

---

## 5. Primer arranque

1. Doble clic en el acceso directo "NexusCore POS".
2. Aparece la pantalla de inicio (splash). Espera entre 5-30 segundos:
   - **Verificando PostgreSQL** — comprueba conexión.
   - **Iniciando servidor backend** — intenta hasta 5 veces con backoff si PostgreSQL aún no respondió.
   - **Aplicando migraciones** — crea tablas y datos iniciales (solo la primera vez).
3. La app abre automáticamente en pantalla completa.
4. **Login inicial:**
   - Usuario: `admin`
   - Contraseña: `admin123`

> 🔐 **Cambia la contraseña del usuario `admin` inmediatamente** desde Configuración → Usuarios.

---

## 6. Configuración inicial (10 minutos)

Al primer login, configura los siguientes datos antes de empezar a vender:

### 6.1 Datos de la empresa
**Configuración → Empresa**
- Nombre comercial
- RIF
- Dirección
- Teléfono

### 6.2 Tasas de cambio
**Configuración → Tasas** (solo administrador)
- Tasa BCV (oficial)
- Tasa USD paralela / mercado

### 6.3 Crear usuarios cajeros
**Configuración → Usuarios → Nuevo**
- Asignar rol `cajero` o `vendedor`.
- Cada cajero debe tener su propio usuario para que el arqueo de caja sea individual.

### 6.4 Cargar productos
**Inventario → Productos → Nuevo** (o importar CSV si está disponible).

### 6.5 Configurar caja
**Caja → Abrir caja**
- Monto inicial USD (efectivo en gaveta).
- Monto inicial Bs.
- Las tasas se toman automáticamente de Configuración.

---

## 7. Recuperación ante fallos

Nexus-Core implementa varios mecanismos automáticos:

| Escenario | Comportamiento |
|---|---|
| Corte de luz con caja abierta | La sesión se reabre automáticamente. Tras 24h, se cierra sola con marca `cierre_forzado`. |
| Carrito sin cobrar al cerrar Electron | Se guarda en `localStorage` (auto-save cada 15s + en `beforeunload`). Al volver a entrar al POS, ofrece recuperarlo. |
| Token JWT expirado | Detección en cliente, login automático. Carrito se preserva. |
| PostgreSQL caído al iniciar | Splash muestra error técnico con instrucciones claras. App no abre rota. |
| PostgreSQL cae a mitad del día | Backend devuelve HTTP 503 con mensaje "Base de datos no disponible". POS deshabilita acciones críticas. |
| Doble-clic en "Cobrar" | `idempotency_key` evita doble registro de la misma venta. |
| Stock negativo concurrente | `FOR UPDATE` + `CHECK (stock_actual >= 0)` lo impiden a nivel BD. |

---

## 8. Solución de problemas

### "No se pudo iniciar el sistema — PostgreSQL no disponible"
1. Win + R → `services.msc` → reiniciar `postgresql-x64-XX`.
2. Verificar `.env`: `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`.
3. Si el firewall/antivirus bloquea el puerto 5432: agregar excepción para `postgres.exe`.

### "EADDRINUSE: address already in use 127.0.0.1:3000"
- Ya hay otra instancia de Nexus-Core corriendo. Cerrarla desde el Administrador de Tareas (`Ctrl+Shift+Esc`), buscar `NexusCore POS.exe` y finalizar todos los procesos.

### "JWT_SECRET no configurado"
- Editar `.env` y agregar `JWT_SECRET=<valor aleatorio>` y `NODE_ENV=production`.

### Caja queda en "abierta" después de un corte de luz
- Login con `admin` → Configuración → Sesiones de caja abiertas.
- Botón "Cerrar forzosamente" sobre la sesión huérfana.
- El sistema auto-cierra sesiones de más de 24h al arrancar.

### Pérdida de carrito tras cierre forzado
- Al volver a entrar al POS, si había carrito guardado se restaura automáticamente con un toast amarillo.
- Si no se restaura, revisa: `Ctrl+Shift+I` → Application → Local Storage → `nexus_pos_emergency_cart`.

---

## 9. Backups automáticos

- **Al cierre de caja**: respaldo automático.
- **Al cerrar la aplicación**: respaldo automático.
- Ubicación: `%APPDATA%\nexus-core\backups\`.
- Retención: gestionada por el sistema (ver `syncService.js`).

Para restaurar un backup:
1. Detener Nexus-Core.
2. Detener servicio PostgreSQL.
3. Restaurar el `.dump` con `pg_restore` o pgAdmin.
4. Reiniciar todo.

---

## 10. Soporte

- Logs técnicos: `%APPDATA%\nexus-core\logs\`
- Configuración: `%APPDATA%\nexus-core\config.json`
- Backups: `%APPDATA%\nexus-core\backups\`

Para soporte, enviar:
- Captura del error.
- Archivo `logs\nexus-core.log` (últimas 200 líneas).
- Versión de Nexus-Core (Configuración → Acerca de).
- Versión de PostgreSQL (`SELECT version();` en pgAdmin).
