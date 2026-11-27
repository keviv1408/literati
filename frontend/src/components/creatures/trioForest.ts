import { Color, Group, LatheGeometry, Vector2 } from 'three';
import { _color, _eye, type Model, type Part, type Pose } from './geometry';
import type { PickupContext } from './pickup';

function _pivot(parent: Group, x = 0, y = 0, z = 0) {
  const group = new Group();
  group.position.set(x, y, z);
  parent.add(group);
  return group;
}

function _grip(parent: Group, x: number, y: number, z: number) {
  _pivot(parent, x, y, z).name = 'card-grip';
}

function _step(t: number, start: number, end: number) {
  const u = Math.min(1, Math.max(0, (t - start) / (end - start)));
  return u * u * (3 - 2 * u);
}

function _hop(travel: number, count: number) {
  const stride = (travel * count) % 1;
  return 4 * stride * (1 - stride);
}

function _beetle(model: Model): Pose {
  const body = _pivot(model.root);
  const shell: Part = [];
  const bronze = 0x805037;
  const carapace = 0x195555;
  model.oval(shell, 0x253d3c, [0, -0.29, -0.06], [0.53, 0.48, 0.36]);
  for (const side of [-1, 1]) {
    model.oval(shell, 0x388882, [side * 0.242, -0.29, 0.035], [0.255, 0.422, 0.36], side * 0.11);
    model.stroke(shell, 0x83c0a5, [[side * 0.38, -0.19, 0.326], [side * 0.385, -0.32, 0.333],
      [side * 0.36, -0.44, 0.323]], 0.018, 0.008);
  }
  model.oval(shell, carapace, [0, -0.015, 0.085], [0.51, 0.19, 0.39]);
  model.oval(shell, 0x62412f, [0, 0.145, 0.235], [0.405, 0.262, 0.34]);
  for (const side of [-1, 1]) {
    model.stroke(shell, bronze, [[side * 0.31, 0.20, 0.29], [side * 0.46, 0.28, 0.32],
      [side * 0.52, 0.33, 0.36]], 0.028, 0.027);
    model.oval(shell, 0xb98452, [side * 0.54, 0.33, 0.365], [0.066, 0.04, 0.049], side * -0.24);
    _eye(model, shell, [side * 0.228, 0.149, 0.503], 0.111, 0x263c39);
  }
  model.stroke(shell, 0x382c27, [[-0.072, 0.062, 0.544], [0, 0.040, 0.559],
    [0.072, 0.062, 0.544]], 0.014, 0.014);
  model.finish(shell, body);

  const horn = _pivot(body, 0, 0.24, 0.42);
  const fork: Part = [];
  model.stroke(fork, bronze, [[0, -0.04, -0.045], [0, 0.09, 0.045],
    [0, 0.24, 0.17], [0, 0.415, 0.205]], 0.145, 0.084);
  for (const side of [-1, 1]) {
    model.stroke(fork, bronze, [[0, 0.36, 0.20], [side * 0.095, 0.455, 0.225],
      [side * 0.19, 0.54, 0.26], [side * 0.194, 0.635, 0.31]], 0.098, 0.025);
    model.stroke(fork, 0xddab6d, [[side * 0.185, 0.537, 0.283], [side * 0.196, 0.584, 0.304],
      [side * 0.194, 0.637, 0.312]], 0.024, 0.018);
  }
  model.finish(fork, horn);
  _grip(horn, 0, 0.55, 0.28);

  const tripods = [new Group(), new Group()];
  const legs: [Part, Part] = [[], []];
  for (const side of [-1, 1]) {
    for (let row = 0; row < 3; row++) {
      const batch = (row + Number(side > 0)) % 2;
      const y = -0.02 - row * 0.19;
      const knee = row === 1 ? 0.74 : 0.66;
      const toe = row === 1 ? 0.90 : 0.77;
      model.stroke(legs[batch], 0x4c4035, [[side * 0.35, y, -0.04],
        [side * knee, y + 0.06 - 0.03 * row, 0.02], [side * toe, y - 0.09 - 0.06 * row, 0.085]],
      0.066, 0.038);
      model.oval(legs[batch], 0x996344, [side * toe, y - 0.108 - 0.06 * row, 0.10],
        [0.064, 0.041, 0.060], side * 0.2);
    }
  }
  tripods.forEach((pivot, i) => {
    body.add(pivot);
    model.finish(legs[i], pivot);
  });

  return (activity, t, reaction) => {
    const trot = Math.sin(t * Math.PI * 24) * activity;
    const expect = 1 - _step(t, 0.29, 0.58);
    const scoop = _step(t, 0.29, 0.46) - _step(t, 0.48, 0.60);
    const hoist = _step(t, 0.48, 0.60);
    body.position.y = 0;
    body.rotation.set(0, 0, 0);
    horn.rotation.set(0, 0, 0);
    if (reaction === 'giver') {
      horn.rotation.z = activity * Math.sin(t * Math.PI * 4) * 0.47;
      horn.rotation.x = activity * 0.28;
      body.rotation.z = -horn.rotation.z * 0.24;
    } else if (reaction === 'asker') {
      horn.rotation.x = activity * (-0.53 * expect + 0.94 * (1 - expect));
      body.position.y = activity * (0.07 * expect - 0.12 * (1 - expect));
    } else {
      horn.rotation.x = activity * (0.96 * scoop - 0.52 * hoist);
      body.rotation.z = trot * 0.032;
    }
    tripods.forEach((pivot, i) => {
      const step = (i === 0 ? 1 : -1) * trot;
      pivot.rotation.z = reaction === 'giver' ? -body.rotation.z * 1.4 : reaction ? 0 : step * 0.09;
      pivot.position.y = reaction === 'giver' ? activity * 0.15 : reaction ? 0 : Math.max(0, step) * 0.095;
    });
  };
}

