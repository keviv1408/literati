import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

const API_URL = 'http://localhost:3012';
const CUT = { code: 3001, reason: 'e2e cut' };

type Msg = { type: string; [key: string]: any };

interface Frame {
  at: number;
  msg: Msg;
}

interface RoomSocket {
  index: number;
  page: WebSocketRoute;
  server: WebSocketRoute;
  cut: boolean;
  frames: Frame[];
}

declare global {
  interface Window {
    __e2e?: number;
    __errorShownAt?: number[];
  }
}

async function _routeRoomSocket(page: Page): Promise<RoomSocket[]> {
  const sockets: RoomSocket[] = [];
  await page.routeWebSocket(/\/ws\/room\//, (ws) => {
    const server = ws.connectToServer();
    const socket: RoomSocket = { index: sockets.length, page: ws, server, cut: false, frames: [] };
    sockets.push(socket);
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
  return sockets;
}

async function _cut(socket: RoomSocket) {
  socket.cut = true;
  // An onClose handler stops Playwright from forwarding a close to the other side.
  socket.page.onClose(() => {});
  socket.server.onClose(() => {});
  await socket.server.close(CUT);
  await socket.page.close(CUT);
}

function _frames(socket: RoomSocket, type: string) {
  return socket.frames.filter((frame) => frame.msg.type === type);
}

function _recoveredSocket(sockets: RoomSocket[], fromIndex: number) {
  return sockets
    .filter((s) => s.index >= fromIndex && _frames(s, 'connected').length > 0 && _frames(s, 'room_players').length > 0)
    .at(-1);
}

test('a host whose session the server forgot comes back as the same player', async ({ page }) => {
  const sockets = await _routeRoomSocket(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Private Room/ }).click();
  await page.getByPlaceholder('e.g. CardShark99').fill('E2E Host');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await page.getByRole('button', { name: 'Create Room', exact: true }).click();
  await expect(page.getByTestId('lobby-player-count')).toHaveText(/^1\//, { timeout: 30_000 });
  await expect
    .poll(() => (sockets[0] ? _frames(sockets[0], 'connected').length : 0), { message: 'no connected frame' })
    .toBeGreaterThan(0);
  const userId = _frames(sockets[0], 'connected')[0].msg.userId as string;
  expect(userId).toBeTruthy();
  const roomUrl = page.url();

  let loads = 0;
  page.on('load', () => loads++);
  await page.evaluate(() => {
    window.__e2e = 1;
    window.__errorShownAt = [];
    const id = 'connection-error-screen';
    const selector = `[data-testid="${id}"]`;
    // React reuses the page's root div and swaps its data-testid, and a screen can come and
    // go before the callback runs, so read the records rather than the live DOM.
    new MutationObserver((records) => {
      const shown = records.some((record) =>
        record.type === 'attributes'
          ? record.oldValue === id || (record.target as Element).getAttribute('data-testid') === id
          : Array.from(record.addedNodes).some(
              (node) => node instanceof Element && (node.matches(selector) || node.querySelector(selector) !== null),
            ),
      );
      if (shown) window.__errorShownAt!.push(Date.now());
    }).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-testid'],
      attributeOldValue: true,
    });
  });

  // The token stays in the page: Playwright's request log would record the Authorization header.
  const forgottenStatus = await page.evaluate(async (api) => {
    const { token } = JSON.parse(localStorage.getItem('literati_backend_token')!);
    const res = await fetch(`${api}/api/auth/guest`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.status;
  }, API_URL);
  expect(forgottenStatus >= 200 && forgottenStatus < 300, `DELETE /api/auth/guest returned ${forgottenStatus}`).toBe(true);

  const attempts = sockets.length;
  const reregistered = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url() === `${API_URL}/api/auth/guest`,
    { timeout: 30_000 },
  );
  await _cut(sockets[attempts - 1]);
  await reregistered;

  await expect
    .poll(() => Boolean(_recoveredSocket(sockets, attempts)), {
      message: 'no later lobby socket got connected and room_players',
      timeout: 30_000,
    })
    .toBe(true);
  const back = _recoveredSocket(sockets, attempts)!;
  const connected = _frames(back, 'connected').at(-1)!;
  expect(connected.msg.userId, 'the player came back with a new id').toBe(userId);
  const refusals = sockets
    .filter((s) => s.index >= attempts)
    .flatMap((s) => _frames(s, 'closing'))
    .filter((frame) => frame.msg.code === 4001 && frame.at < connected.at);
  expect(refusals.length, 'the server never refused the forgotten token with 4001').toBeGreaterThan(0);
  await expect(page.getByTestId('lobby-player-count')).toHaveText(/^1\//);
  await expect(page.getByTestId('host-kick-panel'), 'the host controls did not come back').toBeVisible();
  await expect(page.getByTestId('start-game-btn'), 'the Start button did not come back').toBeVisible();
  const players = _frames(back, 'room_players').at(-1)!.msg.players as Msg[];
  expect(players.find((p) => p.userId === userId)?.isHost, 'the player is not the host').toBe(true);
  expect(
    players.filter((p) => p.isHost).map((p) => p.userId),
    'someone else is flagged host',
  ).toEqual([userId]);

  expect(await page.evaluate(() => window.__errorShownAt), 'the page showed the connection error screen').toEqual([]);
  await expect(page).toHaveURL(roomUrl);
  expect(await page.evaluate(() => window.__e2e), 'the page reloaded').toBe(1);
  expect(loads, 'the page reloaded').toBe(0);
});

