import { MathUtils, Object3D } from 'three';
import { frames } from './cardPoses';

export function animateDeal(stage: HTMLElement, progress: number) {
  const from = Math.floor(progress);
  const to = Math.min(from + 1, frames.length - 1);
  const t = MathUtils.smootherstep(progress - from, 0.15, 0.85);
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  const object = new Object3D();
  const mix = (a: number, b: number) => MathUtils.lerp(a, b, t);

  Array.from(stage.children).forEach((child, i) => {
    const card = child as HTMLElement;
    const a = frames[from][i];
    const b = frames[to][i];
    const travel = Math.min(1, Math.hypot(b.x - a.x, b.y - a.y) / 30);
    const lift = Math.sin(t * Math.PI) * travel;
    object.position.set((mix(a.x, b.x) - 50) * width / 100, (mix(a.y, b.y) - 50) * height / 100, lift * width * 0.08 + i * 0.1);
    object.rotation.set(-lift * 0.19, MathUtils.degToRad(mix(a.flip, b.flip)), MathUtils.degToRad(mix(a.angle, b.angle)), 'ZXY');
    object.scale.setScalar(mix(a.scale, b.scale));
    object.updateMatrix();
    card.style.left = '50%';
    card.style.top = '50%';
    card.style.transform = `translate(-50%, -50%) matrix3d(${object.matrix.elements.join(',')})`;
    card.style.opacity = String(mix(a.opacity, b.opacity));
  });
}
