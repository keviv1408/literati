/**
 * Game socket heartbeat: every open socket gets {"type":"heartbeat"} on connect
 * and every HEARTBEAT_INTERVAL_MS after, so clients can spot a dead socket.
 */

const http      = require('http');
const express   = require('express');
const WebSocket = require('ws');

const ROOM_CODE = 'HRTBT1';
const HEARTBEAT = '{"type":"heartbeat"}';

function buildSupabaseMock() {
  const chain = {};
  chain.select      = jest.fn().mockReturnValue(chain);
  chain.eq          = jest.fn().mockReturnValue(chain);
  chain.update      = jest.fn().mockReturnValue(chain);
  chain.upsert      = jest.fn().mockReturnValue(chain);
  chain.insert      = jest.fn().mockReturnValue(chain);
  chain.maybeSingle = jest.fn().mockResolvedValue({
    data:  { id: 'room-id-hrtbt', code: ROOM_CODE, status: 'in_progress' },
    error: null,
  });
  return {
    from: jest.fn().mockReturnValue(chain),
    auth: { getUser: jest.fn().mockResolvedValue({ data: { user: null }, error: 'no-user' }) },
    rpc:  jest.fn().mockResolvedValue({ data: null, error: null }),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('_broadcastHeartbeat', () => {
  it('sends the heartbeat to open sockets only', () => {
    const { _broadcastHeartbeat } = require('../game/gameSocketServer');
    const open   = { readyState: 1, send: jest.fn() };
    const closed = { readyState: 3, send: jest.fn() };

    _broadcastHeartbeat({ clients: new Set([open, closed]) });

    expect(open.send).toHaveBeenCalledTimes(1);
    expect(open.send).toHaveBeenCalledWith(HEARTBEAT);
    expect(closed.send).not.toHaveBeenCalled();
  });
});

describe('heartbeat interval', () => {
  afterEach(() => {
    // The spies wrap the fake timer functions, so restoring them after useRealTimers would put the fakes back.
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('sends every 15 s and stops when the server closes', () => {
    jest.useFakeTimers();
    const setSpy   = jest.spyOn(global, 'setInterval');
    const clearSpy = jest.spyOn(global, 'clearInterval');
    const { attachGameSocketServer, HEARTBEAT_INTERVAL_MS } = require('../game/gameSocketServer');
    expect(HEARTBEAT_INTERVAL_MS).toBe(15_000);

    const wss  = attachGameSocketServer({ on: jest.fn() });
    const heartbeatCall = setSpy.mock.calls.findIndex(([, ms]) => ms === 15_000);
    const heartbeatTimer = setSpy.mock.results[heartbeatCall].value;
    const stub = { readyState: 1, send: jest.fn() };
    wss.clients.add(stub);

    jest.advanceTimersByTime(15_000);
    expect(stub.send).toHaveBeenCalledTimes(1);
    expect(stub.send).toHaveBeenCalledWith(HEARTBEAT);

    jest.advanceTimersByTime(15_000);
    expect(stub.send).toHaveBeenCalledTimes(2);

    wss.clients.delete(stub);
    wss.close();
    jest.runAllTicks();
    expect(clearSpy).toHaveBeenCalledWith(heartbeatTimer);

    jest.advanceTimersByTime(30_000);
    expect(stub.send).toHaveBeenCalledTimes(2);
  });
});

describe('heartbeat on a real socket', () => {
  let httpServer;
  let port;
  let gameSocketServer;
  let gameStore;
  let guestSessionStore;
  let p1Token;
  const openSockets = [];

  beforeAll((done) => {
    jest.resetModules();
    const { _setSupabaseClient } = require('../db/supabase');
    _setSupabaseClient(buildSupabaseMock());

    guestSessionStore = require('../sessions/guestSessionStore');
    const sess1 = guestSessionStore.createGuestSession('Alice');
    p1Token = sess1.token;
    const p1Id = sess1.session.sessionId;
    const sess2 = guestSessionStore.createGuestSession('Bob');
    const p2Id = sess2.session.sessionId;

    gameSocketServer = require('../game/gameSocketServer');
    gameStore        = require('../game/gameStore');

    const gs = gameSocketServer.createGame({
      roomCode:    ROOM_CODE,
      roomId:      'room-id-hrtbt',
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
    gs.hands.set(p1Id,    new Set(['1_s', '2_s', '3_s']));
    gs.hands.set(p2Id,    new Set(['4_s', '5_s', '6_s']));
    gs.hands.set('bot-1', new Set(['1_h', '2_h', '3_h']));
    gs.hands.set('bot-2', new Set(['4_h', '5_h', '6_h']));
    gs.hands.set('bot-3', new Set(['1_d', '2_d', '3_d']));
    gs.hands.set('bot-4', new Set(['4_d', '5_d', '6_d']));
    gs.currentTurnPlayerId = p1Id;
    gs.status = 'active';

    const app = express();
    httpServer = http.createServer(app);
    gameSocketServer.attachGameSocketServer(httpServer);
    httpServer.listen(0, () => {
      port = httpServer.address().port;
      done();
    });
  });

  afterAll(async () => {
    for (const ws of openSockets.splice(0)) {
      try { ws.close(); } catch { /* already closed */ }
    }
    await sleep(50);
    gameSocketServer.cancelTurnTimer(ROOM_CODE);
    gameSocketServer.cancelBotTimer(ROOM_CODE);
    gameSocketServer._clearAllReconnectWindows();
    gameStore._clearAll();
    guestSessionStore._clearStore();
    await new Promise((r) => httpServer.close(r));
    jest.resetModules();
  });

  it('sends a heartbeat when a player connects', async () => {
    const messages = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws/game/${ROOM_CODE}?token=${p1Token}`);
      openSockets.push(ws);
      const received = [];
      const timer = setTimeout(() => reject(new Error('no game_init')), 5000);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        received.push(msg);
        if (msg.type === 'game_init') {
          clearTimeout(timer);
          resolve(received);
        }
      });
      ws.on('error', reject);
    });

    expect(messages.some((m) => m.type === 'heartbeat')).toBe(true);
  });
});
