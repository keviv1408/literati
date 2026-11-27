import { Group } from 'three';
import { Model, type Part, type Point, type Pose } from './geometry';
import type { PickupContext } from './pickup';
import { createElephantReach, createGeckoTracks, createSpiderSilk, elephantTrunk } from './wildEffects';

function _joint(parent: Group, x = 0, y = 0, z = 0, name = '') {
  const joint = new Group();
  joint.position.set(x, y, z);
  joint.name = name;
  parent.add(joint);
  return joint;
}

function _elephant(model: Model): Pose {
  const skin = 0x95a8d2;
  const shadow = 0x778eb7;
  const seated = _joint(model.root);
  const body: Part = [];
  model.oval(body, shadow, [0, -0.32, -0.11], [0.46, 0.44, 0.40]);
  model.oval(body, 0xb7c8e4, [0, -0.32, 0.15], [0.30, 0.35, 0.19]);
  for (const side of [-1, 1]) {
    model.oval(body, skin, [side * 0.38, -0.55, 0.04], [0.23, 0.21, 0.26], side * -0.22);
    model.oval(body, 0xc2b8d4, [side * 0.40, -0.58, 0.24], [0.17, 0.14, 0.072]);
    model.oval(body, skin, [side * 0.24, -0.43, 0.21], [0.14, 0.29, 0.16], side * 0.19);
    for (let toe = 0; toe < 3; toe++) {
      model.oval(body, 0xe3d5dd, [side * (0.19 + toe * 0.063), -0.66 + toe * 0.012, 0.32],
        [0.039, 0.040, 0.035]);
    }
  }
  model.finish(body, seated);

  const head = _joint(seated, 0, 0.09);
  const ears = [-1, 1].map(side => {
    const ear = _joint(head, side * 0.34, 0.21, -0.025);
    const part: Part = [];
    model.oval(part, skin, [side * 0.25, 0, 0], [0.37, 0.46, 0.14], -side * 0.32);
    model.oval(part, 0xd4a4b9, [side * 0.28, 0.01, 0.091], [0.264, 0.333, 0.069], -side * 0.32);
    model.oval(part, 0xe4b9c7, [side * 0.31, 0.075, 0.135], [0.168, 0.20, 0.030], -side * 0.38);
    model.finish(part, ear);
    return ear;
  });
  const face: Part = [];
  model.oval(face, skin, [0, 0.18, 0.10], [0.53, 0.49, 0.41]);
  for (const side of [-1, 1]) {
    model.oval(face, 0xa5badd, [side * 0.26, 0.024, 0.335], [0.198, 0.16, 0.108]);
    model.oval(face, 0xd6adbb, [side * 0.354, 0.034, 0.421], [0.075, 0.043, 0.020], side * 0.08);
    model.oval(face, 0x343344, [side * 0.255, 0.215, 0.46], [0.079, 0.102, 0.051], -side * 0.10);
    model.oval(face, 0xfff9e8, [side * 0.255 - 0.021, 0.251, 0.507], [0.025, 0.027, 0.013]);
    model.stroke(face, 0x7687af, [[side * 0.17, 0.377, 0.445], [side * 0.252, 0.402, 0.421],
      [side * 0.318, 0.37, 0.405]], 0.024, 0.013);
  }
  model.stroke(face, 0x7687af, [[-0.16, 0.59, 0.13], [-0.17, 0.72, 0.12], [-0.085, 0.755, 0.13]],
    0.047, 0.018);
  model.stroke(face, skin, [[-0.13, 0.585, 0.15], [-0.052, 0.707, 0.13], [0.042, 0.715, 0.12]],
    0.060, 0.018);
  model.finish(face, head);

  const trunk = _joint(head, 0, 0, 0, 'elephant-trunk');
  const rest: Part = [];
  model.stroke(rest, skin, elephantTrunk, 0.148, 0.073);
  model.oval(rest, 0xccadc4, [0.309, -0.217, 0.65], [0.067, 0.053, 0.034]);
  model.oval(rest, 0x796e94, [0.308, -0.208, 0.68], [0.028, 0.020, 0.010]);
  model.finish(rest, trunk);
  const tip = elephantTrunk[elephantTrunk.length - 1];
  const grip = _joint(trunk, ...tip, 'card-grip');
  return (activity, phase, reaction) => {
    const flap = Math.sin(phase * Math.PI * 8);
    const shake = Math.sin(phase * Math.PI * 5);
    const asker = reaction === 'asker' ? activity : 0;
    const giver = reaction === 'giver' ? activity : 0;
    const pickup = reaction ? 0 : activity;
    seated.scale.set(1 + 0.10 * asker, 1 - 0.18 * asker, 1);
    head.position.y = 0.09 - 0.10 * asker + 0.045 * giver;
    head.rotation.set(0.23 * asker, 0.38 * shake * giver, 0.10 * asker - 0.05 * pickup);
    ears.forEach((ear, i) => {
      const side = i * 2 - 1;
      ear.rotation.y = side * (0.13 + pickup * (0.25 + 0.43 * flap) + 0.28 * giver);
      ear.rotation.z = side * (-0.42 * asker + 0.21 * giver + 0.12 * flap * pickup);
    });
    trunk.rotation.z = -0.53 * asker + (0.55 + shake * 0.35) * giver;
    trunk.visible = true;
    grip.position.set(...tip);
  };
}

