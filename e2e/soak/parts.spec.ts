import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type Page, type Route } from '@playwright/test';
import { pageProblems } from './lib/checks';
import { playGame, type GameResult, type KillRecord } from './lib/driver';
import { SoakFailure } from './lib/fail';
import { BACKEND_URL, FRONTEND_URL, TIMER_CHAIN_MAX_MS } from './lib/limits';
import type { Kill } from './lib/plan';
import { closeTable, isUp, openTable, type Seat } from './lib/seats';
import { startStack, type Stack } from './lib/stack';

let stack: Stack;

test.beforeAll(async () => {
  stack = await startStack('standin', test.info().outputDir);
});

test.afterAll(async () => {
  await stack?.stop();
});

async function _pageClock(page: Page) {
  return page.evaluate(async () => {
    const started = performance.now();
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    return { visibility: document.visibilityState, chainMs: Math.round(performance.now() - started) };
  });
}

function _kill(id: number, dueBeforeMove: number, kind: Kill['kind'], seat: Kill['seat'], extra: Partial<Kill> = {}): Kill {
  return { id, dueBeforeMove, kind, seat, timing: 'between', downMs: 0, movesWhileDown: 2, ...extra };
}

async function _killGame(browser: Browser, seed: number, plan: Kill[], extra: { _afterKillStart?: (seat: Seat) => void } = {}) {
  const outDir = test.info().outputDir;
  const started = Date.now();
  const result = await playGame({ browser, stack, seed, size: 'short', plan, outDir, ...extra });
  console.log(`${result.moves} moves in ${((Date.now() - started) / 1000).toFixed(1)} s; ${result.kills.map(_recordLine).join('; ')}`);
  expect(result.scores.team1 + result.scores.team2).toBe(8);
  expect(result.kills.map((record) => record.kill.id).sort()).toEqual(plan.map((kill) => kill.id).sort());
  return result;
}

function _record(result: GameResult, id: number): KillRecord {
  return result.kills.find((record) => record.kill.id === id)!;
}

function _recordLine(record: KillRecord): string {
  const waited = ((record.startedAt - record.dueAt) / 1000).toFixed(1);
  return `${record.kill.kind} #${record.kill.id} back in ${record.backMs} ms, waited ${waited} s to start, ${record.movesMadeWhileDown} move(s) while down`;
}

async function _refuseRoom(route: Route) {
  if (route.request().method() !== 'POST') return route.fallback();
  // The page reads the 500 only if the response passes CORS.
  await route.fulfill({
    status: 500,
    headers: { 'access-control-allow-origin': FRONTEND_URL },
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Failed to create room' }),
  });
}

