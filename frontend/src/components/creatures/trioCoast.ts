import { Group, LatheGeometry, Vector2 } from 'three';
import { _color, _eye, type Model, type Part, type Pose } from './geometry';
import type { PickupContext } from './pickup';

function _pivot(parent: Group, x = 0, y = 0, z = 0) {
  const pivot = new Group();
  pivot.position.set(x, y, z);
  parent.add(pivot);
  return pivot;
}

function _ease(t: number, from: number, to: number) {
  const u = Math.min(1, Math.max(0, (t - from) / (to - from)));
  return u * u * (3 - 2 * u);
}

function _crab(model: Model): Pose {
  const carmine = 0xc4403b;
  const coral = 0xf47849;
  const shell = _pivot(model.root);
  const face: Part = [];
  model.oval(face, 0xd9513f, [-0.12, -0.19, 0], [0.58, 0.34, 0.35]);
  model.oval(face, coral, [-0.12, -0.11, 0.06], [0.57, 0.29, 0.35]);
  model.stroke(face, 0x733744, [[-0.34, -0.15, 0.374], [-0.24, -0.204, 0.403],
    [-0.12, -0.213, 0.409], [-0.025, -0.165, 0.400]], 0.017, 0.018);
  for (const side of [-1, 1]) {
    model.oval(face, 0xffb393, [-0.13 + side * 0.32, -0.10, 0.345], [0.080, 0.039, 0.026], side * 0.14);
  }
  model.finish(face, shell);
  const stalks = _pivot(shell, -0.14, 0.06, 0.09);
  const eyes: Part = [];
  for (const side of [-1, 1]) {
    model.stroke(eyes, coral, [[side * 0.20, -0.06, -0.02], [side * 0.22, 0.14, 0],
      [side * 0.25, 0.30, 0.03]], 0.072, 0.059);
    model.oval(eyes, carmine, [side * 0.25, 0.31, 0.021], [0.145, 0.152, 0.111]);
    _eye(model, eyes, [side * 0.25, 0.325, 0.063], 0.127, 0x492c3c);
  }
  model.finish(eyes, stalks);

  const legSets = [0, 1].map(set => {
    const legs: Part = [];
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        if ((i + (side > 0 ? 1 : 0)) % 2 !== set) continue;
        const hip = -0.12 + side * (0.39 - 0.07 * i);
        const knee = -0.12 + side * (0.79 - 0.11 * i);
        const depth = -0.13 + 0.13 * i;
        model.stroke(legs, i === 1 ? coral : carmine, [[hip, -0.18 - 0.05 * i, depth],
          [knee - side * 0.05, -0.29 - 0.07 * i, depth], [knee, -0.34 - 0.07 * i, depth],
          [knee + side * 0.11, -0.51 - 0.084 * i, depth + 0.07]], 0.068, 0.020);
      }
    }
    return model.finish(legs, shell);
  });

  const little = _pivot(shell, -0.59, -0.09, 0.12);
  const hand: Part = [];
  model.stroke(hand, coral, [[0, -0.04, 0], [-0.11, 0.015, 0.03], [-0.20, 0.13, 0.05]], 0.08, 0.10);
  model.oval(hand, coral, [-0.22, 0.14, 0.055], [0.145, 0.13, 0.10], -0.5);
  model.stroke(hand, 0xffba76, [[-0.30, 0.16, 0.06], [-0.36, 0.27, 0.07], [-0.32, 0.35, 0.07]], 0.069, 0.015);
  model.stroke(hand, 0xffba76, [[-0.20, 0.19, 0.06], [-0.18, 0.26, 0.07], [-0.21, 0.32, 0.07]], 0.053, 0.014);
  model.finish(hand, little);

  const claw = _pivot(shell, 0.27, -0.10, 0.14);
  const pincer: Part = [];
  model.stroke(pincer, carmine, [[0, -0.035, 0], [0.16, -0.035, 0.035], [0.31, 0.20, 0.06]], 0.104, 0.11);
  model.oval(pincer, coral, [0.37, 0.31, 0.08], [0.255, 0.24, 0.163], 0.23);
  model.stroke(pincer, coral, [[0.51, 0.33, 0.075], [0.59, 0.46, 0.08], [0.60, 0.60, 0.08]], 0.124, 0.080);
  model.stroke(pincer, 0xffca85, [[0.60, 0.57, 0.08], [0.58, 0.70, 0.08], [0.49, 0.805, 0.08]], 0.082, 0.019);
  model.oval(pincer, 0xffac75, [0.38, 0.40, 0.214], [0.102, 0.035, 0.013], 0.48);
  model.finish(pincer, claw);
  const thumb = _pivot(claw, 0.25, 0.40, 0.078);
  const jaw: Part = [];
  model.stroke(jaw, coral, [[0, -0.04, 0], [-0.04, 0.08, 0], [-0.025, 0.18, 0]], 0.097, 0.077);
  model.stroke(jaw, 0xffca85, [[-0.027, 0.16, 0], [-0.015, 0.27, 0], [0.08, 0.42, 0]], 0.079, 0.016);
  model.finish(jaw, thumb);
  _pivot(claw, 0.49, 0.805, 0.085).name = 'card-grip';

  return (a, t, reaction) => {
    const asking = reaction === 'asker';
    const giving = reaction === 'giver';
    const step = Math.sin(t * Math.PI * 18);
    const march = _ease(t, 0.43, 0.56) * (1 - _ease(t, 0.84, 1));
    const reach = _ease(t, 0.13, 0.36) * (1 - _ease(t, 0.43, 0.55));
    shell.rotation.z = a * (asking ? -0.20 : giving ? 0.09 : 0.047 * step);
    shell.position.y = asking ? -0.10 * a : 0;
    stalks.position.y = 0.06 + a * (asking ? -0.23 + 0.055 * Math.cos(t * Math.PI * 4) : 0.034);
    claw.rotation.z = a * (giving ? 0.52 : asking ? -0.65 : -0.55 * reach + 0.93 * march);
    thumb.rotation.z = a * (giving ? 0.58 : asking ? -0.38 : -0.38 * _ease(t, 0.38, 0.425));
    little.rotation.z = a * (giving ? -0.62 : asking ? 0.63 : 0.20 * step);
    legSets.forEach((legs, i) => {
      const stride = (i === 0 ? 1 : -1) * step;
      legs.rotation.z = reaction ? 0 : a * stride * 0.08;
      legs.position.x = reaction ? 0 : a * stride * 0.075;
    });
  };
}

