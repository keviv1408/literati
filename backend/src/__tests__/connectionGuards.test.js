/**
 * Connection-handler guards (real ws clients against the attached game socket
 * server, with Supabase calls deferred so a test controls when each await in
 * the handler returns):
 *
 * 1. A socket that closes while the handler awaits auth never evicts the live
 *    socket that holds the seat.
 * 2. A socket that closes while the handler persists a seat reclaim is never
 *    registered, and the seat gets a hold.
 * 3. Two connections recovering the same game at once end with one game object.
 * 4. A failed room read closes with 4500; a missing room with 4004.
 */

const http      = require('http');
const express   = require('express');
const WebSocket = require('ws');

const ROOM_CODE = 'GUARDS';
const ROOM_ID   = 'room-id-guards';
const P1_KEY    = 'recovery-key-alice';
const P2_KEY    = 'recovery-key-bob';

function buildSupabaseMock() {
  const chain = {};
  const auth  = {};
  const mock  = { from: jest.fn(), auth, rpc: jest.fn() };
  mock.reset = () => {
    for (const name of ['select', 'eq', 'update', 'upsert', 'insert']) {
      chain[name] = jest.fn().mockReturnValue(chain);
    }
    chain.maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
    auth.getUser = jest.fn().mockResolvedValue({ data: { user: null }, error: 'no-user' });
    mock.from.mockReset().mockReturnValue(chain);
    mock.rpc.mockReset().mockResolvedValue({ data: null, error: null });
  };
  mock.chain = chain;
  mock.reset();
  return mock;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error('condition not met');
}

