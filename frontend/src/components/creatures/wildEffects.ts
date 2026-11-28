import {
  BufferAttribute, BufferGeometry, CatmullRomCurve3, Color, DoubleSide, DynamicDrawUsage, Group,
  Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, Shape, ShapeGeometry, SphereGeometry, Vector3,
} from 'three';
import type { Point } from './geometry';
import type { PickupContext } from './pickup';

export const elephantTrunk: Point[] = [
  [0, 0.18, 0.418], [-0.038, 0.050, 0.49], [-0.044, -0.16, 0.51],
  [0.006, -0.325, 0.55], [0.136, -0.40, 0.57], [0.267, -0.352, 0.60], [0.309, -0.217, 0.64],
];

const TRUNK_STEPS = 40;
const TRUNK_SIDES = 10;

function _dynamicTrunk(parent: Group) {
  const group = new Group();
  parent.add(group);
  const curve = new CatmullRomCurve3(elephantTrunk.map(point => new Vector3(...point)));
  const resting = curve.getSpacedPoints(TRUNK_STEPS);
  const path = resting.map(point => point.clone());
  const ring = Array.from({ length: TRUNK_SIDES }, (_, i) => {
    const angle = Math.PI * 2 * i / TRUNK_SIDES;
    return [Math.cos(angle), Math.sin(angle)];
  });
  const geometry = new BufferGeometry();
  const count = (TRUNK_STEPS + 1) * TRUNK_SIDES;
  const positions = new BufferAttribute(new Float32Array(count * 3), 3).setUsage(DynamicDrawUsage);
  const normals = new BufferAttribute(new Float32Array(count * 3), 3).setUsage(DynamicDrawUsage);
  const colors = new Float32Array(count * 3);
  const indices: number[] = [];
  const color = new Color();
  for (let i = 0; i <= TRUNK_STEPS; i++) {
    const crease = i === 5 || i === 34 || i === 37;
    color.setHex(crease ? 0x869ac3 : 0x95a8d2);
    for (let j = 0; j < TRUNK_SIDES; j++) {
      const a = i * TRUNK_SIDES + j;
      color.toArray(colors, a * 3);
      const b = i * TRUNK_SIDES + (j + 1) % TRUNK_SIDES;
      if (i < TRUNK_STEPS) indices.push(a, b, a + TRUNK_SIDES, b, b + TRUNK_SIDES, a + TRUNK_SIDES);
    }
  }
  geometry.setAttribute('position', positions);
  geometry.setAttribute('normal', normals);
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  const tube = new Mesh(geometry, new MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }));
  tube.frustumCulled = false;
  group.add(tube);
  const sphere = new SphereGeometry(1, 12, 8);
  const tip = new Mesh(sphere, new MeshStandardMaterial({ color: 0xc9abc5, roughness: 0.54 }));
  const nostril = new Mesh(sphere, new MeshStandardMaterial({ color: 0x75698f }));
  nostril.position.set(0, 0.12, 0.82);
  nostril.scale.set(0.43, 0.29, 0.26);
  tip.add(nostril);
  group.add(tip);
  group.visible = false;

  function updateRadius(scale: number) {
    for (let i = 0; i <= TRUNK_STEPS; i++) {
      const point = path[i];
      const before = path[Math.max(0, i - 1)];
      const next = path[Math.min(TRUNK_STEPS, i + 1)];
      const dx = next.x - before.x;
      const dy = next.y - before.y;
      const length = Math.hypot(dx, dy) || 1;
      const radius = scale * (0.148 - 0.075 * i / TRUNK_STEPS);
      for (let j = 0; j < TRUNK_SIDES; j++) {
        const [cos, sin] = ring[j];
        const nx = -dy / length * cos;
        const ny = dx / length * cos;
        const vertex = i * TRUNK_SIDES + j;
        normals.setXYZ(vertex, nx, ny, sin);
        positions.setXYZ(vertex, point.x + radius * nx, point.y + radius * ny, point.z + radius * sin);
      }
    }
    positions.needsUpdate = true;
    normals.needsUpdate = true;
    tip.position.copy(path[TRUNK_STEPS]);
    tip.scale.setScalar(scale * 0.074);
  }

  return { group, path, resting, updateRadius };
}

const elephantTubes = new WeakMap<Group, ReturnType<typeof _dynamicTrunk>>();