function _penguin(model: Model): Pose {
  const ink = 0x25384d;
  const milk = 0xfff2d8;
  const bird = _pivot(model.root);
  const body: Part = [];
  model.oval(body, ink, [0, -0.22, 0], [0.48, 0.59, 0.39]);
  model.oval(body, milk, [0, -0.26, 0.17], [0.375, 0.47, 0.27]);
  model.oval(body, ink, [0, -0.53, -0.30], [0.23, 0.16, 0.24]);
  for (const side of [-1, 1]) {
    model.oval(body, 0xf7a340, [side * 0.22, -0.76, 0.105], [0.193, 0.082, 0.24], 0, side * 0.16);
  }
  model.finish(body, bird);
  const flippers = [-1, 1].map(side => {
    const shoulder = _pivot(bird, side * 0.37, 0.020, 0);
    const wing: Part = [];
    model.oval(wing, 0x324b66, [side * 0.108, -0.215, 0], [0.128, 0.355, 0.14], side * 0.35);
    model.oval(wing, 0x486781, [side * 0.117, -0.20, 0.091], [0.061, 0.215, 0.058], side * 0.34);
    model.finish(wing, shoulder);
    return shoulder;
  });
  const head = _pivot(bird, 0, 0.22, 0.035);
  const face: Part = [];
  model.oval(face, ink, [0, 0.14, 0], [0.46, 0.47, 0.403]);
  for (const side of [-1, 1]) {
    model.oval(face, milk, [side * 0.150, 0.113, 0.246], [0.223, 0.274, 0.155], side * -0.16);
    model.oval(face, 0x1c2837, [side * 0.175, 0.171, 0.382], [0.057, 0.073, 0.036]);
    model.oval(face, 0xffffff, [side * 0.175 - 0.011, 0.193, 0.416], [0.016, 0.019, 0.007]);
  }
  model.oval(face, 0xe68932, [0, 0.022, 0.392], [0.130, 0.059, 0.143]);
  model.oval(face, 0xfbb445, [0, 0.066, 0.412], [0.143, 0.067, 0.157]);
  model.finish(face, head);
  _pivot(head, 0, 0.047, 0.556).name = 'card-grip';
  return (a, t, reaction) => {
    const asking = reaction === 'asker';
    const giving = reaction === 'giver';
    const slide = _ease(t, 0.035, 0.19) * (1 - _ease(t, 0.78, 0.96));
    const paddle = Math.sin(t * Math.PI * 14);
    bird.rotation.x = a * (reaction ? (asking ? 0.27 : -0.10) : slide * 1.21);
    bird.position.y = reaction ? 0 : -a * slide * 0.13;
    head.rotation.x = a * (asking ? 0.32 - 0.28 * Math.cos(t * Math.PI * 4) : giving ? -0.14 : -0.94 * slide);
    head.rotation.z = a * (asking ? 0.41 * Math.sin(t * Math.PI * 3) : giving ? 0.13 : 0);
    flippers.forEach((wing, i) => {
      const side = i === 0 ? -1 : 1;
      wing.rotation.z = side * a * (giving ? 1.40 : asking ? -0.30 : slide * (0.64 + 0.23 * paddle));
      wing.rotation.x = reaction ? 0 : a * slide * (-0.43 + side * 0.27 * paddle);
    });
  };
}