test('only the host sees Start and starting brings a practicing guest into the game', async ({ page, browser }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Private Room/ }).click();
  await page.getByPlaceholder('e.g. CardShark99').fill('E2E Host');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await page.getByRole('button', { name: 'Create Room', exact: true }).click();
  await expect(page.getByTestId('lobby-player-count')).toHaveText(/^1\//, { timeout: 30_000 });

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(page.url());
  await guest.getByTestId('join-name-input').fill('E2E Guest');
  await guest.getByTestId('join-room-btn').click();
  await expect(page.getByTestId('lobby-player-count')).toHaveText(/^2\//, { timeout: 30_000 });
  await expect(guest.getByTestId('lobby-player-count')).toHaveText(/^2\//, { timeout: 30_000 });

  const start = page.getByTestId('start-game-btn');
  await expect(start).toHaveText('Start with 4 bots');
  await expect(start).toBeEnabled();
  // The guest can see "Waiting for a host…" for a moment if the host's socket is reconnecting.
  await expect(guest.getByTestId('waiting-for-host')).toHaveText('Waiting for E2E Host to start the game');
  await expect(guest.getByTestId('start-game-btn')).toHaveCount(0);

  const roomUrl = guest.url();
  await guest.getByRole('button', { name: /Start a short tutorial to learn the basics/ }).click();
  const welcome = guest.getByRole('dialog', { name: 'Literature: a game of memory and fun' });
  await expect(welcome.getByRole('button', { name: 'Try an ask' })).toBeFocused();
  await expect(welcome.getByText('Win the most sets.', { exact: true })).toBeVisible();
  await expect(welcome.getByRole('button')).toHaveCount(2);
  await welcome.getByRole('button', { name: 'Try an ask' }).click();
  const practice = guest.getByRole('dialog', { name: 'Practice hand' });
  await expect(practice.getByTestId('circular-game-table')).toBeVisible();
  await expect(practice.getByText('Your A♦ lets you ask for a low diamond. Tap it.')).toBeFocused();
  await practice.getByRole('button', { name: 'A of Diamonds', exact: true }).click({ position: { x: 6, y: 12 } });
  await practice.getByTestId('inline-ask-card-6_d').click();
  await practice.getByRole('button', { name: /Maya, ask target/ }).click();
  await expect(practice.getByTestId('last-move-display')).toContainText('You asked Maya for 6♦');
  await expect(guest).toHaveURL(roomUrl);
  await expect(start).toHaveText('Start with 4 bots');
  await start.click();
  await expect(page).toHaveURL(/\/game\//, { timeout: 30_000 });
  await expect(guest).toHaveURL(/\/game\//, { timeout: 30_000 });
  await guestContext.close();
});