function _spider(model: Model): Pose {
  const spider = _joint(model.root);
  const body: Part = [];
  model.oval(body, 0x514167, [0, 0.10, -0.30], [0.44, 0.47, 0.37]);
  model.oval(body, 0xf0a259, [0, 0.40, -0.17], [0.32, 0.20, 0.15]);
  model.oval(body, 0x493d59, [0, 0.36, -0.10], [0.29, 0.095, 0.13]);
  model.oval(body, 0xffce7e, [0, 0.53, -0.119], [0.17, 0.059, 0.095]);
  model.finish(body, spider);
  _joint(spider, 0, 0.18, -0.62, 'spider-spinneret');

  const legs = [-1, 1].flatMap(side => {
    const legEnds: Point[] = [[0.72, 0.29, -0.26], [0.91, 0.02, -0.12],
      [0.90, -0.33, 0.03], [0.67, -0.60, 0.30]];
    return legEnds.map(([x, y, z], i) => {
      const leg = _joint(spider, side * 0.26, -0.04, 0);
      const part: Part = [];
      const knee: Point = [side * (x - 0.35), y + 0.22, z - 0.07];
      const foot: Point = [side * (x - 0.26), y - 0.02, z + 0.07];
      model.stroke(part, 0x51425b, [[0, 0, 0], [side * 0.12, y * 0.53, z * 0.40], knee], 0.075, 0.063);
      model.stroke(part, 0x624b66, [knee, [side * (x - 0.273), y + 0.06, z], foot], 0.069, 0.040);
      model.oval(part, 0xe6a46b, knee, [0.065, 0.072, 0.065], side * -0.23);
      model.oval(part, 0xffcd8b, foot, [0.067, 0.051, 0.069], side * 0.19);
      model.finish(part, leg);
      return { leg, side, i };
    });
  });

  const head = _joint(spider, 0, -0.07, 0.10);
  const face: Part = [];
  model.oval(face, 0x65567e, [0, 0.055, 0], [0.49, 0.315, 0.30]);
  model.oval(face, 0x8b78a2, [0, 0.21, 0.024], [0.41, 0.18, 0.27]);
  for (const side of [-1, 1]) {
    model.oval(face, 0xd2b5b0, [side * 0.19, 0.095, 0.224], [0.193, 0.207, 0.121]);
    model.oval(face, 0x242536, [side * 0.19, 0.102, 0.296], [0.162, 0.178, 0.102]);
    model.oval(face, 0xfdf5e7, [side * 0.19 - 0.047, 0.150, 0.385], [0.055, 0.059, 0.021]);
    model.oval(face, 0x8bbbc7, [side * 0.19 + 0.052, 0.058, 0.387], [0.021, 0.024, 0.010]);
    model.oval(face, 0x332d41, [side * 0.412, 0.131, 0.156], [0.071, 0.075, 0.062]);
    model.oval(face, 0xf8dfc2, [side * 0.407 - 0.014, 0.149, 0.209], [0.022, 0.021, 0.010]);
  }
  model.finish(face, head);
  const palps = [-1, 1].map(side => {
    const palp = _joint(head, side * 0.115, -0.105, 0.235);
    const part: Part = [];
    model.oval(part, 0xd6a787, [side * 0.043, -0.086, 0.015], [0.077, 0.145, 0.086], side * -0.32);
    model.oval(part, 0xf6d1a1, [side * 0.077, -0.171, 0.08], [0.086, 0.074, 0.070]);
    model.finish(part, palp);
    return palp;
  });
  _joint(palps[1], 0.077, -0.19, 0.14, 'card-grip');
  return (activity, phase, reaction) => {
    const wave = Math.sin(phase * Math.PI * 6);
    const asker = reaction === 'asker' ? activity : 0;
    const giver = reaction === 'giver' ? activity : 0;
    const pickup = reaction ? 0 : activity;
    const spring = pickup * Math.sin(phase * Math.PI * 4);
    spider.scale.set(1 + asker * 0.07 - spring * 0.04, 1 - asker * 0.23 + spring * 0.12, 1);
    spider.position.y = -0.11 * asker;
    head.rotation.z = giver * wave * 0.14 + asker * 0.12;
    for (const { leg, side, i } of legs) {
      leg.rotation.z = side * (giver * (i === 3 ? 0.95 : 0.17) - asker * (0.34 + i * 0.06)
        + spring * (0.24 - i * 0.11));
    }
    palps.forEach((palp, i) => {
      palp.rotation.z = (i * 2 - 1) * (giver * (1.25 + wave * 0.20) - asker * 0.38 + pickup * 0.21);
    });
  };
}

