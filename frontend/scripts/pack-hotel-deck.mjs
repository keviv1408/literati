import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const masters = process.argv[2];
if (!masters) throw new Error('Pass the directory containing the 48 illustrated WebP faces.');
const destination = new URL('../src/assets/', import.meta.url);
const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
const ranks = ['ace', '2', '3', '4', '5', '6', '8', '9', '10', 'jack', 'queen', 'king'];
const width = 216;
const height = 324;
const columns = 8;
const tiles = [];

for (const suit of suits) {
  for (const rank of ranks) {
    const file = resolve(masters, `${rank}_of_${suit}.webp`);
    const tile = await sharp(file).resize(width, height).png().toBuffer();
    const index = tiles.length;
    tiles.push({ input: tile, left: index % columns * width, top: Math.floor(index / columns) * height });
  }
}

await mkdir(destination, { recursive: true });
await sharp({ create: { width: columns * width, height: tiles.length / columns * height, channels: 3, background: '#ffedce' } })
  .composite(tiles)
  .webp({ quality: 72, effort: 6, smartSubsample: true })
  .toFile(fileURLToPath(new URL('hotel-deck.webp', destination)));