function _beetlePickup({ place, direction, cardEdge, cardHalf }: PickupContext) {
  cardEdge.set(0, -cardHalf.y);
  return (t: number) => {
    const outbound = 0.90 * _step(t, 0.035, 0.36) + 0.10 * _step(t, 0.36, 0.48);
    const homeward = _step(t, 0.60, 0.94);
    const step = Math.sin(Math.PI * 12 * (outbound + homeward));
    const moving = Math.sin(Math.PI * outbound) + Math.sin(Math.PI * homeward);
    place({
      travel: outbound - homeward,
      lift: Math.abs(step) * moving * 0.08,
      roll: direction * moving * step * 0.075,
      yaw: direction * (0.56 * outbound - 1.08 * _step(t, 0.58, 0.73)) * (1 - _step(t, 0.89, 0.98)),
      carrying: t >= 0.48,
      cardRoll: direction * (-0.14 * (_step(t, 0.48, 0.60) - _step(t, 0.83, 0.93)) + 0.04 * moving * step),
    });
  };
}

function _kangaroo(model: Model): Pose {
  const body = _pivot(model.root);
  const fur = 0xc67c47;
  const cream = 0xffdaa0;
  const trunk: Part = [];
  model.stroke(trunk, fur, [[-0.12, -0.43, -0.14], [-0.46, -0.54, -0.24],
    [-0.74, -0.48, -0.32], [-0.96, -0.21, -0.35]], 0.18, 0.022);
  for (const side of [-1, 1]) {
    model.oval(trunk, 0xb36d3c, [side * 0.305, -0.43, -0.015], [0.25, 0.29, 0.23], side * -0.33);
    model.oval(trunk, 0xd18a52, [side * 0.39, -0.713, 0.065], [0.275, 0.092, 0.266], side * 0.10, side * 0.48);
  }
  model.oval(trunk, fur, [0, -0.18, 0], [0.398, 0.49, 0.295]);
  model.oval(trunk, 0xefb572, [0, -0.17, 0.137], [0.29, 0.355, 0.212]);
  for (const side of [-1, 1]) {
    model.stroke(trunk, fur, [[side * 0.26, 0.046, 0.05], [side * 0.378, -0.15, 0.13],
      [side * 0.326, -0.245, 0.29]], 0.09, 0.061);
    model.oval(trunk, 0xb27142, [side * 0.317, -0.244, 0.304], [0.068, 0.059, 0.079], side * -0.48);
  }
  model.finish(trunk, body);

  const head = _pivot(body, 0, 0.369, 0.05);
  const face: Part = [];
  for (const side of [-1, 1]) {
    model.stroke(face, fur, [[side * 0.133, 0.122, -0.072], [side * 0.212, 0.35, -0.072],
      [side * 0.337, 0.586, -0.12]], 0.117, 0.026);
    model.stroke(face, 0xf2ab8c, [[side * 0.179, 0.228, 0.019], [side * 0.231, 0.369, 0.01],
      [side * 0.317, 0.531, -0.068]], 0.063, 0.022);
  }
  model.oval(face, fur, [0, 0.005, 0], [0.33, 0.257, 0.258]);
  for (const side of [-1, 1]) _eye(model, face, [side * 0.164, 0.045, 0.196], 0.080, 0x493127);
  model.oval(face, cream, [0, -0.093, 0.191], [0.204, 0.126, 0.178]);
  model.oval(face, 0x49362d, [0, -0.056, 0.347], [0.080, 0.046, 0.042]);
  model.stroke(face, 0x94684e, [[0, -0.092, 0.365], [0, -0.129, 0.355],
    [0.055, -0.148, 0.338]], 0.011, 0.010);
  model.finish(face, head);

  const pouch: Part = [];
  model.oval(pouch, 0xe6a766, [0, -0.413, 0.214], [0.315, 0.22, 0.25]);
  model.stroke(pouch, cream, [[-0.284, -0.274, 0.29], [-0.18, -0.333, 0.415],
    [0, -0.355, 0.46], [0.18, -0.333, 0.415], [0.284, -0.274, 0.29]], 0.025, 0.025);
  model.finish(pouch, body);

  const joey = _pivot(body, 0, -0.183, 0.348);
  const baby: Part = [];
  model.oval(baby, 0xd9955b, [0, -0.15, -0.03], [0.13, 0.16, 0.102]);
  for (const side of [-1, 1]) {
    model.oval(baby, 0xd6965a, [side * 0.101, 0.123, -0.034], [0.048, 0.122, 0.047], -side * 0.40);
    model.oval(baby, 0xffc0a1, [side * 0.105, 0.142, -0.002], [0.025, 0.077, 0.020], -side * 0.40);
  }
  model.oval(baby, 0xe4a770, [0, 0, 0], [0.174, 0.151, 0.136]);
  for (const side of [-1, 1]) {
    model.oval(baby, 0x422f29, [side * 0.074, 0.021, 0.12], [0.029, 0.04, 0.022]);
  }
  model.oval(baby, cream, [0, -0.039, 0.116], [0.093, 0.07, 0.071]);
  model.oval(baby, 0x50392b, [0, -0.018, 0.185], [0.037, 0.025, 0.018]);
  model.finish(baby, joey);

  const arm = _pivot(joey, 0.11, -0.10, 0.026);
  const paw: Part = [];
  model.stroke(paw, 0xe4a770, [[-0.035, -0.03, -0.025], [0.065, 0, 0.05],
    [0.125, 0.095, 0.07]], 0.055, 0.043);
  model.oval(paw, cream, [0.126, 0.110, 0.074], [0.058, 0.056, 0.055], -0.25);
  model.finish(paw, arm);
  _grip(arm, 0.14, 0.141, 0.09);

  return (activity, t, reaction) => {
    const expect = 1 - _step(t, 0.30, 0.59);
    const peek = _step(t, 0.30, 0.46);
    const reach = peek - _step(t, 0.52, 0.68);
    const bounce = _hop(_step(t, 0.04, 0.43), 2) + _hop(_step(t, 0.58, 0.94), 2);
    body.position.y = 0;
    body.rotation.z = 0;
    body.scale.set(1, 1, 1);
    head.rotation.set(0, 0, 0);
    joey.position.set(0, -0.183, 0.348);
    joey.scale.setScalar(1);
    arm.rotation.z = -0.26;
    arm.scale.setScalar(1);
    if (reaction === 'giver') {
      head.rotation.x = activity * 0.43;
      head.rotation.z = activity * Math.sin(t * Math.PI * 3) * 0.24;
      joey.position.y -= activity * 0.245;
      joey.position.z -= activity * 0.16;
      joey.scale.setScalar(1 - activity * 0.56);
      arm.rotation.z = -0.26 + activity * 0.74;
    } else if (reaction === 'asker') {
      const sink = 1 - expect;
      body.scale.y = 1 + activity * (0.08 * expect - 0.12 * sink);
      head.rotation.z = activity * (0.20 * expect - 0.20 * sink);
      joey.position.y += activity * (0.095 * expect - 0.15 * sink);
      joey.position.z -= activity * 0.095 * sink;
      arm.rotation.z = -0.26 + activity * (0.73 * expect - 0.88 * sink);
    } else {
      body.scale.set(1 - bounce * 0.055, 1 + bounce * 0.09, 1);
      head.rotation.z = activity * (0.10 * bounce - 0.18 * reach);
      joey.position.y += activity * (0.15 * peek + 0.042 * bounce);
      joey.position.x += activity * 0.072 * reach;
      arm.rotation.z += activity * (0.52 * reach + 0.72 * (peek - reach));
      arm.scale.setScalar(1 + activity * 1.05 * reach);
    }
  };
}