function _gecko(model: Model): Pose {
  const skin = 0x74cb49;
  const pads = 0xb9e36a;
  const gecko = _joint(model.root, 0, 0, 0, 'gecko-body');
  const tail = _joint(gecko, -0.15, -0.30, -0.09);
  const tailPart: Part = [];
  model.stroke(tailPart, 0x61b964, [[0, 0, 0], [-0.075, -0.23, 0.01], [-0.37, -0.39, -0.025],
    [-0.59, -0.33, -0.01], [-0.65, -0.15, 0], [-0.57, -0.041, 0.035]], 0.145, 0.028);
  model.finish(tailPart, tail);

  const body: Part = [];
  model.oval(body, skin, [-0.07, -0.06, 0.025], [0.255, 0.455, 0.20], -0.43);
  model.oval(body, 0xc8df78, [-0.005, -0.072, 0.157], [0.155, 0.309, 0.074], -0.46);
  model.oval(body, 0xeca14a, [-0.175, 0.083, 0.179], [0.060, 0.083, 0.024], -0.42);
  model.oval(body, 0xeca14a, [-0.241, -0.081, 0.169], [0.046, 0.052, 0.022]);
  model.finish(body, gecko);
  const legs = [
    { x: -0.11, y: 0.16, side: -1, up: 1 }, { x: 0.18, y: 0.15, side: 1, up: 1 },
    { x: -0.23, y: -0.24, side: -1, up: -1 }, { x: 0.00, y: -0.24, side: 1, up: -1 },
  ].map(({ x, y, side, up }, i) => {
    const leg = _joint(gecko, x, y, 0.10);
    const footX = side * (i === 1 ? 0.49 : 0.34);
    const footY = up * (i === 1 ? 0.30 : 0.17);
    _joint(leg, footX, footY, 0.115, `gecko-foot-${i}`);
    const part: Part = [];
    model.stroke(part, i % 2 ? skin : 0x64bd54, [[0, 0, 0], [side * 0.18, up * -0.06, -0.02],
      [footX * 0.78, footY * 0.61, 0.05], [footX, footY, 0.115]], 0.080, 0.051);
    model.oval(part, pads, [footX, footY, 0.115], [0.086, 0.063, 0.044], side * up * 0.48);
    for (let toe = 0; toe < 4; toe++) {
      const theta = -0.32 + toe * 0.64;
      const dx = Math.cos(theta) * (toe === 0 ? 0.112 : 0.145) * side;
      const dy = Math.sin(theta) * 0.145 * up;
      const toeTip: Point = [footX + dx, footY + dy, 0.152];
      model.stroke(part, pads, [[footX, footY, 0.119], [footX + dx * 0.57, footY + dy * 0.57, 0.13],
        toeTip], 0.025, 0.018);
      model.oval(part, 0xd7eb88, toeTip, [0.039, 0.035, 0.024]);
      if (i === 1 && toe === 2) _joint(leg, ...toeTip, 'card-grip');
    }
    model.finish(part, leg);
    return { leg, side, up };
  });

  const head = _joint(gecko, 0.16, 0.34, 0.12);
  const face: Part = [];
  model.oval(face, skin, [0.035, 0.064, 0.05], [0.34, 0.284, 0.233], -0.20);
  model.oval(face, 0x9cdb52, [0.19, 0.03, 0.16], [0.28, 0.169, 0.153], -0.07);
  model.oval(face, 0xd0e589, [0.20, -0.006, 0.196], [0.25, 0.122, 0.115], -0.07);
  model.stroke(face, 0x53743c, [[0.044, -0.028, 0.278], [0.17, -0.05, 0.31], [0.33, -0.023, 0.291],
    [0.419, 0.018, 0.261]], 0.016, 0.011);
  for (const side of [-1, 1]) {
    const x = side < 0 ? -0.092 : 0.244;
    const y = side < 0 ? 0.204 : 0.219;
    const z = side < 0 ? 0.17 : 0.048;
    model.oval(face, 0x88c544, [x, y, z], [0.13, 0.146, 0.113]);
    model.oval(face, 0xffc556, [x, y, z + 0.063], [0.100, 0.107, 0.080]);
    model.oval(face, 0x33463a, [x + 0.014, y, z + 0.134], [0.038, 0.082, 0.020], -0.07);
    model.oval(face, 0xfff8d9, [x - 0.014, y + 0.037, z + 0.15], [0.023, 0.022, 0.012]);
  }
  model.oval(face, 0xd57c40, [0.027, 0.146, 0.262], [0.049, 0.038, 0.016]);
  model.oval(face, 0x6e8243, [0.377, 0.081, 0.269], [0.027, 0.020, 0.012]);
  model.finish(face, head);
  return (activity, phase, reaction) => {
    const walk = Math.sin(phase * Math.PI * 12);
    const shake = Math.sin(phase * Math.PI * 5);
    const asker = reaction === 'asker' ? activity : 0;
    const giver = reaction === 'giver' ? activity : 0;
    const pickup = reaction ? 0 : activity;
    gecko.scale.set(1, 1 - 0.14 * asker, 1);
    gecko.rotation.y = 0;
    head.rotation.z = -0.39 * asker + giver * shake * 0.25 + 0.05 * walk * pickup;
    tail.rotation.z = asker * 0.61 + giver * shake * 0.40 + walk * pickup * 0.26;
    legs.forEach(({ leg, side, up }, i) => {
      leg.rotation.z = side * up * (walk * pickup * (i % 3 === 0 ? 0.23 : -0.23)
        + (up === 1 ? giver * (0.59 + 0.15 * shake) - asker * 0.64 : 0));
    });
  };
}