export function createElephantReach(ctx: PickupContext) {
  const trunk = ctx.actor.getObjectByName('elephant-trunk')!;
  const grip = trunk.getObjectByName('card-grip')!;
  const tube = elephantTubes.get(ctx.effects) ?? _dynamicTrunk(ctx.effects);
  elephantTubes.set(ctx.effects, tube);
  const dx = ctx.home.x - ctx.source.x;
  const dy = ctx.home.y - ctx.source.y;
  const sideEdge = Math.abs(dx) * ctx.cardHalf.y > Math.abs(dy) * ctx.cardHalf.x;
  const nx = sideEdge ? Math.sign(dx) || 1 : 0;
  const ny = sideEdge ? 0 : Math.sign(dy) || 1;
  const edgeRadius = sideEdge ? ctx.cardHalf.x : ctx.cardHalf.y;
  const base = new Vector3();
  const scale = new Vector3();
  const restPoint = new Vector3();
  return (active: number, curl: number, pull: number) => {
    const arc = Math.sin(Math.PI * pull);
    const cardX = ctx.source.x + dx * pull;
    const cardY = ctx.source.y + dy * pull + arc * ctx.size * 0.23;
    const roll = ctx.direction * arc * 0.11;
    ctx.placeCard(cardX, cardY, roll);
    tube.group.visible = active > 0.002;
    trunk.visible = !tube.group.visible;
    if (!tube.group.visible) return;

    const cos = Math.cos(roll);
    const sin = Math.sin(roll);
    const ex = nx * cos - ny * sin;
    const ey = nx * sin + ny * cos;
    const tx = -ey;
    const ty = ex;
    const radius = Math.min(ctx.cardHalf.x, ctx.cardHalf.y) * ctx.cardScale * 0.40;
    const edgeX = cardX + ex * edgeRadius * ctx.cardScale - tx * radius;
    const edgeY = cardY + ey * edgeRadius * ctx.cardScale - ty * radius;
    const approach = (1 - curl) * radius * 1.60;
    const joinX = edgeX + ex * approach;
    const joinY = edgeY + ey * approach;
    trunk.getWorldScale(scale);
    base.copy(tube.resting[0]).applyMatrix4(trunk.matrixWorld);
    const sag = Math.min(ctx.size * 0.43, Math.hypot(joinX - base.x, joinY - base.y) * 0.21);
    for (let i = 0; i <= TRUNK_STEPS; i++) {
      const u = i / TRUNK_STEPS;
      const point = tube.path[i];
      restPoint.copy(tube.resting[i]).applyMatrix4(trunk.matrixWorld);
      if (u <= 0.75) {
        const s = u / 0.75;
        const w = 1 - s;
        // A downward first tangent preserves the heavy curve under the muzzle.
        const b1 = 3 * w * w * s;
        const b2 = 3 * w * s * s;
        const handle = Math.min(ctx.distance * 0.11, ctx.size * 1.2);
        point.set(w ** 3 * base.x + b1 * base.x + b2 * (joinX + ex * handle) + s ** 3 * joinX,
          w ** 3 * base.y + b1 * (base.y - sag * 2.2) + b2 * (joinY + ey * handle) + s ** 3 * joinY,
          base.z + s * scale.x * 0.28);
      } else {
        const s = (u - 0.75) / 0.25;
        const a = s * 1.18 * Math.PI;
        const along = (1 - s) * approach - curl * radius * (s * 0.92 + Math.sin(a));
        const around = curl * radius * (1 - Math.cos(a));
        point.set(edgeX + ex * along + tx * around, edgeY + ey * along + ty * around,
          base.z + scale.x * (0.28 + 0.14 * curl * s));
      }
      point.lerp(restPoint, 1 - active);
    }
    tube.updateRadius(scale.x);
    ctx.grip.copy(tube.path[TRUNK_STEPS]);
    trunk.worldToLocal(grip.position.copy(ctx.grip));
  };
}

function _silkThread(parent: Group) {
  const segments = 20;
  const geometry = new BufferGeometry();
  const positions = new BufferAttribute(new Float32Array((segments + 1) * 6), 3).setUsage(DynamicDrawUsage);
  const indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  geometry.setAttribute('position', positions);
  geometry.setIndex(indices);
  const material = new MeshBasicMaterial({ color: 0xd6efff, transparent: true, opacity: 0.76,
    depthWrite: false, side: DoubleSide });
  const silk = new Mesh(geometry, material);
  silk.frustumCulled = false;
  parent.add(silk);
  return { silk, positions, segments };
}

const spiderThreads = new WeakMap<Group, ReturnType<typeof _silkThread>>();

