'use strict';

/**
 * Preload seguro para la ventana splash.
 * Expone únicamente los canales IPC necesarios mediante contextBridge,
 * sin habilitar nodeIntegration ni desactivar contextIsolation.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splashBridge', {
  /** Notifica a main que el DOM del splash está listo para recibir actualizaciones. */
  ready: () => ipcRenderer.send('splash:ready'),

  /** Recibe actualizaciones de progreso: { status: string, progress: number } */
  onStatus: (callback) => {
    ipcRenderer.on('splash:status', (_event, data) => callback(data));
  },

  /** Recibe notificación de error de inicio: { message: string } */
  onError: (callback) => {
    ipcRenderer.on('splash:error', (_event, data) => callback(data));
  }
});
