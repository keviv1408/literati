import {
  DirectionalLight, Group, HemisphereLight, OrthographicCamera, Scene, Vector2,
  Vector3, WebGLRenderer,
} from 'three';
import { createCreature, type CreatureKind } from './models';
import { createRetrievalLimb } from './retrievalLimb';

interface RetrievalArgs {
  kind: CreatureKind;
  home: { x: number; y: number; size: number };
  source: { x: number; y: number };
  card: HTMLElement;
  duration: number;
}

function _ease(t: number, start: number, end: number) {
  const u = Math.max(0, Math.min(1, (t - start) / (end - start)));
  return u * u * (3 - 2 * u);
}

function _createActor(kind: CreatureKind) {
  const creature = createCreature(kind);
  const limbs = kind === 'frog' ? [createRetrievalLimb('tongue')]
    : kind === 'octopus' ? [createRetrievalLimb('arm'), createRetrievalLimb('arm')] : [];
  const idleArms = ['retrieval-arm-left', 'retrieval-arm-right'].map(name => creature.root.getObjectByName(name));
  const group = new Group();
  group.add(creature.root, ...limbs.map(limb => limb.group));
  return {
    group, creature, limbs, idleArms,
    dispose() {
      creature.dispose();
      limbs.forEach(limb => limb.dispose());
    },
  };
}

