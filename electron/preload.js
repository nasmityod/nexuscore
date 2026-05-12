'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexusCore', {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron
  },
  getPath: (name) => ipcRenderer.invoke('app:get-path', name),
  /** Abre un PDF temporal con la app predeterminada del sistema */
  openPdfBuffer: (arrayBuffer) => ipcRenderer.invoke('pdf:open-buffer', arrayBuffer),
  /** Devuelve el Hardware ID del equipo para activación de licencia (identidad estable) */
  getHardwareId: () => ipcRenderer.invoke('app:get-hardware-id'),
  /** HWID estable + compat legado para validar contra la BD */
  getHardwareIdBundle: () => ipcRenderer.invoke('app:get-hardware-id-bundle'),
  /** Versión de la aplicación */
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  /** Abre URL en el navegador del sistema */
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  focusWindow: () => ipcRenderer.invoke('window:focus')
});

// También exponer como electronAPI para compatibilidad con el módulo de licencia
contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel, ...args) => {
    const allowed = ['app:get-path', 'pdf:open-buffer', 'app:get-hardware-id', 'app:get-hardware-id-bundle', 'app:get-version', 'app:open-external', 'window:focus', 'window:steal-focus'];
    if (allowed.includes(channel)) return ipcRenderer.invoke(channel, ...args);
    return Promise.reject(new Error('Canal IPC no permitido: ' + channel));
  }
});
