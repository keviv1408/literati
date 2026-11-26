import { DUE_WINDOW, FREEZE_AGE_MS, KILL_COUNT, MOVES_WHILE_DOWN, REFUSE_MS, RESTART_WAIT_MS } from './limits';
import { createRng, type Rng } from './rng';

export const KILL_KINDS = ['cut', 'freeze', 'refuse', 'restart'] as const;
export type KillKind = (typeof KILL_KINDS)[number];
export type Size = 'short' | 'long';

export interface Kill {
  id: number;
  dueBeforeMove: number;
  kind: KillKind;
  seat: number | 'mover';
  timing: 'between' | 'midMove';
  downMs: number;
  movesWhileDown: number;
}

const TIMINGS = ['between', 'midMove'] as const;
const SEATS = [0, 1, 2, 3, 4, 5];
const DOWN_MS: Record<KillKind, readonly [number, number]> = {
  cut: [0, 0],
  freeze: FREEZE_AGE_MS,
  refuse: REFUSE_MS,
  restart: RESTART_WAIT_MS,
};

export function buildPlan(seed: number, size: Size): Kill[] {
  const rng = createRng(seed);
  const count = KILL_COUNT[size];
  // Every kind at least once, so the long run always has a restart.
  const extra = Array.from({ length: count - KILL_KINDS.length }, () => rng.pick(KILL_KINDS));
  const kinds = _shuffle(rng, [...KILL_KINDS, ...extra]);
  // Seat kills go round the table in a shuffled order: no seat gets a second before every seat has one.
  const seats = _shuffle(rng, SEATS);
  let seatKills = 0;
  return _dueMoves(rng, count, DUE_WINDOW[size]).map((dueBeforeMove, i) => {
    const kind = kinds[i];
    const timing = kind === 'cut' || kind === 'restart' ? rng.pick(TIMINGS) : 'between';
    // A mid-move cut settles only on the mover's new game_init, so no move is made while it is down.
    const mover = kind === 'restart' || timing === 'midMove';
    return {
      id: i + 1,
      dueBeforeMove,
      kind,
      seat: mover ? 'mover' : seats[seatKills++ % seats.length],
      timing,
      downMs: rng.int(...DOWN_MS[kind]),
      movesWhileDown: mover ? 0 : rng.int(...MOVES_WHILE_DOWN),
    };
  });
}

// One due move in each of `count` equal bands of moves 2 to `window`, so kills spread out instead of bunching.
function _dueMoves(rng: Rng, count: number, window: number): number[] {
  const edge = (i: number) => Math.ceil((i * (window - 1)) / count);
  return Array.from({ length: count }, (_, i) => 2 + rng.int(edge(i), edge(i + 1) - 1));
}

function _shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
