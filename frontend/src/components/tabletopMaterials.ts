import {
  DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace,
} from 'three';

function _albedo(width: number, height: number, pixel: (u: number, v: number, noise: number) => number[]) {
  const pixels = new Uint8Array(width * height * 4);
  let seed = 541;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const [red, green, blue] = pixel(x / width, y / height, seed / 4294967296 - 0.5);
      const i = (y * width + x) * 4;
      pixels[i] = red;
      pixels[i + 1] = green;
      pixels[i + 2] = blue;
      pixels[i + 3] = 255;
    }
  }
  const map = new DataTexture(pixels, width, height);
  map.colorSpace = SRGBColorSpace;
  map.magFilter = LinearFilter;
  map.minFilter = LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.needsUpdate = true;
  return map;
}

export function feltTexture() {
  return _albedo(384, 384, (u, v, noise) => {
    const x = u * 2 - 1;
    const y = v * 2 - 1;
    const nap = Math.max(0, 1 - 0.48 * (x + 0.33) ** 2 - 0.7 * (y - 0.3) ** 2);
    const weave = noise * 8 + 1.5 * Math.sin(750 * u + 165 * v);
    const edge = 0.67 + 0.33 * Math.min(1, Math.max(0, (1 - Math.hypot(x, y)) * 14));
    return [(12 + 9 * nap + weave) * edge, (58 + 38 * nap + weave) * edge, (47 + 28 * nap + weave) * edge];
  });
}

export function walnutTexture() {
  const texture = _albedo(512, 96, (u, v, noise) => {
    const angle = u * Math.PI * 2;
    const bend = Math.sin(angle * 3) * 1.5 + Math.sin(angle * 7 + v * 5) * 0.6;
    const grain = Math.sin(v * 39 + bend) * 6 + Math.sin(v * 127 + bend * 3) * 3 + noise * 6;
    return [95 + grain, 52 + grain * 0.8, 33 + grain * 0.55];
  });
  texture.wrapS = RepeatWrapping;
  return texture;
}