export function createSpiderSilk(ctx: PickupContext) {
  const thread = spiderThreads.get(ctx.effects) ?? _silkThread(ctx.effects);
  spiderThreads.set(ctx.effects, thread);
  const spinneret = ctx.actor.getObjectByName('spider-spinneret')!;
  const tip = new Vector3();
  return (travel: number, jump: number, reel: number) => {
    const { silk, positions, segments } = thread;
    silk.visible = travel > 0.012;
    if (!silk.visible) return;
    spinneret.getWorldPosition(tip);
    const dx = tip.x - ctx.home.x;
    const dy = tip.y - ctx.home.y;
    const length = Math.hypot(dx, dy) || 1;
    const width = Math.max(0.68, ctx.size * 0.018);
    const sag = Math.min(length * 0.09, ctx.size * 0.51) * (1 + 0.50 * jump - 0.93 * reel);
    for (let i = 0; i <= segments; i++) {
      const s = i / segments;
      const x = ctx.home.x + dx * s;
      const y = ctx.home.y + dy * s - 4 * s * (1 - s) * sag;
      const tangentY = dy - 4 * (1 - 2 * s) * sag;
      const halfWidth = width / (Math.hypot(dx, tangentY) || 1);
      const nx = -tangentY * halfWidth;
      const ny = dx * halfWidth;
      positions.setXYZ(i * 2, x + nx, y + ny, -ctx.size);
      positions.setXYZ(i * 2 + 1, x - nx, y - ny, -ctx.size);
    }
    positions.needsUpdate = true;
  };
}

function _toeprints(parent: Group) {
  const shape = new Shape();
  shape.moveTo(-0.12, -0.28);
  shape.bezierCurveTo(-0.27, -0.21, -0.24, -0.05, -0.23, 0.02);
  shape.lineTo(-0.39, 0.11);
  shape.bezierCurveTo(-0.65, 0.08, -0.58, 0.42, -0.38, 0.33);
  shape.lineTo(-0.18, 0.15);
  shape.lineTo(-0.22, 0.38);
  shape.bezierCurveTo(-0.40, 0.57, -0.08, 0.69, -0.07, 0.47);
  shape.lineTo(-0.065, 0.18);
  shape.lineTo(0.09, 0.40);
  shape.bezierCurveTo(0.05, 0.64, 0.37, 0.60, 0.28, 0.40);
  shape.lineTo(0.09, 0.12);
  shape.lineTo(0.30, 0.20);
  shape.bezierCurveTo(0.44, 0.39, 0.63, 0.13, 0.42, 0.07);
  shape.lineTo(0.20, 0.01);
  shape.bezierCurveTo(0.20, -0.14, 0.07, -0.34, -0.12, -0.28);
  const geometry = new ShapeGeometry(shape, 5);
  return Array.from({ length: 6 }, () => {
    const material = new MeshBasicMaterial({ color: 0xcdeb82, transparent: true, depthWrite: false,
      side: DoubleSide });
    const print = new Mesh(geometry, material);
    print.visible = false;
    parent.add(print);
    return print;
  });
}

const geckoTracks = new WeakMap<Group, ReturnType<typeof _toeprints>>();

export function createGeckoTracks(ctx: PickupContext) {
  const prints = geckoTracks.get(ctx.effects) ?? _toeprints(ctx.effects);
  geckoTracks.set(ctx.effects, prints);
  const feet: Object3D[] = [ctx.actor.getObjectByName('gecko-foot-2')!, ctx.actor.getObjectByName('gecko-foot-3')!];
  const dx = ctx.source.x - ctx.home.x;
  const dy = ctx.source.y - ctx.home.y;
  const edgeRatio = Math.max(Math.abs(dx) / ctx.cardHalf.x, Math.abs(dy) / ctx.cardHalf.y, 1);
  const angle = Math.atan2(dy, dx) - Math.PI / 2;
  const captured = prints.map(() => false);
  return (t: number, back: number, cardRoll: number) => {
    const cos = Math.cos(cardRoll);
    const sin = Math.sin(cardRoll);
    prints.forEach((print, i) => {
      const time = 0.53 + 0.058 * i;
      const age = t - time;
      print.visible = age >= 0 && age < 0.29;
      if (age < 0) captured[i] = false;
      if (!print.visible) return;
      if (!captured[i]) {
        const u = (time - 0.49) / (0.92 - 0.49);
        const atStamp = u * u * (3 - 2 * u);
        feet[i % 2].getWorldPosition(print.position);
        print.position.x += (back - atStamp) * dx;
        print.position.y += (back - atStamp) * dy;
        print.position.z = -ctx.size;
        const side = i % 2 ? -1 : 1;
        print.rotation.z = angle + side * 0.64;
        print.scale.set(side * ctx.size * 0.25, ctx.size * 0.25, 1);
        captured[i] = true;
      }
      // The HTML card passes above the footprints while the canvas draws the gecko on top.
      const x = print.position.x - ctx.grip.x;
      const y = print.position.y - ctx.grip.y;
      const cardX = x * cos + y * sin - dx / edgeRatio * ctx.cardScale;
      const cardY = y * cos - x * sin - dy / edgeRatio * ctx.cardScale;
      const margin = ctx.size * 0.07;
      print.visible = Math.abs(cardX) > ctx.cardHalf.x * ctx.cardScale + margin
        || Math.abs(cardY) > ctx.cardHalf.y * ctx.cardScale + margin;
      print.material.opacity = 0.78 * Math.min(1, age / 0.016) * Math.min(1, (0.29 - age) / 0.21);
    });
  };
}
