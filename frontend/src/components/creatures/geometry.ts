import {
  BufferGeometry, CatmullRomCurve3, Color, Float32BufferAttribute, Group,
  Mesh, MeshStandardMaterial, Shape, SphereGeometry, Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type Point = [number, number, number];
export type Curve = [number, number, number, number, number, number];
export type Reaction = 'asker' | 'giver';
export type Pose = (activity: number, phase: number, reaction?: Reaction) => void;
export type Part = BufferGeometry[];

export function _path(start: [number, number], curves: Curve[]) {
  const shape = new Shape();
  shape.moveTo(...start);
  for (const curve of curves) shape.bezierCurveTo(...curve);
  shape.closePath();
  return shape;
}

export function _color(part: Part, geometry: BufferGeometry, hex: number) {
  const color = new Color(hex);
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) color.toArray(colors, i * 3);
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.deleteAttribute('uv');
  if (!geometry.index) geometry.setIndex(Array.from({ length: count }, (_, i) => i));
  part.push(geometry);
}

// Each moving part draws once, including all its different paint colors.
export class Model {
  root = new Group();
  private sphere = new SphereGeometry(1, 20, 14);
  private smallSphere = new SphereGeometry(1, 12, 8);
  private material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.52 });
  private geometries: BufferGeometry[] = [];

  oval(part: Part, color: number, center: Point, radius: Point, roll = 0, yaw = 0) {
    const geometry = (Math.max(...radius) > 0.12 ? this.sphere : this.smallSphere).clone();
    geometry.scale(...radius).rotateZ(roll).rotateY(yaw).translate(...center);
    _color(part, geometry, color);
  }

  stroke(part: Part, color: number, points: Point[], startRadius: number, endRadius: number) {
    const curve = new CatmullRomCurve3(points.map(([x, y, z]) => new Vector3(x, y, z)));
    const segments = points.length * 4;
    const sides = 10;
    const frames = curve.computeFrenetFrames(segments, false);
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    const normal = new Vector3();
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const center = curve.getPointAt(t);
      const radius = startRadius + (endRadius - startRadius) * t;
      for (let j = 0; j < sides; j++) {
        const angle = 2 * Math.PI * j / sides;
        normal.copy(frames.normals[i]).multiplyScalar(Math.cos(angle))
          .addScaledVector(frames.binormals[i], Math.sin(angle));
        positions.push(center.x + radius * normal.x, center.y + radius * normal.y, center.z + radius * normal.z);
        normals.push(normal.x, normal.y, normal.z);
        if (i < segments) {
          const a = i * sides + j;
          const b = i * sides + (j + 1) % sides;
          indices.push(a, b, a + sides, b, b + sides, a + sides);
        }
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
    geometry.setIndex(indices);
    _color(part, geometry, color);
    this.oval(part, color, points[points.length - 1], [endRadius, endRadius, endRadius]);
  }

  finish(part: Part, parent = this.root) {
    const geometry = mergeGeometries(part)!;
    for (const piece of part) piece.dispose();
    this.geometries.push(geometry);
    const mesh = new Mesh(geometry, this.material);
    parent.add(mesh);
    return mesh;
  }

  dispose() {
    this.sphere.dispose();
    this.smallSphere.dispose();
    this.material.dispose();
    for (const geometry of this.geometries) geometry.dispose();
  }
}

export function _eye(model: Model, part: Part, center: Point, radius: number, iris = 0x213840) {
  const [x, y, z] = center;
  model.oval(part, 0xfff6db, center, [radius, 1.07 * radius, 0.68 * radius]);
  model.oval(part, iris, [x, y + 0.005, z + 0.58 * radius], [0.52 * radius, 0.66 * radius, 0.22 * radius]);
  model.oval(part, 0xffffff, [x - 0.16 * radius, y + 0.22 * radius, z + 0.79 * radius],
    [0.17 * radius, 0.19 * radius, 0.06 * radius]);
}