function _kangarooPickup({ place, direction }: PickupContext) {
  return (t: number) => {
    const outbound = _step(t, 0.04, 0.43);
    const homeward = _step(t, 0.58, 0.94);
    const outwardJump = _hop(outbound, 2);
    const returnJump = _hop(homeward, 2);
    const turn = outbound - 2 * _step(t, 0.54, 0.70) + _step(t, 0.89, 0.98);
    place({
      travel: outbound - homeward,
      lift: 0.68 * outwardJump + 0.49 * returnJump,
      yaw: direction * turn * 0.42,
      roll: direction * (0.15 * returnJump - 0.19 * outwardJump),
      carrying: t >= 0.50,
      cardRoll: direction * returnJump * 0.13,
    });
  };
}

function _raccoonTail(model: Model, tail: Group) {
  const points = Array.from({ length: 49 }, (_, i) => {
    const t = i / 48;
    return new Vector2(Math.sqrt(Math.sin(Math.PI * t)) * (0.142 + 0.105 * t), t * 1.20);
  });
  const fur = new LatheGeometry(points, 18);
  const part: Part = [];
  _color(part, fur, 0x35404b);
  const vertices = fur.getAttribute('position');
  const colors = fur.getAttribute('color');
  const silver = new Color(0xc0bdb1);
  for (let i = 0; i < vertices.count; i++) {
    const t = vertices.getY(i) / 1.20;
    vertices.setX(i, vertices.getX(i) + 0.47 * Math.sin(t * Math.PI * 0.83) + 0.10 * t);
    if ((t > 0.21 && t < 0.36) || (t > 0.51 && t < 0.67) || (t > 0.80 && t < 0.88)) {
      colors.setXYZ(i, silver.r, silver.g, silver.b);
    }
  }
  fur.computeVertexNormals();
  model.finish(part, tail);
}

