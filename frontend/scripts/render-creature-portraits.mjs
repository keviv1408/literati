import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { chromium } = require('../../e2e/node_modules/playwright');

const frontend = path.resolve(import.meta.dirname, '..');
const three = path.resolve(path.dirname(require.resolve('three')), '..');
const sources = path.join(frontend, 'src/components/creatures');

async function _render() {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage();
    await page.route('http://portraits.test/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/') {
        const imports = { three: '/three/three.module.js', 'three/addons/': '/addons/' };
        return route.fulfill({ contentType: 'text/html', body: `<script type="importmap">${JSON.stringify({ imports })}</script>` });
      }
      let body;
      if (pathname.startsWith('/three/')) {
        body = await fs.readFile(path.join(three, 'build', pathname.slice(6)));
      } else if (pathname.startsWith('/addons/')) {
        body = await fs.readFile(path.join(three, 'examples/jsm', pathname.slice(8)));
      } else {
        const file = await fs.readFile(path.join(sources, pathname.slice(1) + '.ts'), 'utf8');
        body = ts.transpileModule(file, {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).outputText;
      }
      await route.fulfill({ contentType: 'text/javascript', body });
    });
    await page.goto('http://portraits.test/');
    const platforms = process.argv.includes('--platforms');
    const portraits = await page.evaluate(async platforms => {
      const T = await import('three');
      const { createCreature } = await import('/models');
      const { CREATURE_NAMES } = await import('/kind');
      const renderer = new T.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
      renderer.setSize(192, 192, false);
      const scene = new T.Scene();
      const camera = new T.OrthographicCamera(-1.14, 1.14, 1.14, -1.14, 0.1, 30);
      camera.position.z = 8;
      scene.add(new T.HemisphereLight(0xfff5e4, 0xd6c5e4, 1.8));
      const key = new T.DirectionalLight(0xfff1d9, 2);
      key.position.set(-3, 5, 5);
      const fill = new T.DirectionalLight(0xc3edff, 1);
      fill.position.set(3, 1, 2);
      scene.add(key, fill);
      const result = [];
      function save(name, canvas = renderer.domElement) {
        result.push({ name, data: canvas.toDataURL('image/webp', 0.92).split(',')[1] });
      }

      const floor = -0.65;
      const tile = 128;
      const frames = 21;
      if (platforms) {
        renderer.setSize(tile, tile, false);
        const base = new T.Group();
        base.rotation.x = 0.32;
        base.position.y = floor;
        scene.add(base);
        function disc(top, bottom, height, y, color) {
          const mesh = new T.Mesh(new T.CylinderGeometry(top, bottom, height, 80),
            new T.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.22 }));
          mesh.position.y = y;
          base.add(mesh);
        }
        disc(0.96, 0.90, 0.13, -0.11, 0x315e53);
        disc(0.96, 0.96, 0.047, -0.027, 0x93ac91);
        disc(0.91, 0.96, 0.042, 0.016, 0x427b69);
        const shadowCanvas = document.createElement('canvas');
        shadowCanvas.width = shadowCanvas.height = 64;
        const ink = shadowCanvas.getContext('2d');
        const fade = ink.createRadialGradient(32, 32, 0, 32, 32, 32);
        fade.addColorStop(0, 'rgba(0, 18, 14, 0.70)');
        fade.addColorStop(1, 'rgba(0, 18, 14, 0)');
        ink.fillStyle = fade;
        ink.fillRect(0, 0, 64, 64);
        const shadow = new T.Mesh(new T.PlaneGeometry(1.5, 1.2),
          new T.MeshBasicMaterial({ map: new T.CanvasTexture(shadowCanvas), transparent: true, depthWrite: false }));
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.y = 0.04;
        base.add(shadow);
        renderer.render(scene, camera);
        save('base');
        scene.remove(base);
      }

      for (const kind of Object.keys(CREATURE_NAMES)) {
        const model = createCreature(kind);
        scene.add(model.root);
        if (platforms) {
          model.pose(0, 0, 'giver');
          const bounds = new T.Box3().setFromObject(model.root, true);
          const size = bounds.getSize(new T.Vector3());
          const scale = Math.min(1.82 / size.x, 1.56 / size.y);
          model.root.scale.setScalar(scale);
          model.root.position.set(-scale * (bounds.min.x + bounds.max.x) / 2, floor - scale * bounds.min.y, 0);
          const sheet = document.createElement('canvas');
          sheet.width = tile * frames;
          sheet.height = tile;
          const ctx = sheet.getContext('2d');
          for (let frame = 0; frame < frames; frame++) {
            const phase = frame / (frames - 1);
            const activity = Math.sin(Math.PI * phase);
            model.pose(activity, phase, 'giver');
            model.root.rotation.y = 0.25 * Math.sin(phase * Math.PI * 4) * activity;
            renderer.render(scene, camera);
            ctx.drawImage(renderer.domElement, frame * tile, 0);
            if (frame === 0) save(kind);
          }
          save(kind + '-denied', sheet);
        } else {
          renderer.render(scene, camera);
          result.push({ name: kind, data: renderer.domElement.toDataURL('image/webp', 0.96).split(',')[1] });
        }
        scene.remove(model.root);
        model.dispose();
      }
      renderer.dispose();
      return result;
    }, platforms);
    const output = path.join(frontend, 'public/creatures', platforms ? 'platform' : '');
    await fs.mkdir(output, { recursive: true });
    for (const { name, data } of portraits) {
      await fs.writeFile(path.join(output, name + '.webp'), Buffer.from(data, 'base64'));
    }
  } finally {
    await browser.close();
  }
}

_render().catch(error => { console.error(error); process.exitCode = 1; });
