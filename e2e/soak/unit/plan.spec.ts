import { expect, test } from '@playwright/test';
import { SHORT_SEED } from '../lib/limits';
import { buildPlan, type Kill, type Size } from '../lib/plan';

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);
const SIZES: Size[] = ['short', 'long'];

function _everyKill(): { seed: number; kill: Kill }[] {
  return SIZES.flatMap((size) => SEEDS.flatMap((seed) => buildPlan(seed, size).map((kill) => ({ seed, kill }))));
}

function _expectOrderedWithin(plan: Kill[], window: number, seed: number): void {
  expect(plan.map((k) => k.id), `seed ${seed}`).toEqual(plan.map((_, i) => i + 1));
  plan.forEach((kill, i) => {
    expect(kill.dueBeforeMove, `seed ${seed}`).toBeGreaterThanOrEqual(i === 0 ? 2 : plan[i - 1].dueBeforeMove);
    expect(kill.dueBeforeMove, `seed ${seed}`).toBeLessThanOrEqual(window);
  });
}

test('same seed, same plan', () => {
  for (const size of SIZES) expect(buildPlan(7, size)).toEqual(buildPlan(7, size));
});

test('different seeds differ', () => {
  for (const size of SIZES) expect(buildPlan(8, size)).not.toEqual(buildPlan(7, size));
});

test('short has one kill of each kind, due within moves 2 to 12', () => {
  for (const seed of [SHORT_SEED, ...SEEDS]) {
    const plan = buildPlan(seed, 'short');
    expect(plan.map((k) => k.kind).sort(), `seed ${seed}`).toEqual(['cut', 'freeze', 'refuse', 'restart']);
    _expectOrderedWithin(plan, 12, seed);
  }
});

test('long has 8 kills, at least one restart, due within moves 2 to 30', () => {
  for (const seed of SEEDS) {
    const plan = buildPlan(seed, 'long');
    expect(plan, `seed ${seed}`).toHaveLength(8);
    expect(plan.some((k) => k.kind === 'restart'), `seed ${seed}`).toBe(true);
    _expectOrderedWithin(plan, 30, seed);
  }
});

test('mid-move only on cut and restart, and a mid-move cut targets the mover', () => {
  const all = _everyKill();
  for (const { seed, kill } of all) {
    if (kill.timing === 'midMove') expect(['cut', 'restart'], `seed ${seed}`).toContain(kill.kind);
    if (kill.kind === 'cut' && kill.timing === 'midMove') expect(kill.seat, `seed ${seed}`).toBe('mover');
  }
  expect(all.some(({ kill }) => kill.kind === 'cut' && kill.timing === 'midMove')).toBe(true);
  expect(all.some(({ kill }) => kill.kind === 'restart' && kill.timing === 'midMove')).toBe(true);
});

test('ranges hold', () => {
  const range = { cut: [0, 0], freeze: [21_000, 30_000], refuse: [5_000, 20_000], restart: [2_000, 15_000] };
  for (const { seed, kill } of _everyKill()) {
    const [low, high] = range[kill.kind];
    expect(kill.downMs, `seed ${seed}`).toBeGreaterThanOrEqual(low);
    expect(kill.downMs, `seed ${seed}`).toBeLessThanOrEqual(high);
    if (kill.kind === 'restart') expect(kill.seat, `seed ${seed}`).toBe('mover');
    if (kill.kind === 'restart' || kill.timing === 'midMove') {
      expect(kill.movesWhileDown, `seed ${seed}`).toBe(0);
    } else {
      expect(kill.movesWhileDown, `seed ${seed}`).toBeGreaterThanOrEqual(1);
      expect(kill.movesWhileDown, `seed ${seed}`).toBeLessThanOrEqual(4);
    }
  }
});

// A seat kill between moves names a seat, and no seat takes a second kill before every seat has had one.
test('kills spread over moves and seats', () => {
  for (const size of SIZES) {
    for (const seed of SEEDS) {
      const plan = buildPlan(seed, size);
      const due = plan.map((k) => k.dueBeforeMove);
      expect(new Set(due).size, `${size} seed ${seed}`).toBe(due.length);
      for (const kill of plan) {
        if (kill.kind !== 'restart' && kill.timing === 'between') expect(kill.seat, `seed ${seed}`).not.toBe('mover');
      }
      const seats = plan.flatMap((k) => (k.seat === 'mover' ? [] : [k.seat]));
      for (const seat of seats) expect([0, 1, 2, 3, 4, 5], `seed ${seed}`).toContain(seat);
      expect(new Set(seats.slice(0, 6)).size, `${size} seed ${seed}`).toBe(Math.min(seats.length, 6));
    }
  }
});