function _ease(t: number, start: number, end: number) {
  const u = Math.min(1, Math.max(0, (t - start) / (end - start)));
  return u * u * (3 - 2 * u);
}

function _elephantPickup(ctx: PickupContext) {
  const reach = createElephantReach(ctx);
  return (t: number) => {
    const extend = _ease(t, 0.09, 0.42);
    const coil = _ease(t, 0.37, 0.51) * (1 - _ease(t, 0.84, 0.95));
    const pull = _ease(t, 0.5, 0.92);
    const active = extend * (1 - _ease(t, 0.85, 0.97));
    const lean = Math.sin(Math.PI * extend) * 0.10;
    ctx.place({ travel: 0, yaw: ctx.direction * lean, roll: -ctx.direction * lean * 0.65, carrying: false });
    reach(active, coil, pull);
  };
}

function _spiderPickup(ctx: PickupContext) {
  const silk = createSpiderSilk(ctx);
  return (t: number) => {
    const out = _ease(t, 0.15, 0.39);
    const recoil = _ease(t, 0.51, 0.82);
    const bow = Math.sin(Math.PI * out);
    const reel = Math.sin(Math.PI * recoil);
    const windup = Math.sin(Math.PI * _ease(t, 0.015, 0.15));
    const travel = out * (1 - recoil);
    ctx.place({ travel, lift: 1.30 * bow - 0.09 * windup + reel * 0.24,
      roll: ctx.direction * (windup * 0.15 - bow * 0.29 + reel * 0.38),
      yaw: ctx.direction * 0.28 * bow, scale: 1 - 0.13 * windup + 0.12 * bow,
      carrying: t >= 0.39, cardRoll: ctx.direction * reel * 0.22 });
    silk(travel, bow, reel);
  };
}

function _geckoPickup(ctx: PickupContext) {
  const tracks = createGeckoTracks(ctx);
  const body = ctx.actor.getObjectByName('gecko-body')!;
  return (t: number) => {
    const out = _ease(t, 0.03, 0.41);
    const back = _ease(t, 0.49, 0.92);
    const outStride = Math.sin(Math.PI * 3 * out);
    const backStride = Math.sin(Math.PI * 3 * back);
    const cardRoll = -0.12 * ctx.direction * backStride;
    const travel = out - back;
    if (ctx.direction < 0) {
      const turn = _ease(t, 0, 0.08) * (1 - _ease(t, 0.91, 1));
      body.scale.x = Math.cos(Math.PI * turn);
      body.rotation.y = -0.9 * Math.sin(Math.PI * turn);
    }
    ctx.place({ travel, lift: 0.14 * (outStride ** 2 + backStride ** 2),
      sway: 0.11 * (outStride + backStride), yaw: ctx.direction * 0.18 * (outStride - backStride),
      roll: ctx.direction * (0.20 * outStride - 0.15 * backStride), carrying: t >= 0.41,
      cardRoll });
    tracks(t, back, cardRoll);
  };
}

export const wildModels = { elephant: _elephant, spider: _spider, gecko: _gecko };
export const wildPickups = { elephant: _elephantPickup, spider: _spiderPickup, gecko: _geckoPickup };
