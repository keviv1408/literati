import {
  CircleGeometry, DirectionalLight, Group, HemisphereLight, LatheGeometry, Mesh,
  MeshPhongMaterial, OctahedronGeometry, OrthographicCamera, Scene, Vector2, WebGLRenderer,
} from 'three';
import { feltTexture, walnutTexture } from './tabletopMaterials';

function _moulding(profile: [number, number][]) {
  return new LatheGeometry(profile.map(([radius, height]) => new Vector2(radius, height)), 128);
}

export function renderTabletop(canvas: HTMLCanvasElement) {
  const surface = canvas.parentElement;
  if (!surface) return;
  const context = canvas.getContext('webgl2', { alpha: true, antialias: true, powerPreference: 'low-power' });
  if (!context) return;

  const renderer = new WebGLRenderer({ canvas, context, alpha: true, antialias: true });
  renderer.setClearColor(0x000000, 0);
  const scene = new Scene();
  const table = new Group();
  table.position.y = 0.062;
  scene.add(table);

  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
  const tilt = Math.PI / 6;
  camera.position.set(0, 5 * Math.cos(tilt), 5 * Math.sin(tilt));
  camera.lookAt(0, 0, 0);
  table.scale.z = 0.94 / Math.cos(tilt);

  scene.add(new HemisphereLight(0xfff2d9, 0x808b91, 1.5));
  const key = new DirectionalLight(0xffecd2, 2.45);
  key.position.set(-2.5, 4, -1.7);
  scene.add(key);
  const fill = new DirectionalLight(0xc2e3ee, 0.75);
  fill.position.set(2, 1.5, 3);
  scene.add(fill);

  const nap = feltTexture();
  const grain = walnutTexture();
  const felt = new MeshPhongMaterial({ map: nap, specular: 0x06130d, shininess: 10 });
  const walnut = new MeshPhongMaterial({ map: grain, specular: 0x644333, shininess: 52 });
  const brass = new MeshPhongMaterial({ color: 0xc29757, specular: 0xf4d49c, shininess: 66 });

  const bed = new CircleGeometry(0.902, 128);
  const cloth = new Mesh(bed, felt);
  cloth.rotation.x = -Math.PI / 2;
  table.add(cloth);

  const rail = _moulding([
    [0.90, -0.128], [0.972, -0.128], [0.992, -0.11], [0.997, -0.082],
    [0.986, -0.071], [0.986, -0.047], [0.998, -0.04], [1, 0.002],
    [0.994, 0.029], [0.978, 0.046], [0.954, 0.053], [0.931, 0.05],
    [0.908, 0.037], [0.895, 0.013], [0.895, -0.013],
  ]);
  table.add(new Mesh(rail, walnut));
  const bead = _moulding([[0.917, 0.043], [0.913, 0.046], [0.909, 0.04]]);
  table.add(new Mesh(bead, brass));

  const diamond = new OctahedronGeometry(1);
  for (let i = 0; i < 8; i++) {
    const angle = (i + 0.5) * Math.PI / 4;
    const inlay = new Mesh(diamond, brass);
    inlay.scale.set(0.019, 0.003, 0.013);
    inlay.rotation.y = angle;
    inlay.position.set(0.957 * Math.sin(angle), 0.054, 0.957 * Math.cos(angle));
    table.add(inlay);
  }

  const _draw = () => {
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height || context.isContextLost()) return;
    const aspect = width / height;
    table.scale.x = aspect * 0.997;
    camera.left = -aspect;
    camera.right = aspect;
    camera.updateProjectionMatrix();
    renderer.setDrawingBufferSize(width, height, Math.min(window.devicePixelRatio || 1, 2));
    renderer.render(scene, camera);
    surface.dataset.rendered = 'true';
  };

  const _showFlatFelt = () => { delete surface.dataset.rendered; };

  const observer = new ResizeObserver(_draw);
  observer.observe(surface);
  canvas.addEventListener('webglcontextlost', _showFlatFelt);
  canvas.addEventListener('webglcontextrestored', _draw);

  return () => {
    observer.disconnect();
    canvas.removeEventListener('webglcontextlost', _showFlatFelt);
    canvas.removeEventListener('webglcontextrestored', _draw);
    _showFlatFelt();
    for (const resource of [bed, rail, bead, diamond, felt, walnut, brass, nap, grain]) resource.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  };
}