describe('connection-handler guards', () => {
  let httpServer;
  let port;
  let supabaseMock;
  let gameSocketServer;
  let gameStore;
  let guestSessionStore;
  let setGameSpy;
  let persistGameState;
  let gs;
  let p1Token, p1Id, p2Token, p2Id;
  const openSockets = [];

  beforeAll((done) => {
    jest.resetModules();
    supabaseMock = buildSupabaseMock();
    const { _setSupabaseClient } = require('../db/supabase');
    _setSupabaseClient(supabaseMock);

    guestSessionStore = require('../sessions/guestSessionStore');
    const sess1 = guestSessionStore.createGuestSession('Alice');
    p1Token = sess1.token;
    p1Id    = sess1.session.sessionId;
    const sess2 = guestSessionStore.createGuestSession('Bob');
    p2Token = sess2.token;
    p2Id    = sess2.session.sessionId;

    gameStore  = require('../game/gameStore');
    // The server destructures setGame when it is required, so spy first.
    setGameSpy = jest.spyOn(gameStore, 'setGame');
    gameSocketServer = require('../game/gameSocketServer');
    ({ persistGameState } = require('../game/gameState'));

    gs = gameSocketServer.createGame({
      roomCode:    ROOM_CODE,
      roomId:      ROOM_ID,
      variant:     'remove_7s',
      playerCount: 6,
      seats: [
        { seatIndex: 0, playerId: p1Id,    displayName: 'Alice', avatarId: null, teamId: 1, isBot: false, isGuest: true, guestRecoveryKey: P1_KEY },
        { seatIndex: 1, playerId: p2Id,    displayName: 'Bob',   avatarId: null, teamId: 2, isBot: false, isGuest: true, guestRecoveryKey: P2_KEY },
        { seatIndex: 2, playerId: 'bot-1', displayName: 'Bot1',  avatarId: null, teamId: 1, isBot: true,  isGuest: false },
        { seatIndex: 3, playerId: 'bot-2', displayName: 'Bot2',  avatarId: null, teamId: 2, isBot: true,  isGuest: false },
        { seatIndex: 4, playerId: 'bot-3', displayName: 'Bot3',  avatarId: null, teamId: 1, isBot: true,  isGuest: false },
        { seatIndex: 5, playerId: 'bot-4', displayName: 'Bot4',  avatarId: null, teamId: 2, isBot: true,  isGuest: false },
      ],
    });

    const app = express();
    httpServer = http.createServer(app);
    gameSocketServer.attachGameSocketServer(httpServer);
    httpServer.listen(0, () => {
      port = httpServer.address().port;
      done();
    });
  });

  beforeEach(() => {
    supabaseMock.reset();
    gs.hands.set(p1Id,    new Set(['1_s', '2_s', '3_s']));
    gs.hands.set(p2Id,    new Set(['4_s', '5_s', '6_s']));
    gs.hands.set('bot-1', new Set(['1_h', '2_h', '3_h']));
    gs.hands.set('bot-2', new Set(['4_h', '5_h', '6_h']));
    gs.hands.set('bot-3', new Set(['1_d', '2_d', '3_d']));
    gs.hands.set('bot-4', new Set(['4_d', '5_d', '6_d']));
    gs.currentTurnPlayerId = p2Id;
    gs.status = 'active';
    for (const pid of [p1Id, p2Id]) {
      const p = gs.players.find((x) => x.playerId === pid);
      p.isBot = false;
      delete p.botReplacedAt;
    }
    gameStore.setGame(ROOM_CODE, gs);
    gameSocketServer.cancelTurnTimer(ROOM_CODE);
    gameSocketServer.cancelBotTimer(ROOM_CODE);
    gameSocketServer._clearAllReconnectWindows();
    gameSocketServer._clearAllSeatHolds();
  });

  afterEach(async () => {
    for (const ws of openSockets.splice(0)) {
      try { ws.close(); } catch { /* already closed */ }
    }
    await sleep(50);
    gameSocketServer.cancelTurnTimer(ROOM_CODE);
    gameSocketServer.cancelBotTimer(ROOM_CODE);
  });

  afterAll((done) => {
    gameSocketServer.cancelTurnTimer(ROOM_CODE);
    gameSocketServer.cancelBotTimer(ROOM_CODE);
    gameSocketServer._clearAllReconnectWindows();
    gameSocketServer._clearAllSeatHolds();
    setGameSpy.mockRestore();
    gameStore._clearAll();
    guestSessionStore._clearStore();
    httpServer.close(done);
    jest.resetModules();
  });

  /** Open a socket and resolve once it is open, recording every frame except heartbeats. */
  function connect(query) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws/game/${ROOM_CODE}?${query}`);
      const messages = [];
      const closed = new Promise((r) => ws.on('close', (code) => r(code)));
      openSockets.push(ws);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== 'heartbeat') messages.push(msg);
      });
      ws.on('error', reject);
      ws.on('open', () => resolve({ ws, messages, closed }));
    });
  }

  const player = (pid) => gs.players.find((p) => p.playerId === pid);

  test('a socket that closes during auth never evicts the live socket', async () => {
    const b = await connect(`token=${p1Token}`);
    await waitFor(() => b.messages.some((m) => m.type === 'game_init'));
    const bServerSocket = gameStore.getConnection(ROOM_CODE, p1Id);
    expect(bServerSocket).toBeDefined();

    const auth = deferred();
    supabaseMock.auth.getUser.mockImplementationOnce(() => auth.promise);
    const late = await connect(`token=bogus&guestRecoveryKey=${P1_KEY}`);
    await waitFor(() => supabaseMock.auth.getUser.mock.calls.length === 1);

    late.ws.close();
    await late.closed;
    await sleep(50);
    auth.resolve({ data: { user: null }, error: 'no-user' });
    await sleep(100);

    expect(gameStore.getConnection(ROOM_CODE, p1Id) === bServerSocket).toBe(true);
    expect(b.messages.some((m) => m.type === 'closing')).toBe(false);
  });

  test('a socket that closes while a seat reclaim persists is not registered, and the seat is held', async () => {
    gameSocketServer._startReconnectWindow(gs, player(p1Id));
    expect(gameSocketServer._reconnectWindows.has(p1Id)).toBe(true);

    const persist = deferred();
    let eqCalled = false;
    supabaseMock.chain.update.mockImplementationOnce(() => ({
      eq: () => { eqCalled = true; return persist.promise; },
    }));
    const conn = await connect(`token=${p1Token}`);
    await waitFor(() => eqCalled);

    conn.ws.close();
    await conn.closed;
    await sleep(50);
    persist.resolve({ data: null, error: null });
    await sleep(100);

    expect(gameStore.getConnection(ROOM_CODE, p1Id) === undefined).toBe(true);
    expect(gameSocketServer._seatHolds.has(`${ROOM_CODE}:${p1Id}`)).toBe(true);
  });

  test('two connections recovering the game at once end with one game object', async () => {
    await persistGameState(gs, supabaseMock);
    const snapshot = supabaseMock.chain.update.mock.calls[0][0].game_state;
    gameStore.deleteGame(ROOM_CODE);

    const read = deferred();
    supabaseMock.chain.maybeSingle
      .mockImplementationOnce(() => read.promise)
      .mockImplementationOnce(() => read.promise);
    setGameSpy.mockClear();

    const a = await connect(`token=${p1Token}`);
    const b = await connect(`token=${p2Token}`);
    await waitFor(() => supabaseMock.chain.maybeSingle.mock.calls.length === 2);

    read.resolve({
      data:  { id: ROOM_ID, status: 'in_progress', game_state: snapshot },
      error: null,
    });
    await waitFor(() => (
      a.messages.some((m) => m.type === 'game_init') &&
      b.messages.some((m) => m.type === 'game_init')
    ));

    expect(setGameSpy).toHaveBeenCalledTimes(1);
  });

  test('a failed room read closes with 4500', async () => {
    gameStore.deleteGame(ROOM_CODE);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    supabaseMock.chain.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'x' } });

    const conn = await connect(`token=${p1Token}`);
    await conn.closed;
    errorSpy.mockRestore();

    expect(conn.messages).toContainEqual(expect.objectContaining({ type: 'closing', code: 4500 }));
  });

  test('a read that finds no room closes with 4004', async () => {
    gameStore.deleteGame(ROOM_CODE);
    supabaseMock.chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const conn = await connect(`token=${p1Token}`);
    await conn.closed;

    expect(conn.messages).toContainEqual(expect.objectContaining({ type: 'closing', code: 4004 }));
  });
});