function _toucanBill(model: Model, parent: Group) {
  // Tight ring spacing gives the bill crisp color bands that wrap around its sides.
  const rings = [
    [0, 0, 0], [0.014, 0.152, 0.143], [0.081, 0.180, 0.154], [0.087, 0.183, 0.155],
    [0.188, 0.209, 0.157], [0.197, 0.211, 0.157], [0.41, 0.224, 0.15],
    [0.65, 0.196, 0.115], [0.704, 0.180, 0.101], [0.712, 0.178, 0.10],
    [0.85, 0.118, 0.074], [0.938, 0.046, 0.046], [0.963, 0, 0],
  ];
  const bill = new LatheGeometry(rings.map(([x, h]) => new Vector2(h, x)), 22);
  bill.rotateZ(-Math.PI / 2);
  const vertices = bill.getAttribute('position');
  for (let i = 0; i < vertices.count; i++) {
    const [x, height, width] = rings[i % rings.length];
    vertices.setY(i, vertices.getY(i) + 0.068 * Math.sin(Math.PI * x) - 0.112 * x ** 3);
    vertices.setZ(i, height ? vertices.getZ(i) * width / height : 0);
  }
  bill.computeVertexNormals();
  const part: Part = [];
  _color(part, bill, 0xffaa36);
  const colors = bill.getAttribute('color');
  for (let i = 0; i < vertices.count; i++) {
    const [x, height] = rings[i % rings.length];
    const y = vertices.getY(i) - 0.068 * Math.sin(Math.PI * x) + 0.112 * x ** 3;
    if (x <= 0.081 || x >= 0.712) colors.setXYZ(i, 0.030, 0.051, 0.065);
    else if (x <= 0.188) colors.setXYZ(i, 0.12, 0.66, 0.50);
    else if (y < -height * 0.32) colors.setXYZ(i, 0.85, 0.17, 0.047);
  }
  model.finish(part, parent);
  _pivot(parent, 0.932, -0.09, 0.017).name = 'card-grip';
}

