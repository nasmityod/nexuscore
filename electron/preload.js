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
  focusWindow: () => ipcRenderer.invoke('window:focus'),
  /** Persiste tema en userData para backgroundColor de ventanas Electron */
  saveThemePreference: (tema) => ipcRenderer.invoke('theme:save', tema)
});

// Diálogos nativos seguros para el foco. window.confirm/window.alert de Chromium
// rompen el foco de teclado del webContents en Windows (no se puede escribir tras
// cerrarlos hasta hacer clic fuera y volver). Estos delegan en dialog.showMessageBoxSync
// del proceso principal, que no provoca el fallo. sendSync mantiene la semántica síncrona.
contextBridge.exposeInMainWorld('nexusDialogs', {
  confirm: (message) => {
    try {
      return ipcRenderer.sendSync('dialog:confirm', message == null ? '' : String(message));
    } catch (_e) {
      return false;
    }
  },
  alert: (message) => {
    try {
      ipcRenderer.sendSync('dialog:alert', message == null ? '' : String(message));
    } catch (_e) { /* sin diálogo disponible */ }
  }
});

// Estado de licencia (solo lectura) para el banner de la ventana principal.
contextBridge.exposeInMainWorld('nexusLicense', {
  getStatus: () => ipcRenderer.invoke('license:get-status'),
  getHwid: () => ipcRenderer.invoke('license:get-hwid'),
  activate: (licenseKey) => ipcRenderer.invoke('license:activate', { licenseKey }),
  deactivate: () => ipcRenderer.invoke('license:deactivate')
});

// También exponer como electronAPI para compatibilidad con el módulo de licencia
contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel, ...args) => {
    const allowed = ['app:get-path', 'pdf:open-buffer', 'app:get-hardware-id', 'app:get-hardware-id-bundle', 'app:get-version', 'app:open-external', 'window:focus', 'window:steal-focus', 'theme:save'];
    if (allowed.includes(channel)) return ipcRenderer.invoke(channel, ...args);
    return Promise.reject(new Error('Canal IPC no permitido: ' + channel));
  }
});
