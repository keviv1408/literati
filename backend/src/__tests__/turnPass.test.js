'use strict';

/**
 * turnPass.test.js
 *
 * Backend turn-pass logic: validate declarant eligibility,
 * accept a target seat identifier, update game state to transfer the active
 * turn, and emit a `turn-passed` socket event with the new active seat.
 *
 * Coverage:
 * 1. Successful turn pass — currentTurnPlayerId updated to target
 * 2. Successful turn pass — `turn-passed` event emitted with correct payload
 * 3. Successful turn pass — second connected player receives `game_state` broadcast
 * 4. Error: NOT_YOUR_TURN — non-active player sends pass_turn
 * 5. Error: SEAT_NOT_FOUND — targetSeatIndex resolves to no player
 * 6. Error: SELF_PASS — requester tries to pass to their own seat
 * 7. Error: WRONG_TEAM — requester tries to pass to an opponent's seat
 * 8. Error: TARGET_EMPTY_HAND — target player is eliminated (no cards)
 * 9. MISSING_FIELDS — targetSeatIndex not a number in socket message
 * 10. Post-declaration timer cancelled when turn is explicitly passed
 *
 * Unit tests (direct function calls, no WS):
 * 11. Updates currentTurnPlayerId without a WS connection
 * 12. Does nothing when game is not active
 * 13. Does nothing when requester is not the current turn player
 * 14. Does nothing when target seat does not exist
 */

const http      = require('http');
const express   = require('express');
const WebSocket = require('ws');

// ── Test constants ──────────────────────────────────────────────────────────

const ROOM_CODE = 'TPST01';

// ── Supabase mock factory ───────────────────────────────────────────────────