function _raccoon(model: Model): Pose {
  const body = _pivot(model.root);
  const gray = 0x8c969b;
  const mask = 0x333944;
  const white = 0xffeed3;
  const tail = _pivot(body, 0.31, -0.56, -0.17);
  _raccoonTail(model, tail);
  const belly: Part = [];
  model.oval(belly, 0x7c8589, [0, -0.35, 0], [0.38, 0.425, 0.285]);
  model.oval(belly, 0xc5c4b8, [0, -0.33, 0.167], [0.24, 0.285, 0.158]);
  for (const side of [-1, 1]) {
    model.oval(belly, mask, [side * 0.235, -0.715, 0.071], [0.147, 0.102, 0.162], side * 0.13);
  }
  model.finish(belly, body);

  const head = _pivot(body, 0, 0.19, 0.037);
  const face: Part = [];
  for (const side of [-1, 1]) {
    model.stroke(face, gray, [[side * 0.277, 0.18, -0.04], [side * 0.326, 0.355, -0.055],
      [side * 0.385, 0.53, -0.068]], 0.163, 0.03);
    model.stroke(face, mask, [[side * 0.299, 0.29, 0.074], [side * 0.333, 0.376, 0.04],
      [side * 0.373, 0.479, -0.008]], 0.081, 0.022);
    model.oval(face, 0xbbbab1, [side * 0.356, -0.091, 0.022], [0.199, 0.112, 0.168], -side * 0.27);
  }
  model.oval(face, gray, [0, 0.025, 0], [0.467, 0.326, 0.298]);
  for (const side of [-1, 1]) {
    model.oval(face, white, [side * 0.241, 0.098, 0.205], [0.196, 0.116, 0.075],
      side * 0.20, side * 0.38);
    model.oval(face, mask, [side * 0.245, 0.038, 0.233], [0.209, 0.111, 0.080],
      side * 0.20, side * 0.38);
    _eye(model, face, [side * 0.205, 0.065, 0.299], 0.074, 0x382d35);
    model.oval(face, white, [side * 0.09, -0.087, 0.256], [0.14, 0.102, 0.095], -side * 0.17);
  }
  model.oval(face, 0x282c37, [0, -0.035, 0.353], [0.077, 0.052, 0.043]);
  model.stroke(face, 0x66616a, [[0, -0.083, 0.346], [0, -0.11, 0.339],
    [0.058, -0.129, 0.337]], 0.012, 0.010);
  model.finish(face, head);

  const arms = [-1, 1].map(side => {
    const shoulder = _pivot(body, side * 0.293, -0.125, 0.131);
    const limb: Part = [];
    model.stroke(limb, gray, [[0, 0, 0], [side * 0.059, -0.093, 0.053],
      [side * 0.017, -0.189, 0.14]], 0.092, 0.080);
    model.oval(limb, mask, [side * 0.010, -0.202, 0.176], [0.090, 0.094, 0.082], -side * 0.21);
    model.oval(limb, 0xe9ae9a, [side * 0.005, -0.21, 0.247], [0.047, 0.040, 0.021], -side * 0.21);
    model.finish(limb, shoulder);
    if (side === 1) _grip(shoulder, 0.013, -0.194, 0.24);
    return { shoulder, side };
  });

  return (activity, t, reaction) => {
    const firstLook = Math.sin(Math.PI * _step(t, 0.13, 0.25));
    const secondLook = Math.sin(Math.PI * _step(t, 0.30, 0.43));
    const reach = _step(t, 0.42, 0.52) - _step(t, 0.53, 0.65);
    const hug = _step(t, 0.54, 0.66);
    const stride = Math.sin(t * Math.PI * 24);
    const expect = 1 - _step(t, 0.32, 0.57);
    body.position.y = activity * (-0.08 * (1 - hug) + 0.04 * hug);
    body.scale.y = 1 - activity * 0.06 * (1 - hug);
    head.rotation.set(0, activity * (-0.55 * firstLook + 0.64 * secondLook), activity * (0.13 * firstLook - 0.16 * secondLook));
    tail.rotation.z = activity * (-0.25 + 0.13 * stride);
    if (reaction === 'giver') {
      body.position.y = 0;
      body.scale.y = 1;
      head.rotation.set(activity * 0.30, activity * 0.58 * Math.sin(t * Math.PI * 3),
        activity * 0.19 * Math.sin(t * Math.PI * 3));
      tail.rotation.z = -activity * 0.26;
    } else if (reaction === 'asker') {
      body.position.y = activity * (0.07 * expect - 0.13 * (1 - expect));
      body.scale.y = 1 + activity * (0.06 * expect - 0.09 * (1 - expect));
      head.rotation.set(activity * (0.31 - 0.56 * expect), 0, activity * 0.18 * (1 - expect));
      tail.rotation.z = activity * (0.18 * expect - 0.74 * (1 - expect));
    }
    for (const { shoulder, side } of arms) {
      if (reaction === 'giver') {
        shoulder.rotation.set(-activity * 0.94, 0, side * activity * 1.11);
      } else if (reaction === 'asker') {
        shoulder.rotation.set(-activity * 0.88 * expect, 0, side * activity * (0.45 * expect - 0.24));
      } else {
        shoulder.rotation.set(activity * (-0.22 - 0.96 * reach - 0.64 * hug), side * activity * (0.28 * reach - 0.44 * hug),
          side * activity * (0.20 * stride * (1 - hug) + 0.56 * reach - 0.98 * hug));
      }
    }
  };
}

