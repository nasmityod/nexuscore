'use strict';
/**
 * Genera build-resources/icon.png (512) e icon.ico multi-resolución desde logo.svg
 * Ejecutar: npm run icons
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const svgPath = path.join(root, 'frontend', 'assets', 'img', 'logo.svg');
const outDir = path.join(root, 'build-resources');
const pngPath = path.join(outDir, 'icon.png');
const icoPath = path.join(outDir, 'icon.ico');

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function renderLogoPng(sharp, svg, size) {
  const logo = await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 7, g: 11, b: 20, alpha: 1 },
    },
  })
    .composite([{ input: logo, gravity: 'center' }])
    .png()
    .toBuffer();
}

async function main() {
  const sharp = require('sharp');
  const pngToIco = require('png-to-ico').default || require('png-to-ico');

  if (!fs.existsSync(svgPath)) {
    console.error('No existe:', svgPath);
    process.exit(1);
  }
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const svg = fs
    .readFileSync(svgPath, 'utf8')
    .replace(/currentColor/g, '#f0a500');

  const png512 = await renderLogoPng(sharp, svg, 512);
  fs.writeFileSync(pngPath, png512);

  const icoInputs = await Promise.all(
    ICO_SIZES.map((size) => renderLogoPng(sharp, svg, size))
  );
  fs.writeFileSync(icoPath, await pngToIco(icoInputs));
  console.log('Generado:', pngPath);
  console.log('Generado:', icoPath, `(${ICO_SIZES.join(', ')} px)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
