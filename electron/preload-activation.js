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

  // ── Sistema profesional de licencias (license-key NXCS, archivo local cifrado) ──
  // HWID endurecido del equipo (para mostrar al usuario y soporte)
  getHwid:      () => ipcRenderer.invoke('license:get-hwid'),
  // Estado local de la licencia (sin red): { ok, state, info, ... }
  getStatus:    () => ipcRenderer.invoke('license:get-status'),
  // Activa con la license key (requiere internet): { ok, info } | { ok:false, reason, message }
  activate:     (licenseKey) => ipcRenderer.invoke('license:activate', { licenseKey }),
  // Libera la activación de este equipo (cambio de hardware)
  deactivate:   () => ipcRenderer.invoke('license:deactivate'),
});
