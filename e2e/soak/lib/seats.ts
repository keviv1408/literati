import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { findFrame, routeGameSocket, type GameSocket, type Msg, type Wire } from '../../tests/helpers/gameWire';
import { installPageObserver } from './checks';
import { failure } from './fail';
import { BACKEND_URL, FIRST_SAVE_MS, FRONTEND_URL, LOBBY_WAIT_MS, LOG_TAIL_LINES } from './limits';
import { Model, type Team } from './model';
import type { Stack } from './stack';

export interface Seat {
  index: number;
  name: string;
  context: BrowserContext;
  page: Page;
  wire: Wire;
  playerId: string;
  seatIndex: number;
  team: Team;
  read: Map<GameSocket, number>;
  loads: number;
  authCalls: string[];
}

export interface Table {
  seats: Seat[];
  roomCode: string;
  gameUrl: string;
  model: Model;
}

type _Draft = Omit<Seat, 'playerId' | 'seatIndex' | 'team'>;

const _SEATS = 6;
const _AUTH_PATHS = ['/api/auth/guest', '/api/auth/me'];

export async function openTable(
  browser: Browser,
  stack: Stack,
  opts: {
    onContext?: (context: BrowserContext, index: number) => Promise<void>;
    onFail?: (seats: Pick<Seat, 'index' | 'wire'>[]) => void;
  } = {},
): Promise<Table> {
  const contexts: BrowserContext[] = [];
  const drafts: _Draft[] = [];
  try {
    for (let index = 0; index < _SEATS; index++) {
      const context = await browser.newContext();
      contexts.push(context);
      context.setDefaultTimeout(LOBBY_WAIT_MS);
      await opts.onContext?.(context, index);
      const page = await context.newPage();
      const wire = await routeGameSocket(page);
      const name = `Soak ${index + 1}`;
      const draft: _Draft = { index, name, context, page, wire, read: new Map(), loads: 0, authCalls: [] };
      page.on('request', (request) => {
        if (!wire.sockets.some((socket) => findFrame(socket, 'game_init'))) return;
        const { pathname } = new URL(request.url());
        if (_AUTH_PATHS.includes(pathname)) draft.authCalls.push(`${request.method()} ${pathname}`);
      });
      drafts.push(draft);
    }

    const roomCode = await _host(drafts[0], stack);
    const roomUrl = `${FRONTEND_URL}/room/${roomCode}`;
    for (const draft of drafts.slice(1)) await _join(draft, roomUrl, stack);
    await _step(stack, 'six players in the lobby', () =>
      Promise.all(
        drafts.map((draft) =>
          expect(draft.page.getByTestId('lobby-player-count'), draft.name).toHaveText(/^6\//, { timeout: LOBBY_WAIT_MS }),
        ),
      ),
    );

    const gameUrl = `${FRONTEND_URL}/game/${roomCode}`;
    await _step(stack, 'start', async () => {
      const start = drafts[0].page.getByTestId('start-game-btn');
      await expect(start).toBeEnabled({ timeout: LOBBY_WAIT_MS });
      await start.click();
    });
    await Promise.all(drafts.map((draft) => _reachGame(draft, gameUrl, stack)));

    const inits = await _step(stack, 'the deal', async () =>
      drafts.map((draft) => {
        const init = _firstInit(draft);
        if (!init) throw new Error(`${draft.name} has no game_init`);
        return init;
      }),
    );
    const model = Model.fromInits(inits);
    const seats = drafts.map((draft, i) => _seat(draft, inits[i]));

    await _step(stack, 'the first save', async () => {
      let status: string | null = null;
      const poll = async () => (status = await _roomStatus(roomCode));
      await expect.poll(poll, { timeout: FIRST_SAVE_MS }).toBe('in_progress').catch(() => {
        throw new Error(`room status ${status}, not in_progress, after ${FIRST_SAVE_MS / 1000} s`);
      });
    });
    return { seats, roomCode, gameUrl, model };
  } catch (err) {
    // The deal and the first save fail after the game sockets opened, and their frames show why.
    opts.onFail?.(drafts);
    await Promise.all(contexts.map((context) => context.close().catch(() => {})));
    throw err;
  }
}

export function liveSocket(seat: Pick<Seat, 'wire'>): GameSocket | undefined {
  const socket = seat.wire.sockets.at(-1);
  if (!socket || socket.cut || socket.closed !== null || !findFrame(socket, 'game_init')) return undefined;
  return socket;
}

export function isUp(seat: Pick<Seat, 'wire'>): boolean {
  return liveSocket(seat) !== undefined;
}

export function nameOf(table: Pick<Table, 'seats'>, playerId: string): string {
  return table.seats.find((seat) => seat.playerId === playerId)?.name ?? playerId;
}

export async function closeTable(table: Table): Promise<void> {
  await Promise.all(table.seats.map((seat) => seat.context.close()));
}

async function _host(draft: _Draft, stack: Stack): Promise<string> {
  const { page } = draft;
  await _step(stack, `${draft.name}: home page`, async () => {
    await page.goto(FRONTEND_URL);
    await page.getByRole('button', { name: /Private Room/ }).click();
    await page.getByPlaceholder('e.g. CardShark99').fill(draft.name);
    await page.getByRole('button', { name: 'Continue as Guest' }).click();
    await page.getByRole('button', { name: 'Create Room', exact: true }).click();
  });
  await _step(stack, 'room creation', async () => {
    const lobby = page.getByTestId('start-game-panel');
    const refusal = page.getByRole('dialog').getByRole('alert');
    await expect(lobby.or(refusal).first()).toBeVisible({ timeout: LOBBY_WAIT_MS });
    if (await refusal.isVisible()) throw new Error(`the page says "${await refusal.innerText()}"`);
  });
  return _step(stack, `${draft.name}: lobby`, async () => {
    await page.waitForURL(/\/room\/[^/?#]+$/);
    await expect(page.getByTestId('lobby-player-count')).toHaveText(/^1\//, { timeout: LOBBY_WAIT_MS });
    return new URL(page.url()).pathname.split('/').at(-1)!;
  });
}

async function _join(draft: _Draft, roomUrl: string, stack: Stack): Promise<void> {
  const { page } = draft;
  await _step(stack, `${draft.name}: join`, async () => {
    await page.goto(roomUrl);
    await page.getByTestId('join-name-input').fill(draft.name);
    await page.getByTestId('join-room-btn').click();
    await expect(page.getByTestId('lobby-player-count')).toBeVisible({ timeout: LOBBY_WAIT_MS });
  });
}

async function _reachGame(draft: _Draft, gameUrl: string, stack: Stack): Promise<void> {
  const { page } = draft;
  await _step(stack, `${draft.name}: game page`, async () => {
    await page.waitForURL(gameUrl);
    await page.evaluate(() => {
      window.__e2e = 1;
    });
    await installPageObserver(page);
    page.on('load', () => draft.loads++);
    await expect
      .poll(() => isUp(draft), { message: 'no game_init on a live socket', timeout: LOBBY_WAIT_MS })
      .toBe(true);
    await expect(page.getByTestId('desktop-card-hand')).toBeVisible({ timeout: LOBBY_WAIT_MS });
    await expect(page.getByTestId('deal-animation')).toHaveCount(0, { timeout: LOBBY_WAIT_MS });
  });
}

function _firstInit(draft: _Draft): Msg | undefined {
  return draft.wire.sockets.map((socket) => findFrame(socket, 'game_init')).find((frame) => frame)?.msg;
}

function _seat(draft: _Draft, init: Msg): Seat {
  const me = init.players.find((p: Msg) => p.playerId === init.myPlayerId);
  // The same object, so the load and request listeners keep counting into the seat.
  return Object.assign(draft, {
    playerId: init.myPlayerId as string,
    seatIndex: me.seatIndex as number,
    team: me.teamId as Team,
  });
}

async function _roomStatus(roomCode: string): Promise<string | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/rooms/${roomCode}`);
    const body = await res.json();
    return body.room?.status ?? null;
  } catch {
    return null;
  }
}

async function _step<T>(stack: Stack, step: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const reason = String(err instanceof Error ? err.message : err)
      .replace(/\x1b\[[0-9;]*m/g, '')
      .split('\n')[0];
    throw failure(`lobby: ${step} failed: ${reason}\n${stack.backendLogTail(LOG_TAIL_LINES)}`);
  }
}
