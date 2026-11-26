import { expect, test } from '@playwright/test';
import { mayTakeHolderDown, mayWaitForSeats, worstCaseMs } from '../lib/deadline';
import type { Kill, KillKind } from '../lib/plan';

const NOW = 1_000_000;

function _kill(kind: KillKind, downMs: number): Kill {
  const restart = kind === 'restart';
  return { id: 1, dueBeforeMove: 2, kind, seat: restart ? 'mover' : 0, timing: 'between', downMs, movesWhileDown: restart ? 0 : 1 };
}

// Short planned down times, to show the rule uses the top of each kind's range.
test('the worst case is the longest down time plus the recovery limit', () => {
  expect(worstCaseMs(_kill('cut', 0))).toBe(5_000);
  expect(worstCaseMs(_kill('freeze', 21_000))).toBe(33_000);
  expect(worstCaseMs(_kill('refuse', 5_000))).toBe(32_000);
  expect(worstCaseMs(_kill('restart', 2_000))).toBe(0);
});

test('a freeze never fits a 30 s choice', () => {
  expect(mayTakeHolderDown(_kill('freeze', 21_000), NOW + 30_000, NOW)).toBe(false);
});

test('a cut fits a fresh turn', () => {
  expect(mayTakeHolderDown(_kill('cut', 0), NOW + 60_000, NOW)).toBe(true);
});

test('a refuse needs 42 s left', () => {
  const refuse = _kill('refuse', 5_000);
  expect(mayTakeHolderDown(refuse, NOW + 41_999, NOW)).toBe(false);
  expect(mayTakeHolderDown(refuse, NOW + 42_000, NOW)).toBe(true);
});

test('a restart is exempt', () => {
  expect(mayTakeHolderDown(_kill('restart', 15_000), NOW + 1, NOW)).toBe(true);
});

test('no deadline, no limit', () => {
  expect(mayTakeHolderDown(_kill('freeze', 30_000), null, NOW)).toBe(true);
  expect(mayWaitForSeats([{ kill: _kill('freeze', 30_000), startedAt: NOW }], null, false, NOW)).toBe(true);
});

test('no waiting while a choice is open', () => {
  const inProgress = [{ kill: _kill('cut', 0), startedAt: NOW }];
  expect(mayWaitForSeats(inProgress, NOW + 60_000, true, NOW)).toBe(false);
  expect(mayWaitForSeats(inProgress, null, true, NOW)).toBe(false);
});

test("waiting stops when one kill's worst case passes the margin", () => {
  // The cut is back by NOW + 5 s; the refuse, started 5 s earlier, by NOW + 27 s. Both need 10 s spare after.
  const inProgress = [
    { kill: _kill('cut', 0), startedAt: NOW },
    { kill: _kill('refuse', 6_000), startedAt: NOW - 5_000 },
  ];
  expect(mayWaitForSeats(inProgress, NOW + 37_000, false, NOW)).toBe(true);
  expect(mayWaitForSeats(inProgress, NOW + 36_999, false, NOW)).toBe(false);
  expect(mayWaitForSeats(inProgress.slice(0, 1), NOW + 36_999, false, NOW)).toBe(true);
});

test('a restart in progress never stops the wait', () => {
  expect(mayWaitForSeats([{ kill: _kill('restart', 15_000), startedAt: NOW }], NOW + 1, false, NOW + 20_000)).toBe(true);
});
