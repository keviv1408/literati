import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const icon = fileURLToPath(new URL('./public/icons/high-diamond.svg', import.meta.url));
const sizes = [72, 96, 128, 144, 152, 180, 192, 384, 512];

for (const size of sizes) {
  const file = new URL(`./public/icons/icon-${size}x${size}.png`, import.meta.url);
  await sharp(icon).resize(size, size).png().toFile(fileURLToPath(file));
}

const appleIcon = new URL('./public/icons/apple-touch-icon.png', import.meta.url);
await sharp(icon).resize(180, 180).png().toFile(fileURLToPath(appleIcon));
