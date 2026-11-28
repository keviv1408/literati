import { BufferGeometry, ExtrudeGeometry, Float32BufferAttribute, Group, LatheGeometry, ShapeGeometry, Vector2 } from 'three';
import { Model, _color, _eye, _path, type Curve, type Part, type Point, type Pose } from './geometry';
import type { CreatureKind } from './kind';
import { coastModels } from './trioCoast';
import { wildModels } from './trioWild';
import { forestModels } from './trioForest';

function _frogMouth(part: Part, tongue: boolean) {
  const positions: number[] = [];
  const indices: number[] = [];
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps * 2 - 1;
    const u = tongue ? t * 0.67 : t;
    const x = 0.36 * u;
    const upper = 0.085 * u * u;
    const lower = upper - 0.205 * Math.pow(1 - u * u, 0.72);
    const top = tongue ? lower + 0.065 * (1 - t * t) : upper;
    const z = 0.095 + 0.45 * Math.sqrt(1 - (x / 0.68) ** 2 - (0.09 / 0.40) ** 2);
    positions.push(x, lower, z, x, top, z + (tongue ? 0.005 : 0));
    if (i < steps) indices.push(2 * i, 2 * i + 2, 2 * i + 1, 2 * i + 1, 2 * i + 2, 2 * i + 3);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  if (tongue) geometry.translate(0, 0, 0.004);
  _color(part, geometry, tongue ? 0xf77986 : 0x643345);
}

function _frog(model: Model): Pose {
  const body = new Group();
  model.root.add(body);
  const part: Part = [];
  const skin = 0x61bc55;
  const toes = 0xb3de72;
  for (const side of [-1, 1]) {
    model.oval(part, 0x36955c, [side * 0.57, -0.40, -0.08], [0.28, 0.29, 0.30], side * -0.40);
    model.oval(part, skin, [side * 0.64, -0.64, 0.04], [0.25, 0.105, 0.26], side * 0.04);
    for (let toe = 0; toe < 3; toe++) {
      model.oval(part, toes, [side * (0.58 + toe * 0.125), -0.69 + toe * 0.028, 0.22 - toe * 0.047],
        [0.085, 0.054, 0.12], side * 0.20);
    }
  }
  model.oval(part, skin, [0, -0.27, 0], [0.51, 0.44, 0.38]);
  model.oval(part, 0xebed99, [0, -0.36, 0.205], [0.37, 0.31, 0.22]);
  for (const side of [-1, 1]) {
    model.stroke(part, skin, [[side * 0.34, -0.18, 0.10], [side * 0.47, -0.38, 0.23],
      [side * 0.40, -0.57, 0.34]], 0.12, 0.095);
    for (let toe = 0; toe < 3; toe++) {
      model.oval(part, toes, [side * (0.30 + toe * 0.087), -0.615 + Math.abs(toe - 1) * 0.024, 0.38],
        [0.056, 0.067, 0.078], side * (toe - 1) * 0.32);
    }
    model.oval(part, skin, [side * 0.39, 0.45, 0.02], [0.27, 0.31, 0.29], -side * 0.13);
    _eye(model, part, [side * 0.385, 0.505, 0.235], 0.175);
  }
  model.oval(part, 0x83d360, [0, 0.12, 0.085], [0.68, 0.40, 0.45]);
  for (const side of [-1, 1]) {
    model.oval(part, 0xffae89, [side * 0.49, 0.094, 0.398], [0.115, 0.056, 0.033], side * 0.03, side * 0.75);
    model.oval(part, 0x548b4c, [side * 0.102, 0.171, 0.529], [0.025, 0.019, 0.012], side * -0.3);
  }
  model.finish(part, body);
  const mouth: Part = [];
  _frogMouth(mouth, false);
  _frogMouth(mouth, true);
  const lips = model.finish(mouth, body);
  lips.position.y = 0.018;
  return (activity, phase, reaction) => {
    body.rotation.z = reaction === 'giver' ? Math.sin(phase * Math.PI * 6) * activity * 0.23 : 0;
    body.position.y = reaction === 'asker' ? -activity * 0.22 : 0;
    lips.scale.y = 0.43 + 0.77 * activity;
    body.scale.set(1 + 0.055 * activity, 1 - 0.09 * activity, 1 + 0.04 * activity);
  };
}