function buildSupabaseMock() {
  const chain = {};
  chain.select      = jest.fn().mockReturnValue(chain);
  chain.eq          = jest.fn().mockReturnValue(chain);
  chain.update      = jest.fn().mockReturnValue(chain);
  chain.upsert      = jest.fn().mockReturnValue(chain);
  chain.insert      = jest.fn().mockReturnValue(chain);
  chain.maybeSingle = jest.fn().mockResolvedValue({
    data:  { id: 'room-id-tp', code: ROOM_CODE, status: 'in_progress' },
    error: null,
  });

  return {
    from: jest.fn().mockReturnValue(chain),
    auth: {
      getUser: jest.fn().mockResolvedValue({ data: { user: null }, error: 'no-user' }),
    },
    rpc:    jest.fn().mockResolvedValue({ data: null, error: null }),
    _chain: chain,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Connect a WebSocket using `?token=<rawToken>` (query param, as the server expects),
 * wait for the `game_init` message, and return { ws, initMsg }.
 */
function waitForInit(port, rawToken, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const wsUrl = `ws://localhost:${port}/ws/game/${ROOM_CODE}?token=${rawToken}`;
    const ws    = new WebSocket(wsUrl);
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { ws.close(); } catch (_) {}
        reject(new Error(`waitForInit timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'game_init' && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ws, initMsg: msg });
      }
    });

    ws.on('error', (err) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(err); }
    });

    ws.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`waitForInit: WS closed (${code}) before game_init`));
      }
    });
  });
}

/**
 * Wait for the next message on `ws` that satisfies `predicate`.
 */
function waitForMessage(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`waitForMessage timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    const handler = (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!settled && predicate(msg)) {
        settled = true;
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };

    ws.on('message', handler);
  });
}

// ── Test suite ──────────────────────────────────────────────────────────────

describe('turn-pass logic (pass_turn socket message)', () => {
  let httpServer;
  let port;
  let mockSupabase;
  let gameSocketServer;
  let guestSessionStore;
  let disconnectStore;
  let clearGameStore;

  /** Live game-state object — mutated directly between tests. */
  let gs;

  /**
   * Game layout (remove_7s, 6 players):
   * Seat 0: p1 (Team 1, human) — **current turn player**
   * Seat 1: p4 (Team 2, human) — opponent
   * Seat 2: p2 (Team 1, human) — eligible teammate
   * Seat 3: bot-A (Team 2, bot)
   * Seat 4: bot-B (Team 1, bot)
   * Seat 5: bot-C (Team 2, bot)
   */
  let p1Token, p1Id;
  let p2Token, p2Id;
  let p4Token, p4Id;

  // ── beforeAll ──────────────────────────────────────────────────────────────

  beforeAll((done) => {
    jest.resetModules();

    mockSupabase = buildSupabaseMock();
    const { _setSupabaseClient } = require('../db/supabase');
    _setSupabaseClient(mockSupabase);

    guestSessionStore = require('../sessions/guestSessionStore');

    const sess1 = guestSessionStore.createGuestSession('Alice');
    p1Token = sess1.token;
    p1Id    = sess1.session.sessionId;

    const sess2 = guestSessionStore.createGuestSession('Bob');
    p2Token = sess2.token;
    p2Id    = sess2.session.sessionId;

    const sess4 = guestSessionStore.createGuestSession('Dave');
    p4Token = sess4.token;
    p4Id    = sess4.session.sessionId;

    gameSocketServer              = require('../game/gameSocketServer');
    ({ _clearAll: clearGameStore } = require('../game/gameStore'));
    disconnectStore = require('../game/disconnectStore');

    const seats = [
      { seatIndex: 0, playerId: p1Id,    displayName: 'Alice', avatarId: null, teamId: 1, isBot: false, isGuest: true  },
      { seatIndex: 1, playerId: p4Id,    displayName: 'Dave',  avatarId: null, teamId: 2, isBot: false, isGuest: true  },
      { seatIndex: 2, playerId: p2Id,    displayName: 'Bob',   avatarId: null, teamId: 1, isBot: false, isGuest: true  },
      { seatIndex: 3, playerId: 'bot-A', displayName: 'BotA',  avatarId: null, teamId: 2, isBot: true,  isGuest: false },
      { seatIndex: 4, playerId: 'bot-B', displayName: 'BotB',  avatarId: null, teamId: 1, isBot: true,  isGuest: false },
      { seatIndex: 5, playerId: 'bot-C', displayName: 'BotC',  avatarId: null, teamId: 2, isBot: true,  isGuest: false },
    ];

    gs = gameSocketServer.createGame({
      roomCode:    ROOM_CODE,
      roomId:      'room-id-tp',
      variant:     'remove_7s',
      playerCount: 6,
      seats,
    });

    const app = express();
    httpServer = http.createServer(app);
    gameSocketServer.attachGameSocketServer(httpServer);

    httpServer.listen(0, () => {
      port = httpServer.address().port;
      done();
    });
  });

  // ── beforeEach: reset mutable game state ──────────────────────────────────

  beforeEach(async () => {
    // Pre-emptively mark all players as bots to suppress reconnect-window
    // creation from any pending close events from the previous test.
    for (const player of gs.players) {
      player.isBot = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    gameSocketServer.cancelTurnTimer(ROOM_CODE);
    if (gameSocketServer.cancelBotTimer) gameSocketServer.cancelBotTimer(ROOM_CODE);
    if (gameSocketServer._cancelReconnectWindow) {
      gameSocketServer._cancelReconnectWindow(p1Id);
      gameSocketServer._cancelReconnectWindow(p2Id);
      gameSocketServer._cancelReconnectWindow(p4Id);
    }
    if (gameSocketServer._clearAllReconnectWindows) {
      gameSocketServer._clearAllReconnectWindows();
    }
    if (disconnectStore) {
      [p1Id, p2Id, p4Id].forEach((id) => {
        disconnectStore.cancelDisconnectTimer(ROOM_CODE, id);
        disconnectStore.removeFromReclaimQueue(ROOM_CODE, id);
      });
    }

    // Reset hands and turn state.
    gs.hands.set(p1Id,    new Set(['1_s', '2_s', '3_s']));
    gs.hands.set(p2Id,    new Set(['1_h', '2_h', '3_h']));
    gs.hands.set(p4Id,    new Set(['4_h', '5_h', '6_h']));
    gs.hands.set('bot-A', new Set(['8_h', '9_h', '10_h']));
    gs.hands.set('bot-B', new Set(['11_h', '12_h', '13_h']));
    gs.hands.set('bot-C', new Set(['8_s', '9_s', '10_s']));
    gs.currentTurnPlayerId = p1Id;
    gs.status              = 'active';
    gs.lastMove            = null;
    gs.scores              = { team1: 0, team2: 0 };
    gs.winner              = null;
    gs.tiebreakerWinner    = null;
    gs.moveHistory         = [];
    gs.declaredSuits       = new Map();
    if (gs.eliminatedPlayerIds) gs.eliminatedPlayerIds.clear();

    // Restore original isBot values.
    for (const player of gs.players) {
      player.isBot = ['bot-A', 'bot-B', 'bot-C'].includes(player.playerId);
      delete player.botReplacedAt;
    }

    mockSupabase._chain.maybeSingle.mockResolvedValue({
      data:  { id: 'room-id-tp', code: ROOM_CODE, status: 'in_progress' },
      error: null,
    });
  });

  // ── afterAll ───────────────────────────────────────────────────────────────

  afterAll(async () => {
    if (gs) {
      for (const player of gs.players) player.isBot = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    gameSocketServer.cancelTurnTimer(ROOM_CODE);
    if (gameSocketServer.cancelBotTimer) gameSocketServer.cancelBotTimer(ROOM_CODE);
    if (gameSocketServer._clearAllReconnectWindows) gameSocketServer._clearAllReconnectWindows();
    if (disconnectStore) {
      [p1Id, p2Id, p4Id].forEach((id) => {
        disconnectStore.cancelDisconnectTimer(ROOM_CODE, id);
        disconnectStore.removeFromReclaimQueue(ROOM_CODE, id);
      });
    }
    if (clearGameStore)    clearGameStore();
    if (guestSessionStore) guestSessionStore._clearStore();
    await new Promise((resolve) => httpServer.close(resolve));
    if (gameSocketServer._clearAllReconnectWindows) gameSocketServer._clearAllReconnectWindows();
    jest.resetModules();
  });

  /**
   * Close open WebSocket connections without triggering reconnect windows.
   * Marks all players as bots first to suppress reconnect-window creation.
   */
  async function cleanupConnections(...sockets) {
    for (const player of gs.players) player.isBot = true;
    gameSocketServer.cancelTurnTimer(ROOM_CODE);
    for (const sock of sockets) {
      try { sock.close(); } catch (_) {}
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (gameSocketServer._clearAllReconnectWindows) gameSocketServer._clearAllReconnectWindows();
  }

  // ── Integration tests (WebSocket) ──────────────────────────────────────────

  it('1. Successful pass — currentTurnPlayerId updated to target', async () => {
    const { ws: ws1 } = await waitForInit(port, p1Token);
    try {
      ws1.send(JSON.stringify({ type: 'pass_turn', targetSeatIndex: 2 }));

      // Wait for the turn-passed event as confirmation the move was processed.
      await waitForMessage(ws1, (m) => m.type === 'turn-passed', 3000);

      expect(gs.currentTurnPlayerId).toBe(p2Id);
    } finally {
      await cleanupConnections(ws1);
    }
  });

  it('2. Successful pass — `turn-passed` event emitted with correct payload', async () => {
    const { ws: ws1 } = await waitForInit(port, p1Token);
    try {
      ws1.send(JSON.stringify({ type: 'pass_turn', targetSeatIndex: 2 }));

      const msg = await waitForMessage(ws1, (m) => m.type === 'turn-passed', 3000);

      expect(msg.fromPlayerId).toBe(p1Id);
      expect(msg.fromSeatIndex).toBe(0);
      expect(msg.newActivePlayerId).toBe(p2Id);
      expect(msg.newActiveSeatIndex).toBe(2);
    } finally {
      await cleanupConnections(ws1);
    }
  });

  it('3. Successful pass — second connected player receives `game_state` with new active turn', async () => {
    const { ws: ws1 } = await waitForInit(port, p1Token);
    const { ws: ws2 } = await waitForInit(port, p2Token);
    try {
      // Listen for game_state on ws2 BEFORE sending the message.
      // The broadcast format is: { type: 'game_state', state: { currentTurnPlayerId, ... } }
      const gsPromise = waitForMessage(
        ws2,
        (m) => m.type === 'game_state' && m.state?.currentTurnPlayerId === p2Id,
        3000,
      );

      ws1.send(JSON.stringify({ type: 'pass_turn', targetSeatIndex: 2 }));

      const gsMsg = await gsPromise;
      expect(gsMsg.state.currentTurnPlayerId).toBe(p2Id);
    } finally {
      await cleanupConnections(ws1, ws2);
    }
  });

  it('4. Error: NOT_YOUR_TURN — non-active player cannot pass the turn', async () => {
    // p2 (seat 2) is NOT the current turn player; sending pass_turn should error.
    const { ws: ws2 } = await waitForInit(port, p2Token);
    try {
      const errPromise = waitForMessage(ws2, (m) => m.type === 'error', 3000);
      ws2.send(JSON.stringify({ type: 'pass_turn', targetSeatIndex: 0 }));

      const errMsg = await errPromise;
      expect(errMsg.code).toBe('NOT_YOUR_TURN');
      // Game turn must not have changed.
      expect(gs.currentTurnPlayerId).toBe(p1Id);
    } finally {
      await cleanupConnections(ws2);
    }
  });

  it('5. Error: SEAT_NOT_FOUND — targetSeatIndex resolves to no player', async () => {
    const { ws: ws1 } = await waitForInit(port, p1Token);
    try {
      const errPromise = waitForMessage(ws1, (m) => m.type === 'error', 3000);
      ws1.send(JSON.stringify({ type: 'pass_turn', targetSeatIndex: 99 }));

      const errMsg = await errPromise;
      expect(errMsg.code).toBe('SEAT_NOT_FOUND');
      expect(gs.currentTurnPlayerId).toBe(p1Id);
    } finally {
      await cleanupConnections(ws1);
    }
  });

  it('6. Error: SELF_PASS — requester cannot pass to their own seat', async () => {
    const { ws: ws1 } = await waitForInit(port, p1Token);
    try {
      const errPromise = waitForMessage(ws1, (m) => m.type === 'error', 3000);
      ws1.send(JSON.stringify({ type: 'pass_turn', targetSeatIndex: 0 })); // p1 is at seat 0

      const errMsg = await errPromise;
      expect(errMsg.code).toBe('SELF_PASS');
      expect(gs.currentTurnPlayerId).toBe(p1Id);
    } finally {
      await cleanupConnections(ws1);
    }
  });

  it('7. Error: WRONG_TEAM — requester cannot pass to an opponent', async () => {
    const { ws: ws1 } = await waitForInit(port, p1Token);
    try {
      const errPromise = waitForMessage(ws1, (m) => m.type === 'error', 3000);
      ws1.send(JSON.stringify({ type: 'pass_turn', targetSeatIndex: 1 })); // p4 (Dave) is Team 2

      const errMsg = await errPromise;
      expect(errMsg.code).toBe('WRONG_TEAM');
      expect(gs.currentTurnPlayerId).toBe(p1Id);
    } finally {
      await cleanupConnections(ws1);
    }
  });

  it('8. Error: TARGET_EMPTY_HAND — target player has no cards (eliminated)', async () => {
    // Empty bot-B's hand (seat 4, Team 1) to simulate an eliminated teammate.
    gs.hands.set('bot-B', new Set());
    if (!gs.eliminatedPlayerIds) gs.eliminatedPlayerIds = new Set();
    gs.eliminatedPlayerIds.add('bot-B');

    const { ws: ws1 } = await waitForInit(port, p1Token);
    try {
      const errPromise = waitForMessage(ws1, (m) => m.type === 'error', 3000);
      ws1.send(JSON.stringify({ type: 'pass_turn', targetSeatIndex: 4 })); // bot-B (Team 1) no cards

      const errMsg = await errPromise;
      expect(errMsg.code).toBe('TARGET_EMPTY_HAND');
      expect(gs.currentTurnPlayerId).toBe(p1Id);
    } finally {
      await cleanupConnections(ws1);
    }
  });

  it('9. MISSING_FIELDS — targetSeatIndex not a number returns error', async () => {
    const { ws: ws1 } = await waitForInit(port, p1Token);
    try {
      const errPromise = waitForMessage(ws1, (m) => m.type === 'error', 3000);
      ws1.send(JSON.stringify({ type: 'pass_turn', targetSeatIndex: 'two' }));

      const errMsg = await errPromise;
      expect(errMsg.code).toBe('MISSING_FIELDS');
      expect(gs.currentTurnPlayerId).toBe(p1Id);
    } finally {
      await cleanupConnections(ws1);
    }
  });

  it('10. Post-declaration timer is cancelled when turn is explicitly passed', async () => {
    // Manually inject a fake post-declaration timer entry to simulate the window.
    const fakeTimer = {
      interval: setInterval(() => {}, 100_000),
      timeout:  setTimeout(() => {}, 100_000),
    };
    gameSocketServer._postDeclarationTimers.set(ROOM_CODE, fakeTimer);

    expect(gameSocketServer._postDeclarationTimers.has(ROOM_CODE)).toBe(true);

    const { ws: ws1 } = await waitForInit(port, p1Token);
    try {
      ws1.send(JSON.stringify({ type: 'pass_turn', targetSeatIndex: 2 }));
      // Wait for the turn-passed confirmation.
      await waitForMessage(ws1, (m) => m.type === 'turn-passed', 3000);

      // The post-declaration timer should have been cancelled by handlePassTurn.
      expect(gameSocketServer._postDeclarationTimers.has(ROOM_CODE)).toBe(false);
      expect(gs.currentTurnPlayerId).toBe(p2Id);
    } finally {
      // Safety: clean up if the timer survived due to a test failure.
      if (gameSocketServer._postDeclarationTimers.has(ROOM_CODE)) {
        const t = gameSocketServer._postDeclarationTimers.get(ROOM_CODE);
        if (t && t.timeout)  clearTimeout(t.timeout);
        if (t && t.interval) clearInterval(t.interval);
        gameSocketServer._postDeclarationTimers.delete(ROOM_CODE);
      }
      await cleanupConnections(ws1);
    }
  });

  // ── Unit tests: handlePassTurn exported function ────────────────────────────

  describe('handlePassTurn — exported function (unit tests)', () => {
    it('11. Updates currentTurnPlayerId to the player at the given seat index', () => {
      gs.currentTurnPlayerId = p1Id;
      gameSocketServer.handlePassTurn(ROOM_CODE, p1Id, 2, null);
      expect(gs.currentTurnPlayerId).toBe(p2Id);
      // Restore for next test.
      gs.currentTurnPlayerId = p1Id;
    });

    it('12. Does nothing when game is not active', () => {
      gs.status = 'completed';
      gameSocketServer.handlePassTurn(ROOM_CODE, p1Id, 2, null);
      // No throw; status unchanged (reset in beforeEach anyway).
      gs.status = 'active';
    });

    it('13. Does nothing when requester is not the current turn player', () => {
      gs.currentTurnPlayerId = p1Id;
      gameSocketServer.handlePassTurn(ROOM_CODE, p2Id, 0, null);
      expect(gs.currentTurnPlayerId).toBe(p1Id);
    });

    it('14. Does nothing when target seat does not exist', () => {
      gs.currentTurnPlayerId = p1Id;
      gameSocketServer.handlePassTurn(ROOM_CODE, p1Id, 77, null);
      expect(gs.currentTurnPlayerId).toBe(p1Id);
    });
  });
});