test('six guests reach a started game', async ({ browser }) => {
  const started = Date.now();
  const table = await openTable(browser, stack);
  try {
    console.log(`six seats at a started game in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    const { seats, model } = table;
    expect(seats).toHaveLength(6);
    expect(seats.map(isUp)).toEqual([true, true, true, true, true, true]);
    expect(new Set(seats.map((seat) => seat.playerId)).size).toBe(6);
    expect(seats.filter((seat) => seat.team === 1)).toHaveLength(3);
    expect(seats.filter((seat) => seat.team === 2)).toHaveLength(3);
    expect(model.history).toHaveLength(1);
    for (const seat of seats) expect(await pageProblems(seat, table.gameUrl), seat.name).toEqual([]);
    expect(await stack.standinReport()).toEqual({ unknown: [], refused: [] });

    // Freeze kills need every page visible with timers at full rate, all six at once.
    const clocks = await Promise.all(seats.map((seat) => _pageClock(seat.page)));
    console.log(`page clocks: ${clocks.map((c) => `${c.visibility} ${c.chainMs} ms`).join(', ')}`);
    expect(clocks.map((c) => c.visibility)).toEqual(Array(6).fill('visible'));
    for (const clock of clocks) expect(clock.chainMs).toBeLessThan(TIMER_CHAIN_MAX_MS);
  } finally {
    await closeTable(table);
  }
});

test('a failed room creation fails fast with the backend log', async ({ browser }) => {
  const started = Date.now();
  const outcome = await openTable(browser, stack, {
    onContext: async (context, index) => {
      if (index === 0) await context.route(`${BACKEND_URL}/api/rooms`, _refuseRoom);
    },
  }).then(
    async (table) => {
      await closeTable(table);
      return null;
    },
    (err: unknown) => err,
  );
  expect(Date.now() - started).toBeLessThan(40_000);
  expect(outcome).toBeInstanceOf(SoakFailure);
  expect((outcome as SoakFailure).message).toContain('lobby: room creation failed');
  expect((outcome as SoakFailure).message).toContain('--- backend.log ---');
});

test('a game with no kills finishes', async ({ browser }) => {
  const outDir = test.info().outputDir;
  const started = Date.now();
  const result = await playGame({ browser, stack, seed: 1, size: 'short', plan: [], outDir });
  console.log(`no-kill game: ${result.moves} moves in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  expect(result.kills).toEqual([]);
  expect(result.scores.team1 + result.scores.team2).toBe(8);
  expect(result.moves).toBeGreaterThanOrEqual(8);
  expect(result.moves).toBeLessThanOrEqual(400);

  const files = readdirSync(outDir);
  const frameFiles = [0, 1, 2, 3, 4, 5].map((n) => `frames-seat${n}.jsonl`);
  expect(files).toEqual(expect.arrayContaining(['plan.json', 'run.log', 'model.json', ...frameFiles]));
  for (const file of frameFiles) {
    const text = readFileSync(path.join(outDir, file), 'utf8');
    expect(text.length, file).toBeGreaterThan(0);
    expect(text, file).not.toContain('token=');
    expect(text, file).not.toContain('guestRecoveryKey');
  }
  expect(await stack.standinReport()).toEqual({ unknown: [], refused: [] });
});

test('cut between moves and mid-move', async ({ browser }) => {
  const result = await _killGame(browser, 2, [
    _kill(1, 3, 'cut', 2),
    _kill(2, 6, 'cut', 'mover', { timing: 'midMove', movesWhileDown: 0 }),
  ]);
  for (const record of result.kills) expect(record.backMs).toBeLessThanOrEqual(5_000);
});

test('freeze', async ({ browser }) => {
  const result = await _killGame(browser, 3, [_kill(1, 3, 'freeze', 4, { downMs: 22_000 })]);
  const freeze = _record(result, 1);
  expect(freeze.backMs).toBeLessThanOrEqual(3_000);
  expect(freeze.movesMadeWhileDown >= 1 || freeze.heldTurnThroughout).toBe(true);
  const eventAt = freeze.backAt - freeze.backMs;
  const opened = readFileSync(path.join(test.info().outputDir, 'frames-seat4.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((line) => line.opened && line.at > freeze.startedAt && line.at < eventAt);
  expect(opened, 'sockets the page opened between the freeze and the event').toEqual([]);
});

test('refuse', async ({ browser }) => {
  const result = await _killGame(browser, 4, [_kill(1, 3, 'refuse', 1, { downMs: 6_000 })]);
  const refuse = _record(result, 1);
  expect(refuse.backMs).toBeLessThanOrEqual(12_000);
  expect(refuse.movesMadeWhileDown >= 1 || refuse.heldTurnThroughout).toBe(true);
});

// Both due before move 3: if the refused seat held the turn, a kill due one move later could not come due until it was back.
test('two seats down together', async ({ browser }) => {
  const result = await _killGame(browser, 5, [
    _kill(1, 3, 'refuse', 1, { downMs: 15_000 }),
    _kill(2, 3, 'freeze', 5, { downMs: 22_000 }),
  ]);
  const [a, b] = [_record(result, 1), _record(result, 2)];
  expect(b.startedAt < a.backAt && a.startedAt < b.backAt, 'the two down intervals overlap').toBe(true);
});

test('a kill waits for its seat', async ({ browser }) => {
  const result = await _killGame(browser, 6, [
    _kill(1, 3, 'refuse', 3, { downMs: 10_000, movesWhileDown: 4 }),
    _kill(2, 3, 'cut', 3),
  ]);
  const [first, second] = [_record(result, 1), _record(result, 2)];
  expect(second.dueAt).toBeLessThan(first.backAt);
  expect(second.startedAt).toBeGreaterThanOrEqual(first.backAt);
});

test('a seat that never returns fails by name', async ({ browser }) => {
  let cutAt = 0;
  const outDir = test.info().outputDir;
  const outcome = await playGame({
    browser,
    stack,
    seed: 7,
    size: 'short',
    plan: [_kill(1, 3, 'cut', 2)],
    outDir,
    _afterKillStart: (seat) => {
      seat.wire.refusing = true;
      cutAt = Date.now();
    },
  }).then(
    () => null,
    (err: unknown) => err,
  );
  const failedAt = Date.now();
  expect(outcome).toBeInstanceOf(SoakFailure);
  console.log(`failed ${((failedAt - cutAt) / 1000).toFixed(1)} s after the cut: ${(outcome as Error).message}`);
  expect((outcome as Error).message).toMatch(/^seat 2 \(Soak 3\) not back 5 s \(took .* s so far\) after cut #1/);
  expect(cutAt).toBeGreaterThan(0);
  expect(failedAt - cutAt).toBeLessThan(15_000);
});