const ARM_PATHS: Point[][] = [
  [[0.34, -0.13, -0.16], [0.57, -0.14, -0.14], [0.78, -0.06, -0.08], [0.86, 0.14, 0.01], [0.80, 0.23, 0.09]],
  [[0.35, -0.17, -0.04], [0.58, -0.24, 0.01], [0.78, -0.29, 0.04], [0.92, -0.21, 0.07], [0.92, -0.13, 0.10]],
  [[0.27, -0.20, 0.04], [0.40, -0.43, 0.13], [0.62, -0.54, 0.17], [0.73, -0.49, 0.17], [0.74, -0.42, 0.18]],
  [[0.20, -0.18, 0.23], [0.19, -0.40, 0.30], [0.23, -0.60, 0.34], [0.38, -0.68, 0.32], [0.46, -0.62, 0.29]],
];

function _octopus(model: Model): Pose {
  const coral = 0xea675b;
  const arms: { pivot: Group; side: number; number: number }[] = [];
  for (const side of [-1, 1]) {
    ARM_PATHS.forEach((points, number) => {
      const pivot = new Group();
      if (number === 3) pivot.name = side < 0 ? 'retrieval-arm-left' : 'retrieval-arm-right';
      const [x0, y0, z0] = points[0];
      pivot.position.set(side * x0, y0, z0);
      const local = points.map(([x, y, z]): Point => [side * (x - x0), y - y0, z - z0]);
      const part: Part = [];
      const start: Point = [-side * 0.035, 0.045, -0.09];
      model.stroke(part, coral, [start, ...local], 0.147 - 0.003 * number, 0.031);
      for (let i = 1; i <= 3; i++) {
        const [x, y, z] = local[i];
        const r = 0.056 - 0.008 * i;
        model.oval(part, 0xffb18b, [x, y - 0.015, z + 0.116 - i * 0.019], [r, r * 0.78, r * 0.34]);
      }
      model.finish(part, pivot);
      model.root.add(pivot);
      arms.push({ pivot, side, number });
    });
  }
  const part: Part = [];
  const profile = [[0, -0.30], [0.25, -0.27], [0.41, -0.17], [0.50, 0.01], [0.53, 0.23],
    [0.50, 0.46], [0.43, 0.63], [0.33, 0.74], [0.19, 0.81], [0.03, 0.84], [0, 0.84]];
  const mantle = new LatheGeometry(profile.map(([r, y]) => new Vector2(r, y)), 32);
  mantle.scale(1, 1, 0.90);
  _color(part, mantle, 0xf87c6c);
  for (const side of [-1, 1]) {
    _eye(model, part, [side * 0.215, 0.18, 0.420], 0.119, 0x462b46);
    model.oval(part, 0xffad8d, [side * 0.34, 0.035, 0.36], [0.092, 0.049, 0.030], side * 0.09, side * 0.62);
  }
  model.stroke(part, 0x783f48, [[-0.096, 0.034, 0.453], [-0.04, -0.008, 0.457],
    [0.018, -0.012, 0.452], [0.086, 0.030, 0.456]], 0.018, 0.018);
  model.oval(part, 0xffc695, [-0.215, 0.618, 0.313], [0.083, 0.034, 0.020], 0.56, -0.42);
  model.oval(part, 0xffc695, [-0.089, 0.665, 0.352], [0.033, 0.022, 0.014]);
  const head = model.finish(part);
  return (activity, phase, reaction) => {
    head.rotation.z = reaction === 'asker' ? activity * 0.28 : 0;
    head.scale.set(1 - 0.055 * activity, 1 + 0.065 * activity, 1);
    for (const { pivot, side, number } of arms) {
      const wave = Math.sin(phase * Math.PI * 3 + number * 0.78 + side * 0.32);
      pivot.rotation.z = side * activity * (reaction === 'giver' ? 0.85 + wave * 0.20 : 0.12 + wave * 0.34);
      pivot.rotation.x = activity * wave * 0.17;
    }
  };
}

