import {
  BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, InstancedMesh, Mesh,
  MeshStandardMaterial, Object3D, SphereGeometry, TorusGeometry, Vector3,
} from 'three';

const SEGMENTS = 40;
const SIDES = 8;

export function createRetrievalLimb(kind: 'tongue' | 'arm') {
  const isArm = kind === 'arm';
  const group = new Group();
  const geometry = new BufferGeometry();
  const vertexCount = (SEGMENTS + 1) * SIDES;
  const positions = new BufferAttribute(new Float32Array(vertexCount * 3), 3).setUsage(DynamicDrawUsage);
  const normals = new BufferAttribute(new Float32Array(vertexCount * 3), 3).setUsage(DynamicDrawUsage);
  geometry.setAttribute('position', positions);
  geometry.setAttribute('normal', normals);
  const indices: number[] = [];
  const ring = Array.from({ length: SIDES }, (_, i) => {
    const angle = i * Math.PI * 2 / SIDES;
    return [Math.cos(angle), Math.sin(angle)];
  });
  for (let i = 0; i < SEGMENTS; i++) {
    for (let j = 0; j < SIDES; j++) {
      const a = i * SIDES + j;
      const b = i * SIDES + (j + 1) % SIDES;
      indices.push(a, b, a + SIDES, b, b + SIDES, a + SIDES);
    }
  }
  geometry.setIndex(indices);
  const skin = new MeshStandardMaterial({ color: isArm ? 0xea675b : 0xf77986, roughness: 0.43 });
  const tube = new Mesh(geometry, skin);
  tube.frustumCulled = false;
  group.add(tube);

  const detailGeometry = isArm ? new TorusGeometry(0.7, 0.26, 5, 10) : new SphereGeometry(1, 12, 8);
  const detailMaterial = new MeshStandardMaterial({ color: isArm ? 0xffb18b : 0xff93a0, roughness: 0.36 });
  const detail = new InstancedMesh(detailGeometry, detailMaterial, isArm ? 8 : 1);
  detail.instanceMatrix.setUsage(DynamicDrawUsage);
  detail.frustumCulled = false;
  group.add(detail);
  const stamp = new Object3D();
  const path = Array.from({ length: SEGMENTS + 1 }, () => new Vector3());

  function draw(base: Vector3, tip: Vector3, width: number, arch: number, ripple: number, phase: number, hook: number) {
    const dx = tip.x - base.x;
    const dy = tip.y - base.y;
    const length = Math.hypot(dx, dy);
    group.visible = length > 1;
    if (!group.visible) return;
    const nx = -dy / length;
    const ny = dx / length;
    const hookLength = Math.max(1, Math.min(length * 0.25, Math.abs(hook) * 2.2));
    for (let i = 0; i <= SEGMENTS; i++) {
      const u = i / SEGMENTS;
      const envelope = Math.sin(Math.PI * u);
      const curl = Math.sin(Math.PI * Math.min(1, (1 - u) * length / hookLength)) * hook;
      const bend = envelope * (arch + ripple * Math.sin(Math.PI * 2 * u + phase)) + curl;
      const along = u + Math.abs(curl) / length;
      path[i].set(base.x + dx * along + nx * bend, base.y + dy * along + ny * bend, base.z + (tip.z - base.z) * u);
    }
    for (let i = 0; i <= SEGMENTS; i++) {
      const u = i / SEGMENTS;
      const previous = path[Math.max(i - 1, 0)];
      const next = path[Math.min(i + 1, SEGMENTS)];
      const tx = next.x - previous.x;
      const ty = next.y - previous.y;
      const tangentLength = Math.hypot(tx, ty) || 1;
      const radius = width * (isArm ? 1 - 0.77 * u : 0.86 - 0.32 * u);
      const point = path[i];
      for (let j = 0; j < SIDES; j++) {
        const [cos, sin] = ring[j];
        const normalX = -ty / tangentLength * cos;
        const normalY = tx / tangentLength * cos;
        const vertex = i * SIDES + j;
        positions.setXYZ(vertex, point.x + radius * normalX, point.y + radius * normalY, point.z + radius * sin);
        normals.setXYZ(vertex, normalX, normalY, sin);
      }
      if (isArm && i >= 5 && i % 5 === 0) {
        stamp.position.set(point.x, point.y, point.z + radius * 0.91);
        stamp.scale.setScalar(radius * 0.68);
        stamp.updateMatrix();
        detail.setMatrixAt(i / 5 - 1, stamp.matrix);
      }
    }
    if (!isArm) {
      const beforeTip = path[SEGMENTS - 1];
      stamp.position.copy(tip);
      stamp.rotation.z = Math.atan2(tip.y - beforeTip.y, tip.x - beforeTip.x);
      stamp.scale.set(width * 1.8, width * 1.08, width * 0.76);
      stamp.updateMatrix();
      detail.setMatrixAt(0, stamp.matrix);
    }
    positions.needsUpdate = true;
    normals.needsUpdate = true;
    detail.instanceMatrix.needsUpdate = true;
  }

  function dispose() {
    geometry.dispose();
    skin.dispose();
    detail.dispose();
    detailGeometry.dispose();
    detailMaterial.dispose();
  }
  return { group, draw, dispose };
}
