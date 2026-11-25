import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

const SILENT_MS = 30_000;
const CUT = { code: 3001, reason: 'e2e cut' };

type Msg = { type: string; [key: string]: any };

interface Frame {
  at: number;
  msg: Msg;
}

interface GameSocket {
  index: number;
  openedAt: number;
  page: WebSocketRoute;
  server: WebSocketRoute | null;
  cut: boolean;
  frames: Frame[];
}

interface Wire {
  sockets: GameSocket[];
  refusing: boolean;
}

interface Connected {
  socket: GameSocket;
  me: string;
  init: Frame;
  timer: Frame;
}

declare global {
  interface Window {
    __e2e?: number;
    __bar?: { shown: boolean; at: number }[];
  }
}

async function _routeGameSocket(page: Page): Promise<Wire> {
  const wire: Wire = { sockets: [], refusing: false };
  await page.routeWebSocket(/\/ws\/game\//, (ws) => {
    const socket: GameSocket = {
      index: wire.sockets.length,
      openedAt: Date.now(),
      page: ws,
      server: null,
      cut: false,
      frames: [],
    };
    wire.sockets.push(socket);
    if (wire.refusing) {
      void ws.close({ code: 1006, reason: 'refused' });
      return;
    }
    const server = ws.connectToServer();
    socket.server = server;
    // A message handler on each side turns off auto-forwarding, so a cut can stop the traffic.
    ws.onMessage((message) => {
      if (!socket.cut) server.send(message);
    });
    server.onMessage((message) => {
      if (socket.cut) return;
      socket.frames.push({ at: Date.now(), msg: JSON.parse(String(message)) });
      ws.send(message);
    });
  });
  return wire;
}

async function _cut(socket: GameSocket, sides: 'both' | 'server') {
  socket.cut = true;
  // An onClose handler stops Playwright from forwarding a close to the other side.
  socket.page.onClose(() => {});
  socket.server!.onClose(() => {});
  await socket.server!.close(CUT);
  if (sides === 'both') await socket.page.close(CUT);
}

function _frame(socket: GameSocket, type: string, match: (msg: Msg) => boolean = () => true) {
  return socket.frames.find((frame) => frame.msg.type === type && match(frame.msg));
}

function _initedSocket(wire: Wire, fromIndex: number) {
  return wire.sockets.filter((s) => s.index >= fromIndex && !s.cut && _frame(s, 'game_init')).at(-1);
}

async function _connected(wire: Wire, fromIndex: number): Promise<Connected> {
  await expect
    .poll(() => Boolean(_initedSocket(wire, fromIndex)), { message: 'no game_init forwarded', timeout: 20_000 })
    .toBe(true);
  const socket = _initedSocket(wire, fromIndex)!;
  const init = _frame(socket, 'game_init')!;
  const me = init.msg.myPlayerId as string;
  expect(init.msg.gameState.currentTurnPlayerId, "the turn is no longer the player's").toBe(me);
  const isMine = (msg: Msg) => msg.playerId === me;
  await expect
    .poll(() => Boolean(_frame(socket, 'turn_timer', isMine)), { message: "no turn_timer for the player's turn" })
    .toBe(true);
  return { socket, me, init, timer: _frame(socket, 'turn_timer', isMine)! };
}