function _wing(model: Model) {
  const wing: Part = [];
  const outline = _path([0.06, 0.25], [
    [0.26, 0.58, 0.74, 0.86, 0.94, 0.82], [1.04, 0.78, 0.92, 0.40, 0.78, 0.18],
    [0.71, 0.08, 0.62, 0.02, 0.52, -0.02], [0.73, 0.00, 0.84, -0.12, 0.80, -0.25],
    [0.75, -0.42, 0.62, -0.52, 0.54, -0.53], [0.48, -0.57, 0.48, -0.67, 0.42, -0.69],
    [0.36, -0.68, 0.36, -0.60, 0.32, -0.57], [0.17, -0.57, 0.08, -0.40, 0.06, -0.23],
    [0.03, -0.07, 0.03, 0.12, 0.06, 0.25],
  ]);
  const rim = new ExtrudeGeometry(outline, { depth: 0.04, bevelEnabled: true, bevelThickness: 0.018,
    bevelSize: 0.015, bevelSegments: 2, curveSegments: 8 });
  _color(wing, rim, 0x293668);
  const panel = (color: number, start: [number, number], curves: Curve[]) => {
    const face = new ShapeGeometry(_path(start, curves), 8);
    face.translate(0, 0, 0.061);
    _color(wing, face, color);
  };
  panel(0x57dfd2, [0.13, 0.24], [[0.26, 0.48, 0.52, 0.66, 0.72, 0.7],
    [0.71, 0.58, 0.49, 0.40, 0.14, 0.17], [0.11, 0.18, 0.11, 0.20, 0.13, 0.24]]);
  panel(0x4eb5ee, [0.15, 0.13], [[0.33, 0.25, 0.55, 0.40, 0.69, 0.5],
    [0.73, 0.43, 0.66, 0.28, 0.56, 0.22], [0.46, 0.15, 0.27, 0.11, 0.15, 0.09],
    [0.12, 0.09, 0.13, 0.12, 0.15, 0.13]]);
  panel(0x8390f0, [0.14, 0.045], [[0.26, 0.056, 0.46, 0.10, 0.58, 0.14],
    [0.51, 0.05, 0.28, -0.03, 0.15, -0.03], [0.11, -0.01, 0.11, 0.03, 0.14, 0.045]]);
  panel(0xa398f6, [0.14, -0.11], [[0.32, -0.075, 0.59, -0.03, 0.71, -0.13],
    [0.66, -0.26, 0.56, -0.30, 0.44, -0.29], [0.32, -0.26, 0.19, -0.20, 0.14, -0.11]]);
  panel(0x7683ed, [0.15, -0.18], [[0.24, -0.26, 0.38, -0.31, 0.51, -0.35],
    [0.49, -0.43, 0.39, -0.50, 0.32, -0.47], [0.21, -0.44, 0.15, -0.29, 0.15, -0.18]]);
  model.oval(wing, 0xffdc91, [0.838, 0.652, 0.065], [0.044, 0.066, 0.01], -0.53);
  model.oval(wing, 0xd7f3df, [0.795, 0.485, 0.065], [0.031, 0.053, 0.01], -0.36);
  model.oval(wing, 0xffd58e, [0.61, -0.35, 0.065], [0.060, 0.050, 0.01], 0.5);
  model.oval(wing, 0x715576, [0.61, -0.35, 0.077], [0.024, 0.022, 0.008]);
  return wing;
}

function _butterfly(model: Model): Pose {
  const right = model.finish(_wing(model));
  const left = right.clone();
  left.scale.x = -1;
  model.root.add(left);
  const part: Part = [];
  model.oval(part, 0x483763, [0, -0.12, 0.055], [0.122, 0.36, 0.114]);
  model.oval(part, 0xf4a750, [0, 0.015, 0.12], [0.127, 0.18, 0.116]);
  for (const side of [-1, 1]) {
    model.stroke(part, 0x483763, [[side * 0.072, 0.33, 0.06], [side * 0.115, 0.48, 0.055],
      [side * 0.188, 0.59, 0.045], [side * 0.244, 0.60, 0.06]], 0.023, 0.017);
    model.oval(part, 0xf6ba65, [side * 0.244, 0.605, 0.06], [0.040, 0.044, 0.036]);
    model.stroke(part, 0x574161, [[side * 0.06, -0.14, 0.12], [side * 0.115, -0.23, 0.16],
      [side * 0.11, -0.30, 0.17]], 0.025, 0.02);
  }
  model.oval(part, 0xffc979, [0, 0.205, 0.145], [0.202, 0.186, 0.166]);
  for (const side of [-1, 1]) {
    _eye(model, part, [side * 0.082, 0.224, 0.271], 0.067, 0x443452);
  }
  model.stroke(part, 0x76454c, [[-0.047, 0.142, 0.29], [0, 0.121, 0.30], [0.047, 0.142, 0.29]], 0.010, 0.010);
  model.finish(part);
  return (activity, phase, reaction) => {
    const sweep = -0.16 + activity * (reaction === 'asker' ? 1.28 : 0.70 - 0.57 * Math.cos(phase * Math.PI * (reaction === 'giver' ? 6 : 10)));
    right.rotation.y = sweep;
    left.rotation.y = -sweep;
  };
}

export function createCreature(kind: CreatureKind): { root: Group; pose: Pose; dispose: () => void } {
  const model = new Model();
  const pose = { frog: _frog, octopus: _octopus, butterfly: _butterfly, ...coastModels, ...wildModels, ...forestModels }[kind](model);
  pose(0, 0);
  return { root: model.root, pose, dispose: () => model.dispose() };
}
