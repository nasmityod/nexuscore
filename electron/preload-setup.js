'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Paso 1: PostgreSQL */
contextBridge.exposeInMainWorld('nexusSetup', {
  getInitialStep: () => ipcRenderer.invoke('setup:get-initial-step'),
  getDefaults: () => ipcRenderer.invoke('setup:get-defaults'),
  testConnection: (config) => ipcRenderer.invoke('setup:test-connection', config),
  saveAndContinue: (config) => ipcRenderer.invoke('setup:save-and-continue', config),
  prepareLicenseStep: () => ipcRenderer.invoke('setup:prepare-license-step'),
  openPostgresHelp: () => ipcRenderer.invoke('setup:open-postgres-help'),
  getVersion: () => ipcRenderer.invoke('app:get-version')
});

/** Paso 2: licencia (misma API que activation.html) */
contextBridge.exposeInMainWorld('nexusCore', {
  getHardwareId: () => ipcRenderer.invoke('app:get-hardware-id'),
  getHardwareIdBundle: () => ipcRenderer.invoke('app:get-hardware-id-bundle'),
  getVersion: () => ipcRenderer.invoke('app:get-version')
});

contextBridge.exposeInMainWorld('nexusLicense', {
  getServerUrl: () => ipcRenderer.invoke('license:get-server-url'),
  confirmed: () => ipcRenderer.send('license:activated'),
  getHwid: () => ipcRenderer.invoke('license:get-hwid'),
  getStatus: () => ipcRenderer.invoke('license:get-status'),
  activate: (licenseKey) => ipcRenderer.invoke('license:activate', { licenseKey }),
  deactivate: () => ipcRenderer.invoke('license:deactivate')
});
