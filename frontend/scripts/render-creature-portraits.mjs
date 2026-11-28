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
    const portraits = await page.evaluate(async () => {
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
      for (const kind of Object.keys(CREATURE_NAMES)) {
        const model = createCreature(kind);
        scene.add(model.root);
        renderer.render(scene, camera);
        result.push({ kind, data: renderer.domElement.toDataURL('image/webp', 0.96).split(',')[1] });
        scene.remove(model.root);
        model.dispose();
      }
      renderer.dispose();
      return result;
    });
    for (const { kind, data } of portraits) {
      await fs.writeFile(path.join(frontend, 'public/creatures', kind + '.webp'), Buffer.from(data, 'base64'));
    }
  } finally {
    await browser.close();
  }
}

_render().catch(error => { console.error(error); process.exitCode = 1; });