async function _startGame(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Private Room/ }).click();
  await page.getByPlaceholder('e.g. CardShark99').fill('E2E Host');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await page.getByRole('button', { name: 'Create Room', exact: true }).click();
  await page.getByTestId('enter-room-btn').click();
  await page.getByTestId('start-game-btn').click();
  await page.waitForURL(/\/game\//);
  await expect(page.getByTestId('desktop-card-hand')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('deal-animation')).toHaveCount(0, { timeout: 15_000 });
  await page.evaluate(() => {
    window.__e2e = 1;
    window.__bar = [];
    const isShown = () => document.querySelector('[data-testid="ws-reconnecting-banner"]') !== null;
    let shown = isShown();
    new MutationObserver(() => {
      if (isShown() === shown) return;
      shown = !shown;
      window.__bar!.push({ shown, at: Date.now() });
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.getByTestId('bot-speed-slider').fill('3000');
  await expect(page.getByTestId('bot-speed-value')).toHaveText('3s');
}

async function _mySeat(page: Page) {
  const seat = page.getByTestId('game-player-seat').filter({ has: page.getByTestId('you-pill') });
  return {
    playerId: await seat.getAttribute('data-player-id'),
    seatIndex: await seat.getAttribute('data-seat-index'),
  };
}

async function _handCardIds(page: Page) {
  const ids = await page
    .getByTestId('desktop-card-hand')
    .locator('[data-testid^="card-wrapper-"]')
    .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-testid')!.replace('card-wrapper-', '')));
  return ids.sort();
}

async function _ask(page: Page) {
  const tray = page.getByTestId('inline-ask-tray');
  for (const handCardId of await _handCardIds(page)) {
    await page.getByTestId(`card-wrapper-${handCardId}`).getByRole('button').click();
    await expect(tray).toBeVisible();
    const askable = tray.locator('[data-testid^="inline-ask-card-"]');
    if ((await askable.count()) === 0) {
      await page.getByTestId('toggle-ask').click();
      continue;
    }
    const cardId = (await askable.first().getAttribute('data-testid'))!.replace('inline-ask-card-', '');
    await askable.first().click();
    await expect(page.getByTestId('inline-ask-step-opponent')).toBeVisible();
    const target = page.locator('[data-testid="game-player-seat"][data-ask-targetable="true"]').first();
    const targetId = (await target.getAttribute('data-player-id'))!;
    const at = Date.now();
    await target.click();
    return { cardId, targetId, at };
  }
  throw new Error('the hand holds no half-suit with a missing card');
}

async function _askAndSeeResult(page: Page, socket: GameSocket, me: string): Promise<Frame> {
  const asked = await _ask(page);
  const find = () =>
    socket.frames.find(
      ({ at, msg }) =>
        at >= asked.at &&
        msg.type === 'ask_result' &&
        msg.askerId === me &&
        msg.cardId === asked.cardId &&
        msg.targetId === asked.targetId,
    );
  await expect.poll(() => Boolean(find()), { message: 'no ask_result for the ask' }).toBe(true);
  const result = find()!;
  if (result.msg.success) {
    await expect(page.getByTestId('desktop-card-hand').getByTestId(`card-wrapper-${result.msg.cardId}`)).toBeVisible();
  } else {
    await expect(page.locator(`[data-testid="game-player-seat"][data-player-id="${me}"]`)).not.toHaveAttribute(
      'data-active-turn',
      'true',
    );
  }
  return result;
}

test('socket killed mid-game', async ({ page }) => {
  const wire = await _routeGameSocket(page);
  await _startGame(page);
  const gameUrl = page.url();
  const { socket, me } = await _connected(wire, 0);
  const seat = await _mySeat(page);
  const hand = await _handCardIds(page);
  expect(seat.playerId).toBe(me);

  const attempts = wire.sockets.length;
  await _cut(socket, 'both');

  const bar = page.getByTestId('ws-reconnecting-banner');
  await expect(bar).toBeVisible();
  await expect(bar).toBeHidden({ timeout: 15_000 });
  const back = await _connected(wire, attempts);
  expect(back.me).toBe(me);
  await expect(page).toHaveURL(gameUrl);
  expect(await page.evaluate(() => window.__e2e)).toBe(1);
  expect(await _mySeat(page)).toEqual(seat);
  expect(await _handCardIds(page)).toEqual(hand);

  await _askAndSeeResult(page, back.socket, me);
});

test("30 seconds of silence on the player's turn", async ({ page }) => {
  const wire = await _routeGameSocket(page);
  await _startGame(page);
  const gameUrl = page.url();
  const { socket, me, init, timer } = await _connected(wire, 0);
  await expect
    .poll(() => Boolean(_frame(socket, 'heartbeat')), { message: 'no heartbeat frame forwarded', timeout: 5_000 })
    .toBe(true);
  const seat = await _mySeat(page);

  const turnStart = timer.msg.expiresAt - timer.msg.durationMs;
  const log = (label: string, at = Date.now()) =>
    console.log(`[turn +${((at - turnStart) / 1000).toFixed(1)} s] ${label}`);
  log('game_init forwarded', init.at);
  log("player's turn_timer forwarded", timer.at);

  const attempts = wire.sockets.length;
  const lastFrameAt = socket.frames.at(-1)!.at;
  const cutAt = Date.now();
  log('last frame forwarded before the cut', lastFrameAt);
  // The silence deadline counts from the page's last message, so a stale one moves it earlier.
  expect(cutAt - lastFrameAt, 'frames stopped flowing before the cut').toBeLessThan(1_500);
  wire.refusing = true;
  await _cut(socket, 'server');
  log('server side closed, page side left open', cutAt);

  await page.waitForTimeout(SILENT_MS);
  expect(wire.sockets.length, 'a game socket was attempted during the silence').toBe(attempts);
  log('30 s of silence over, no new game socket attempted');

  wire.refusing = false;
  const visibleAt = Date.now();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  log('visibilitychange dispatched', visibleAt);
  await expect
    .poll(() => wire.sockets.length, { message: 'no game socket after the visibility change', timeout: 2_000 })
    .toBeGreaterThan(attempts);
  const retriedAt = wire.sockets[attempts].openedAt;
  log(`new game socket attempted, ${retriedAt - visibleAt} ms after the visibility change`, retriedAt);
  expect(retriedAt - visibleAt).toBeGreaterThanOrEqual(0);
  expect(retriedAt - visibleAt).toBeLessThan(2_000);

  const back = await _connected(wire, attempts);
  log('game_init on the new socket', back.init.at);
  expect(back.me).toBe(me);
  expect(back.timer.msg.expiresAt).toBe(timer.msg.expiresAt);
  expect(back.init.msg.players.find((p: Msg) => p.playerId === me).isBot).toBe(false);
  expect(back.init.msg.askHistory.filter((a: Msg) => a.askerId === me)).toEqual([]);

  await expect(page.getByTestId('ws-reconnecting-banner')).toBeHidden();
  const bar = (await page.evaluate(() => window.__bar))!.filter((change) => change.at >= visibleAt);
  expect(bar.map((change) => change.shown)).toEqual([true, false]);
  await expect(page).toHaveURL(gameUrl);
  expect(await page.evaluate(() => window.__e2e)).toBe(1);
  expect(await _mySeat(page)).toEqual(seat);
  log('bar shown and cleared, no navigation, same seat');

  const own = await _askAndSeeResult(page, back.socket, me);
  log(`own ask_result (success: ${own.msg.success})`, own.at);
  const seatMoves = wire.sockets
    .flatMap((s) => s.frames)
    .filter(
      ({ msg }) =>
        (msg.type === 'ask_result' && msg.askerId === me) ||
        (msg.type === 'declaration_result' && msg.declarerId === me),
    );
  expect(seatMoves[0], "the seat's first move is the player's own ask").toBe(own);
  log("no move for the seat before the player's own ask");
});
