/**
 * Reconnect behaviour at the WebSocket layer (real ws clients against the
 * attached game socket server):
 *
 * 1. A second socket for the same player supersedes the first (4006) and the
 *    stale socket's close must not remove the live one or bot-flag the seat.
 * 2. Connecting resumes a live turn timer instead of restarting it.
 * 3. An eliminated player who reconnects after the window gets the seat back
 *    immediately (a turn-boundary reclaim would never fire for them).
 */

const http      = require('http');
const express   = require('express');
const WebSocket = require('ws');

const ROOM_CODE = 'RECONN';

function buildSupabaseMock() {
  const chain = {};
  chain.select      = jest.fn().mockReturnValue(chain);
  chain.eq          = jest.fn().mockReturnValue(chain);
  chain.update      = jest.fn().mockReturnValue(chain);
  chain.upsert      = jest.fn().mockReturnValue(chain);
  chain.insert      = jest.fn().mockReturnValue(chain);
  chain.maybeSingle = jest.fn().mockResolvedValue({
    data:  { id: 'room-id-reconn', code: ROOM_CODE, status: 'in_progress' },
    error: null,
  });
  return {
    from: jest.fn().mockReturnValue(chain),
    auth: { getUser: jest.fn().mockResolvedValue({ data: { user: null }, error: 'no-user' }) },
    rpc:  jest.fn().mockResolvedValue({ data: null, error: null }),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('reconnect sockets', () => {
  let httpServer;
  let port;
  let gameSocketServer;
  let gameStore;
  let guestSessionStore;
  let gs;
  let p1Token, p1Id, p2Token, p2Id;
  const openSockets = [];

  beforeAll((done) => {
    jest.resetModules();
    const { _setSupabaseClient } = require('../db/supabase');
    _setSupabaseClient(buildSupabaseMock());

    guestSessionStore = require('../sessions/guestSessionStore');
    const sess1 = guestSessionStore.createGuestSession('Alice');
    p1Token = sess1.token;
    p1Id    = sess1.session.sessionId;
    const sess2 = guestSessionStore.createGuestSession('Bob');
    p2Token = sess2.token;
    p2Id    = sess2.session.sessionId;

    gameSocketServer = require('../game/gameSocketServer');
    gameStore        = require('../game/gameStore');

    gs = gameSocketServer.createGame({
      roomCode:    ROOM_CODE,
      roomId:      'room-id-reconn',
      variant:     'remove_7s',
      playerCount: 6,
      seats: [
        { seatIndex: 0, playerId: p1Id,    displayName: 'Alice', avatarId: null, teamId: 1, isBot: false, isGuest: true  },
        { seatIndex: 1, playerId: p2Id,    displayName: 'Bob',   avatarId: null, teamId: 2, isBot: false, isGuest: true  },
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
    gs.hands.set(p1Id,    new Set(['1_s', '2_s', '3_s']));
    gs.hands.set(p2Id,    new Set(['4_s', '5_s', '6_s']));
    gs.hands.set('bot-1', new Set(['1_h', '2_h', '3_h']));
    gs.hands.set('bot-2', new Set(['4_h', '5_h', '6_h']));
    gs.hands.set('bot-3', new Set(['1_d', '2_d', '3_d']));
    gs.hands.set('bot-4', new Set(['4_d', '5_d', '6_d']));
    gs.currentTurnPlayerId = p1Id;
    gs.status = 'active';
    for (const pid of [p1Id, p2Id]) {
      const p = gs.players.find((x) => x.playerId === pid);
      p.isBot = false;
      delete p.botReplacedAt;
    }
    gameSocketServer.cancelTurnTimer(ROOM_CODE);
    gameSocketServer.cancelBotTimer(ROOM_CODE);
    gameSocketServer._clearAllReconnectWindows();
  });

  afterEach(async () => {
    for (const ws of openSockets.splice(0)) {
      try { ws.close(); } catch { /* already closed */ }
    }
    await sleep(50);
  });

  afterAll((done) => {
    gameSocketServer.cancelTurnTimer(ROOM_CODE);
    gameSocketServer._clearAllReconnectWindows();
    gameStore._clearAll();
    guestSessionStore._clearStore();
    httpServer.close(done);
    jest.resetModules();
  });

  /** Open a player socket, recording every frame, and resolve once game_init arrives. */
  function openPlayer(token) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws/game/${ROOM_CODE}?token=${token}`);
      const messages = [];
      const closed = new Promise((r) => ws.on('close', (code) => r(code)));
      openSockets.push(ws);
      const timer = setTimeout(() => reject(new Error('no game_init')), 5000);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        messages.push(msg);
        if (msg.type === 'game_init') {
          clearTimeout(timer);
          resolve({ ws, messages, closed });
        }
      });
      ws.on('error', reject);
    });
  }

  const player = (pid) => gs.players.find((p) => p.playerId === pid);

  test('a second socket for the same player supersedes the first without bot-flagging the seat', async () => {
    const first  = await openPlayer(p1Token);
    const second = await openPlayer(p1Token);

    expect(await first.closed).toBe(4006);
    await sleep(100); // let the stale socket's server-side close handler run

    expect(player(p1Id).isBot).toBe(false);
    expect(gameSocketServer._reconnectWindows.has(p1Id)).toBe(false);
    expect(gameStore.getConnection(ROOM_CODE, p1Id)).toBeDefined();
    expect(second.messages.some((m) => m.type === 'player_disconnected')).toBe(false);
    expect(second.ws.readyState).toBe(WebSocket.OPEN);
  });

  test('connecting resumes the live turn timer instead of restarting it', async () => {
    await openPlayer(p1Token); // p1's turn: starts the 60 s human turn timer
    const { expiresAt } = gameSocketServer._turnTimers.get(ROOM_CODE);

    await sleep(50);
    const p2 = await openPlayer(p2Token);
    await sleep(100);

    expect(gameSocketServer._turnTimers.get(ROOM_CODE).expiresAt).toBe(expiresAt);
    const resent = p2.messages.find((m) => m.type === 'turn_timer');
    expect(resent).toMatchObject({ playerId: p1Id, expiresAt });
  });

  test('an eliminated player reconnecting after the window reclaims the seat immediately', async () => {
    const p2 = player(p2Id);
    p2.isBot = true;
    p2.botReplacedAt = Date.now() - 1000;
    gs.hands.set(p2Id, new Set());

    const conn = await openPlayer(p2Token);
    await sleep(100);

    expect(p2.isBot).toBe(false);
    expect(p2.botReplacedAt).toBeUndefined();
    expect(conn.messages.some((m) => m.type === 'reclaim_queued')).toBe(false);
  });
});