function _createMotion(args: RetrievalArgs, actor: ReturnType<typeof _createActor>, width: number, height: number) {
  const { kind, home, source, card } = args;
  const { root } = actor.creature;
  const butterfly = kind === 'butterfly';
  const frog = kind === 'frog';
  const start = new Vector2(home.x, -home.y);
  const end = new Vector2(source.x, -source.y);
  const distance = Math.max(start.distanceTo(end), 1);
  const direction = end.clone().sub(start).divideScalar(distance);
  const normal = new Vector2(-direction.y, direction.x);
  const midpoint = start.clone().lerp(end, 0.5);
  const inward = new Vector2(width / 2, -height / 2).sub(midpoint).dot(normal) < 0 ? -1 : 1;
  const availableBend = Math.min(width, height) * 0.16;
  const pathBend = inward * Math.min(distance * (butterfly ? 0.22 : 0.055), availableBend, butterfly ? 72 : 18);
  const portraitScale = home.size / 2.28;
  const cardWidth = card.offsetWidth || 48;
  const cardHeight = card.offsetHeight || 72;
  const cardRestScale = Math.min(1, Math.max(0.8, home.size / 48));
  const halfX = cardWidth / 2 - 2;
  const halfY = cardHeight / 2 - 2;
  const hitSide = Math.abs(direction.x) * halfY > Math.abs(direction.y) * halfX;
  const edgeDistance = 1 / Math.max(Math.abs(direction.x) / halfX, Math.abs(direction.y) / halfY, 0.001);
  const frogGrip = direction.clone().multiplyScalar(-edgeDistance);
  const grips = [-1, 1].map(side => hitSide
    ? new Vector2(-Math.sign(direction.x) * halfX, -side * Math.sign(direction.x) * halfY * 0.75)
    : new Vector2(side * halfX * 0.79, -Math.sign(direction.y) * halfY));
  const butterflyNeedsSide = source.y < halfY * cardRestScale + home.size * 0.65;
  const perchAngle = butterflyNeedsSide ? (source.x < width / 2 ? -Math.PI / 2 : Math.PI / 2) : 0;
  const perch = butterflyNeedsSide
    ? new Vector2(source.x < width / 2 ? halfX : -halfX, halfY * 0.22) : new Vector2(0, halfY);
  const cardPosition = new Vector2();
  const grip = new Vector2();
  const base = new Vector3();
  const tip = new Vector3();
  const pullStart = frog ? 0.40 : 0.50;

  return function frame(t: number) {
    const pull = _ease(t, pullStart, 0.91);
    const activity = _ease(t, 0, 0.16) * (1 - _ease(t, 0.85, 1));
    const lift = Math.sin(Math.PI * pull);
    const settle = _ease(t, 0.81, 0.94);
    const cardScale = cardRestScale * (1 - 0.82 * settle);
    const angle = lift * (butterfly ? 0.14 * Math.sin(pull * Math.PI * 2) : direction.x * 0.13);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    cardPosition.copy(end).lerp(start, pull).addScaledVector(normal, pathBend * lift);
    card.style.transform = `translate3d(${cardPosition.x - end.x}px,${end.y - cardPosition.y}px,0) rotate(${-angle}rad) scale(${cardScale})`;
    card.style.opacity = String(_ease(t, 0, 0.055) * (1 - _ease(t, 0.84, 0.94)));

    const size = portraitScale * (1 + activity * (butterfly ? 0.36 : 0.22));
    root.scale.setScalar(size);
    actor.creature.pose(activity, t);
    if (butterfly) {
      const out = _ease(t, 0.025, 0.405);
      const attach = out * (1 - _ease(t, 0.91, 1));
      const glide = Math.sin(Math.PI * out);
      const roll = (perchAngle + angle) * attach - direction.x * glide * 0.32;
      root.rotation.set(0, -direction.x * glide * 0.26, roll);
      // The same rotated card edge drives the feet during pickup and the trip home.
      grip.set(perch.x * cos - perch.y * sin, perch.x * sin + perch.y * cos)
        .multiplyScalar(cardScale).add(cardPosition);
      grip.x -= Math.sin(roll) * 0.30 * size;
      grip.y += Math.cos(roll) * 0.30 * size;
      grip.lerp(start, _ease(t, 0.91, 1));
      root.position.set(
        start.x + (grip.x - start.x) * out - normal.x * glide * pathBend * 0.75,
        start.y + (grip.y - start.y) * out - normal.y * glide * pathBend * 0.75,
        0,
      );
      return;
    }

    const windup = Math.sin(Math.PI * _ease(t, 0, 0.18));
    const lunge = _ease(t, 0.12, 0.27) * (1 - _ease(t, 0.53, 0.91));
    const shift = size * (lunge * 0.16 - windup * 0.12);
    root.position.set(start.x + direction.x * shift, start.y + direction.y * shift, 0);
    root.rotation.set(-direction.y * activity * 0.26, direction.x * activity * 0.48, -direction.x * lunge * 0.12);
    root.scale.y *= 1 - windup * 0.13;
    root.updateMatrixWorld();

    actor.limbs.forEach((limb, index) => {
      const side = index === 0 ? -1 : 1;
      const localGrip = frog ? frogGrip : grips[index];
      const reach = frog ? _ease(t, 0.15, 0.285) : _ease(t, 0.08 + index * 0.025, 0.395 + index * 0.025);
      const retract = 1 - _ease(t, 0.885, 0.96);
      const grasp = _ease(t, 0.375, 0.445) * (1 - _ease(t, 0.83, 0.94));
      const curl = frog ? 1 : 1.12 - 0.33 * grasp;
      grip.set(localGrip.x * cos - localGrip.y * sin, localGrip.x * sin + localGrip.y * cos)
        .multiplyScalar(cardScale * curl).add(cardPosition);
      if (frog) base.set(0, -0.07, 0.55);
      else base.set(side * 0.20, -0.18, 0.23);
      root.localToWorld(base);
      tip.set(grip.x, grip.y, size * 1.04).lerp(base, 1 - reach * retract);
      const length = Math.hypot(tip.x - base.x, tip.y - base.y);
      const archSide = Math.sign(localGrip.dot(normal)) || side;
      const arch = frog ? Math.min(length * 0.028, 8) : archSide * Math.min(length * 0.2, size * 2.1);
      const ripple = frog ? Math.min(length * 0.017, 3) : Math.min(length * 0.14, size * 1.12);
      const hook = frog ? 0 : archSide * Math.min(size * 0.50, length * 0.13) * grasp;
      limb.draw(base, tip, size * (frog ? 0.135 : 0.21), arch, ripple, t * (frog ? 16 : 12) + index * 1.8, hook);
      const idleArm = actor.idleArms[index];
      if (idleArm) idleArm.visible = length < size * 0.52;
    });
  };
}