function _toucan(model: Model): Pose {
  const ink = 0x253344;
  const bird = _pivot(model.root, -0.21, -0.015, 0);
  const plumage: Part = [];
  model.oval(plumage, ink, [-0.04, -0.255, -0.046], [0.35, 0.51, 0.27], -0.17);
  model.oval(plumage, 0x263a4b, [-0.27, -0.57, -0.15], [0.119, 0.392, 0.112], -0.64);
  model.oval(plumage, 0x385266, [-0.32, -0.56, -0.18], [0.091, 0.34, 0.087], -0.92);
  model.oval(plumage, 0xef6049, [0.063, -0.125, 0.088], [0.263, 0.25, 0.188], -0.15, 0.62);
  model.oval(plumage, 0xffe3a4, [0.066, -0.057, 0.089], [0.274, 0.252, 0.195], -0.15, 0.62);
  for (const side of [-1, 1]) {
    model.oval(plumage, 0x6db5b1, [side * 0.128, -0.735, 0.008], [0.097, 0.065, 0.133]);
  }
  model.finish(plumage, bird);
  const wings = [-1, 1].map(side => {
    const shoulder = _pivot(bird, side * 0.25 - 0.06, -0.02, -0.01);
    const wing: Part = [];
    model.oval(wing, 0x26384b, [side * 0.065, -0.215, 0.009], [0.14, 0.285, 0.127], side * 0.26);
    model.oval(wing, 0x3b566b, [side * 0.06, -0.17, 0.087], [0.089, 0.19, 0.069], side * 0.28);
    model.finish(wing, shoulder);
    return shoulder;
  });
  const head = _pivot(bird, -0.01, 0.065, 0.027);
  const mask: Part = [];
  model.oval(mask, ink, [0, 0.22, 0], [0.367, 0.39, 0.318]);
  model.oval(mask, 0xffe9b9, [0.098, 0.115, 0.105], [0.304, 0.262, 0.230], 0, 0.82);
  for (const [x, z, yaw] of [[-0.120, 0.280, -0.24], [0.331, -0.035, 1.77]]) {
    const eye: Part = [];
    model.oval(eye, 0x65bfad, [0, 0, 0], [0.106, 0.114, 0.068]);
    _eye(model, eye, [0, 0, 0.048], 0.079, 0x292f39);
    for (const piece of eye) mask.push(piece.rotateY(yaw).translate(x, 0.267, z));
  }
  model.finish(mask, head);
  const bill = _pivot(head, 0.116, 0.154, 0.287);
  bill.rotation.y = -0.48;
  _toucanBill(model, bill);
  return (a, t, reaction) => {
    const asking = reaction === 'asker';
    const giving = reaction === 'giver';
    const scoop = Math.sin(Math.PI * _ease(t, 0.30, 0.49));
    const flick = Math.sin(Math.PI * _ease(t, 0.49, 0.62));
    const catchCard = Math.sin(Math.PI * _ease(t, 0.70, 0.84));
    const shake = Math.sin(t * Math.PI * 5);
    head.rotation.y = a * (giving ? 0.49 * shake : asking ? -0.36 : 0);
    head.rotation.z = a * (giving ? 0.23 : asking ? -0.53 + 0.16 * shake : -0.48 * scoop + 0.70 * flick - 0.25 * catchCard);
    bird.rotation.z = asking ? a * -0.12 : 0;
    wings.forEach((wing, i) => {
      const side = i === 0 ? -1 : 1;
      wing.rotation.z = side * a * (reaction ? (giving ? 0.72 : 0.19) : 0.54 + 0.50 * Math.cos(t * Math.PI * 12));
    });
  };
}

function _crabPickup(ctx: PickupContext) {
  return (t: number) => {
    const out = _ease(t, 0.045, 0.395);
    const back = _ease(t, 0.49, 0.95);
    const stride = Math.sin(t * Math.PI * 18);
    const run = Math.sin(Math.PI * out) + Math.sin(Math.PI * back);
    ctx.place({
      travel: out - back, lift: 0.087 * run * Math.abs(stride), roll: ctx.direction * 0.072 * run * stride,
      yaw: ctx.direction * 0.21 * run, carrying: t >= 0.40, cardRoll: 0.12 * stride * Math.sin(Math.PI * back),
    });
  };
}

function _penguinPickup(ctx: PickupContext) {
  return (t: number) => {
    const glide = _ease(t, 0.063, 0.39);
    const back = _ease(t, 0.50, 0.935);
    const turn = _ease(t, 0.395, 0.61);
    const slide = _ease(t, 0.035, 0.17) * (1 - _ease(t, 0.82, 0.995));
    const corner = Math.sin(Math.PI * turn);
    ctx.place({
      travel: glide - back, lift: 0.105 * Math.sin(Math.PI * _ease(t, 0.025, 0.175)),
      sway: 0.43 * corner + 0.27 * Math.sin(Math.PI * back), yaw: ctx.direction * 1.32 * slide * (1 - 2 * turn),
      roll: ctx.direction * (-0.13 * Math.sin(Math.PI * glide) + 0.21 * corner),
      carrying: t >= 0.395, cardRoll: ctx.direction * 0.23 * corner,
    });
  };
}

function _toucanPickup(ctx: PickupContext) {
  return (t: number) => {
    const out = _ease(t, 0.04, 0.40);
    const back = _ease(t, 0.465, 0.96);
    const face = _ease(t, 0.025, 0.16) * (1 - _ease(t, 0.82, 0.98));
    const toss = Math.min(1, Math.max(0, (t - 0.53) / 0.24));
    const arc = 4 * toss * (1 - toss);
    ctx.place({
      travel: out - back, lift: 0.51 * Math.sin(Math.PI * out) + 0.35 * Math.sin(Math.PI * back),
      yaw: (ctx.direction > 0 ? 0.16 : -1.94) * face, roll: ctx.direction * (0.10 * Math.sin(Math.PI * back) - 0.16 * Math.sin(Math.PI * out)),
      carrying: t >= 0.405, cardLift: 0.83 * arc, cardRoll: ctx.direction * Math.PI * 2 * toss,
    });
  };
}

export const coastModels = { crab: _crab, penguin: _penguin, toucan: _toucan };
export const coastPickups = { crab: _crabPickup, penguin: _penguinPickup, toucan: _toucanPickup };