function _raccoonPickup(ctx: PickupContext) {
  const { place, direction, cardEdge, cardHalf } = ctx;
  const reachEdge = cardEdge.clone();
  return (t: number) => {
    const outbound = 0.43 * _step(t, 0.035, 0.16) + 0.36 * _step(t, 0.235, 0.34)
      + 0.21 * _step(t, 0.405, 0.53);
    const homeward = _step(t, 0.64, 0.95);
    const tiptoe = Math.sin(Math.PI * 10 * outbound);
    const lope = _hop(homeward, 3);
    const glance = Math.sin(Math.PI * _step(t, 0.15, 0.23)) - Math.sin(Math.PI * _step(t, 0.32, 0.42));
    const travel = outbound - homeward;
    const hug = _step(t, 0.54, 0.67);
    ctx.cardScale *= 1 - 0.40 * hug;
    cardEdge.set(reachEdge.x * (1 - hug) - cardHalf.x * 0.60 * hug,
      reachEdge.y * (1 - hug) + cardHalf.y * 0.40 * hug);
    place({
      travel,
      sway: (0.13 * tiptoe + 0.10 * glance) * Math.sin(Math.PI * outbound),
      lift: 0.06 * Math.abs(tiptoe) * Math.sin(Math.PI * outbound) + 0.18 * lope,
      roll: direction * (0.15 * Math.sin(Math.PI * outbound) + 0.11 * glance - 0.10 * lope),
      yaw: direction * (0.40 * travel - 0.65 * Math.sin(Math.PI * homeward)),
      carrying: t >= 0.53,
      cardRoll: -direction * 0.17 * (_step(t, 0.54, 0.66) - _step(t, 0.85, 0.97)),
    });
  };
}

export const forestModels = { beetle: _beetle, kangaroo: _kangaroo, raccoon: _raccoon };
export const forestPickups = { beetle: _beetlePickup, kangaroo: _kangarooPickup, raccoon: _raccoonPickup };