export function createRetrievalScene(canvas: HTMLCanvasElement) {
  let renderer: WebGLRenderer;
  try {
    const context = canvas.getContext('webgl2', { alpha: true, antialias: true, powerPreference: 'low-power' });
    if (!context) return null;
    renderer = new WebGLRenderer({ canvas, context, alpha: true, antialias: true });
  } catch {
    return null;
  }
  const scene = new Scene();
  const camera = new OrthographicCamera(0, 1, 0, -1, 0.1, 1000);
  camera.position.z = 500;
  scene.add(new HemisphereLight(0xfff5df, 0xc3b5c2, 1.8));
  const key = new DirectionalLight(0xfff5e8, 2.2);
  key.position.set(-3, 5, 6);
  scene.add(key);
  renderer.setClearColor(0x000000, 0);
  const actors = new Map<CreatureKind, ReturnType<typeof _createActor>>();
  let finish: (() => void) | null = null;
  let frameId = 0;
  let disposed = false;
  canvas.style.visibility = 'hidden';

  function warm(kinds: Iterable<CreatureKind>) {
    if (disposed || finish || renderer.getContext().isContextLost()) return;
    const batch = new Group();
    for (const kind of kinds) {
      if (actors.has(kind)) continue;
      const actor = _createActor(kind);
      actors.set(kind, actor);
      batch.add(actor.group);
    }
    if (!batch.children.length) return;
    // Upload the meshes once before the first pickup, while the canvas is hidden.
    renderer.compileAsync(batch, camera, scene).then(() => {
      if (disposed || finish || renderer.getContext().isContextLost() || !batch.children.length) return;
      scene.add(batch);
      try {
        renderer.setDrawingBufferSize(4, 4, 1);
        renderer.render(scene, camera);
      } finally {
        scene.remove(batch);
      }
    }).catch(() => {
      // A restored context can upload the meshes again on its next transfer.
    });
  }

  function stop() {
    cancelAnimationFrame(frameId);
    frameId = 0;
    canvas.style.visibility = 'hidden';
    const notify = finish;
    finish = null;
    notify?.();
  }

  function play(args: RetrievalArgs, onStop: () => void) {
    stop();
    const { width, height } = canvas.getBoundingClientRect();
    if (disposed || !width || !height || renderer.getContext().isContextLost() || args.duration <= 0) {
      onStop();
      return;
    }
    const actor = actors.get(args.kind) ?? _createActor(args.kind);
    actors.set(args.kind, actor);
    scene.add(actor.group);
    camera.right = width;
    camera.bottom = -height;
    camera.updateProjectionMatrix();
    renderer.setDrawingBufferSize(width, height, Math.min(window.devicePixelRatio || 1, 2));
    renderer.compile(actor.group, camera, scene);
    const { transform, opacity } = args.card.style;
    finish = () => {
      scene.remove(actor.group);
      args.card.style.transform = transform;
      args.card.style.opacity = opacity;
      onStop();
    };
    const draw = _createMotion(args, actor, width, height);
    canvas.style.visibility = 'visible';
    draw(0);
    renderer.render(scene, camera);
    let started: number | undefined;
    function tick(now: number) {
      started ??= now;
      const t = (now - started) / args.duration;
      if (t >= 1) {
        stop();
        return;
      }
      draw(t);
      renderer.render(scene, camera);
      frameId = requestAnimationFrame(tick);
    }
    frameId = requestAnimationFrame(tick);
  }

  function onContextLost(event: Event) {
    event.preventDefault();
    stop();
  }
  canvas.addEventListener('webglcontextlost', onContextLost);
  function dispose() {
    if (disposed) return;
    disposed = true;
    stop();
    canvas.removeEventListener('webglcontextlost', onContextLost);
    actors.forEach(actor => actor.dispose());
    actors.clear();
    renderer.dispose();
    renderer.forceContextLoss();
  }
  return { play, stop, dispose, warm };
}
