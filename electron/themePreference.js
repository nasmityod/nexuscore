'use strict';

const fs = require('fs');
const path = require('path');

const FILENAME = 'nexus_theme.json';

const BG_PRIMARY = {
  dark: '#05080f',
  light: '#f4f6fa'
};

function getThemeFilePath(app) {
  return path.join(app.getPath('userData'), FILENAME);
}

/**
 * Lee la preferencia de tema persistida para el proceso main de Electron.
 * Fuente de verdad compartida entre ventanas (splash, setup, activation, main).
 */
function readSavedTheme(app) {
  try {
    const raw = fs.readFileSync(getThemeFilePath(app), 'utf8');
    const data = JSON.parse(raw);
    return data && data.tema === 'light' ? 'light' : 'dark';
  } catch (e) {
    return 'dark';
  }
}

function writeSavedTheme(app, tema) {
  if (tema !== 'dark' && tema !== 'light') {
    throw new Error('themePreference.writeSavedTheme: tema inválido "' + String(tema) + '"');
  }
  fs.writeFileSync(getThemeFilePath(app), JSON.stringify({ tema: tema }), 'utf8');
}

function getWindowBackgroundColor(app) {
  return BG_PRIMARY[readSavedTheme(app)] || BG_PRIMARY.dark;
}

function normalizeTheme(tema) {
  return tema === 'light' ? 'light' : 'dark';
}

module.exports = {
  readSavedTheme,
  writeSavedTheme,
  getWindowBackgroundColor,
  normalizeTheme,
  BG_PRIMARY
};
