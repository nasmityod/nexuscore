'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexusCore', {
  getHardwareId: () => ipcRenderer.invoke('app:get-hardware-id'),
  getHardwareIdBundle: () => ipcRenderer.invoke('app:get-hardware-id-bundle'),
  getVersion:    () => ipcRenderer.invoke('app:get-version'),
});

// URL del servidor de licencias Vercel (se inyecta desde main.js vía IPC)
contextBridge.exposeInMainWorld('nexusLicense', {
  // Devuelve la URL del servidor de licencias configurada en el build
  getServerUrl: () => ipcRenderer.invoke('license:get-server-url'),
  // Notifica al proceso principal que la activación fue exitosa → abre la app
  confirmed:    () => ipcRenderer.send('license:activated'),
});
