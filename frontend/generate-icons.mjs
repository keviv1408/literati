/**
 * generate-icons.mjs
 * Generates PWA icon PNGs for all required sizes from an inline SVG source.
 * Run once: node generate-icons.mjs
 */
import { createRequire } from 'module';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const sharp = require('./node_modules/sharp/lib/index.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, 'public', 'icons');

// SVG source: green felt card-game icon with "L" lettermark
const svgSource = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <!-- Background circle -->
  <circle cx="256" cy="256" r="256" fill="#022c22"/>
  <!-- Inner card shape -->
  <rect x="96" y="72" width="320" height="368" rx="32" ry="32" fill="#064e3b" stroke="#10b981" stroke-width="8"/>
  <!-- Large "L" lettermark -->
  <text
    x="128"
    y="380"
    font-family="Georgia, 'Times New Roman', serif"
    font-size="280"
    font-weight="700"
    fill="#10b981"
  >L</text>
  <!-- Small suit symbols -->
  <text x="112" y="150" font-family="serif" font-size="64" fill="#34d399">♠</text>
  <text x="320" y="150" font-family="serif" font-size="64" fill="#f87171">♥</text>
  <text x="112" y="430" font-family="serif" font-size="56" fill="#f87171">♦</text>
  <text x="328" y="430" font-family="serif" font-size="56" fill="#34d399">♣</text>
</svg>`;

const SIZES = [72, 96, 128, 144, 152, 180, 192, 384, 512];

async function generate() {
  const svgBuffer = Buffer.from(svgSource);

  for (const size of SIZES) {
    const outPath = join(OUTPUT_DIR, `icon-${size}x${size}.png`);
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(outPath);
    console.log(`✓ ${outPath}`);
  }

  // Also create apple-touch-icon (180x180)
  const appleOut = join(OUTPUT_DIR, 'apple-touch-icon.png');
  await sharp(svgBuffer).resize(180, 180).png().toFile(appleOut);
  console.log(`✓ ${appleOut}`);

  console.log('\nAll icons generated successfully!');
}

generate().catch((err) => {
  console.error('Failed to generate icons:', err);
  process.exit(1);
});
