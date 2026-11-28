type Pose = ReturnType<typeof _pose>;

function _pose(x: number, y: number, angle = 0, scale = 1, back = false, opacity = 1) {
  return { x, y, angle, scale, flip: back ? 180 : 0, opacity };
}

const hidden = _pose(50, 50, 0, 0.6, true, 0);
const ranks = [1, 2, 3, 4, 5, 6];
const mine = [1, 3, 5, 6];

function _fan(cards: number[], x: number, y: number, gap: number, scale: number): Pose[] {
  return ranks.map(rank => {
    const index = cards.indexOf(rank);
    if (index < 0) return hidden;
    const offset = index - (cards.length - 1) / 2;
    return _pose(x + offset * gap, y + offset ** 2 * 0.8, offset * 8, scale);
  });
}

const ask = _fan([1, 3, 5], 28, 50, 9, 0.94);
ask[5] = _pose(76, 44, 9, 0.98, true);

const miss = _fan(mine, 30, 52, 7, 0.83);
miss[1] = _pose(77, 43, 9, 0.9, true);

const clue = ranks.map(() => hidden);
clue[2] = _pose(24, 46, -9);
clue[1] = _pose(68, 45, -8, 0.94, true);
clue[3] = _pose(77, 45, 9, 0.94, true);

const owners = _fan(mine, 29, 46, 8, 0.88);
owners[1] = _pose(71, 45, -6, 0.88);
owners[3] = _pose(81, 45, 7, 0.88);

export const frames: Pose[][] = [
  [[50, 75], [20, 65], [20, 30], [50, 20], [80, 30], [80, 65]].map(([x, y], i) => _pose(x, y, [0, -18, -12, 0, 12, 18][i], 0.48, true)),
  ranks.map((_, i) => _pose(15 + i * 14, 47 + Math.abs(i - 2.5) * 2, (i - 2.5) * 3, 0.75)),
  _fan([1, 3, 5], 50, 46, 17, 1.14),
  ask,
  _fan(mine, 50, 45, 14, 1.04),
  miss,
  clue,
  owners,
  ranks.map(rank => {
    const i = mine.indexOf(rank);
    return i >= 0 ? _pose(26 + i * 16, 24, 0, 0.69) : _pose(rank === 2 ? 42 : 58, 69, 0, 0.69);
  }),
  ranks.map((_, i) => _pose(43 + i * 2.6, 49 - i * 1.2, -15 + i * 5, 1.13)),
];

export type { Pose };
