import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

interface RoomSocket {
  page: WebSocketRoute;
  server: WebSocketRoute;
  frozen: boolean;
  types: string[];
}

async function _routeRoomSocket(page: Page): Promise<RoomSocket[]> {
  const sockets: RoomSocket[] = [];
  await page.routeWebSocket(/\/ws\/room\//, (ws) => {
    const server = ws.connectToServer();
    const socket: RoomSocket = { page: ws, server, frozen: false, types: [] };
    sockets.push(socket);
    // A message handler on each side turns off auto-forwarding, so a freeze can stop the traffic.
    ws.onMessage((message) => {
      if (!socket.frozen) server.send(message);
    });
    server.onMessage((message) => {
      if (socket.frozen) return;
      socket.types.push(JSON.parse(String(message)).type);
      ws.send(message);
    });
  });
  return sockets;
}

// What a phone does when it switches apps: the server sees the socket close, the page never does.
async function _freeze(socket: RoomSocket) {
  socket.frozen = true;
  // An onClose handler stops Playwright from forwarding a close to the other side.
  socket.page.onClose(() => {});
  socket.server.onClose(() => {});
  await socket.server.close({ code: 3001, reason: 'e2e freeze' });
}

test('a host whose lobby socket froze sees a guest who joined meanwhile', async ({ page, browser }) => {
  const sockets = await _routeRoomSocket(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Private Room/ }).click();
  await page.getByPlaceholder('e.g. CardShark99').fill('E2E Host');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await page.getByRole('button', { name: 'Create Room', exact: true }).click();
  const hostCount = page.getByTestId('lobby-player-count');
  await expect(hostCount).toHaveText(/^1\//, { timeout: 30_000 });
  await expect
    .poll(() => sockets[0]?.types.includes('heartbeat') ?? false, { message: 'no heartbeat on the lobby socket' })
    .toBe(true);
  let loads = 0;
  page.on('load', () => loads++);
  // Load the guest's page first, so the join lands well inside the host's 35 s silence window.
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(page.url());
  await guest.getByTestId('join-name-input').fill('E2E Guest');

  await _freeze(sockets[0]);
  await guest.getByTestId('join-room-btn').click();
  const guestCount = guest.getByTestId('lobby-player-count');
  // The split: the server dropped the host, and the host's page has not noticed yet.
  await expect(guestCount).toHaveText(/^1\//, { timeout: 30_000 });
  await expect(hostCount).toHaveText(/^1\//);

  await expect(hostCount).toHaveText(/^2\//, { timeout: 45_000 });
  await expect(guestCount).toHaveText(/^2\//);
  expect(sockets.length, 'the host page opened no new lobby socket').toBeGreaterThan(1);
  expect(loads, 'the host page reloaded').toBe(0);
  await guestContext.close();
});
