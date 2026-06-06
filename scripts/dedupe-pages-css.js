'use strict';
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'frontend', 'assets', 'css', 'pages.css');
let css = fs.readFileSync(file, 'utf8');

// Quitar bloque modal duplicado del encabezado (components.css ya define .modal-overlay con display:none)
css = css.replace(
  /\.modal-overlay \{[^}]+\}\s*\.modal-box \{[^}]+\}\s*\.modal-box\.modal-lg[^}]+\}\s*\.modal-box\.modal-sm[^}]+\}\s*\.modal-title \{[^}]+\}\s*/s,
  ''
);

const stripRules = [
  /^\.[a-z0-9-]+-page \.btn-primary[^{]*\{[^}]*\}\s*/gm,
  /^\.[a-z0-9-]+-page \.btn-primary:hover[^{]*\{[^}]*\}\s*/gm,
  /^\.config-page \.btn-primary[^{]*\{[^}]*\}\s*/gm,
  /^\.btn-primary \{ height:44px[^}]+\}\s*/gm,
  /^\.btn-primary:hover \{ background:var\(--accent-primary-dim\)[^}]+\}\s*/gm,
  /^\.input-g:focus \{ outline:none[^}]+\}\s*/gm,
  /^\.modal-overlay \{ display:none[^}]+\}\s*/gm,
  /^\.modal-overlay\.is-open\{display:flex\}\s*/gm,
  /^\.modal-overlay\.is-open \{ display:flex[^}]+\}\s*/gm,
];

for (const re of stripRules) {
  css = css.replace(re, '');
}

// Colapsar líneas vacías múltiples
css = css.replace(/\n{3,}/g, '\n\n');

fs.writeFileSync(file, css);
console.log('pages.css deduped, lines:', css.split('\n').length);
