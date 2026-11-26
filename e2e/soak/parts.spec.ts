import { expect, test, type Page, type Route } from '@playwright/test';
import { pageProblems } from './lib/checks';
import { SoakFailure } from './lib/fail';
import { BACKEND_URL, FRONTEND_URL, TIMER_CHAIN_MAX_MS } from './lib/limits';
import { closeTable, isUp, openTable } from './lib/seats';
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
