'use strict';

/**
 * failedAskTurnPass.test.js
 *
 * AC 18: Failed card request passes turn to the specific player who was asked.
 *
 * Tests verify that when a player asks an opponent for a card and the opponent
 * does not hold that card, the turn passes to the SPECIFIC player who was asked
 * (not to another player on that team, and not retained by the asker).
 *
 * Coverage:
 *   1. Failed ask_card: ask_result.newTurnPlayerId === targetId (the player asked)
 *   2. Failed ask_card: game_state broadcast shows currentTurnPlayerId === targetId
 *   3. Failed ask_card: game_players broadcast marks targetId as isCurrentTurn
 *   4. Failed ask_card: turn does NOT stay with asker
 *   5. Failed ask_card: turn does NOT pass to a different team-member of target
 *   6. Successful ask_card: turn stays with asker (regression guard)
 */

const http      = require('http');
const express   = require('express');
const WebSocket = require('ws');

// ── Test constants ──────────────────────────────────────────────────────────

const ROOM_CODE     = 'FLTST1';
const SPECTATOR_HEX = 'CCDDEEFF00112233445566778899AABB';

// ── Supabase mock factory ───────────────────────────────────────────────────

function buildSupabaseMock() {
  const chain = {};
  chain.select      = jest.fn().mockReturnValue(chain);
  chain.eq          = jest.fn().mockReturnValue(chain);
  chain.update      = jest.fn().mockReturnValue(chain);
  chain.upsert      = jest.fn().mockReturnValue(chain);
  chain.insert      = jest.fn().mockReturnValue(chain);
  chain.maybeSingle = jest.fn().mockResolvedValue({
    data:  { id: 'room-id-flt', code: ROOM_CODE, status: 'in_progress' },
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

// ── Test suite ──────────────────────────────────────────────────────────────

describe('AC 18 — Failed card request passes turn to the specific player who was asked', () => {
  let httpServer;
  let port;
  let mockSupabase;
  let gameSocketServer;
  let guestSessionStore;
  let disconnectStore;
  let clearGameStore;

  /** The live game-state object — mutated directly between tests. */
  let gs;

  /**
   * Player tokens and IDs.
   *
   * Game setup (remove_7s variant):
   *   p1 (Team 1, human) — current-turn player, holds low_s cards (1_s 2_s 3_s)
   *   p2 (Team 2, human) — holds low_h cards (1_h 2_h 3_h) — no low_s → failed ask target
   *   p3 (Team 2, human) — holds high_h cards (8_h 9_h 10_h) — another Team 2 player
   *   bots fill remaining seats
   *
   * p1 will ask p2 for 4_s (low_s card).
   *   - p2 does NOT hold 4_s → FAILED ask.
   *   - Turn must pass to p2 specifically, NOT to p3 (also Team 2).
   */
  let p1Token, p1Id;
  let p2Token, p2Id;
  let p3Token, p3Id;

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

    const sess3 = guestSessionStore.createGuestSession('Carol');
    p3Token = sess3.token;
    p3Id    = sess3.session.sessionId;

    gameSocketServer              = require('../game/gameSocketServer');
    ({ _clearAll: clearGameStore } = require('../game/gameStore'));
    disconnectStore = require('../game/disconnectStore');

    // 6-player game:
    //   Seat 0: p1 (Team 1, human) — current turn
    //   Seat 1: p2 (Team 2, human) — will be asked, doesn't have the card
    //   Seat 2: bot-A (Team 1)
    //   Seat 3: p3 (Team 2, human) — another Team-2 player (should NOT get turn)
    //   Seat 4: bot-B (Team 1)
    //   Seat 5: bot-C (Team 2)
    const seats = [
      { seatIndex: 0, playerId: p1Id,    displayName: 'Alice', avatarId: null, teamId: 1, isBot: false, isGuest: true  },
      { seatIndex: 1, playerId: p2Id,    displayName: 'Bob',   avatarId: null, teamId: 2, isBot: false, isGuest: true  },
      { seatIndex: 2, playerId: 'bot-A', displayName: 'BotA',  avatarId: null, teamId: 1, isBot: true,  isGuest: false },
      { seatIndex: 3, playerId: p3Id,    displayName: 'Carol', avatarId: null, teamId: 2, isBot: false, isGuest: true  },
      { seatIndex: 4, playerId: 'bot-B', displayName: 'BotB',  avatarId: null, teamId: 1, isBot: true,  isGuest: false },
      { seatIndex: 5, playerId: 'bot-C', displayName: 'BotC',  avatarId: null, teamId: 2, isBot: true,  isGuest: false },
    ];

    gs = gameSocketServer.createGame({
      roomCode:    ROOM_CODE,
      roomId:      'room-id-flt',
      variant:     'remove_7s',
      playerCount: 6,
      seats,
    });

    // Override hands:
    //   p1 holds 1_s 2_s 3_s (low_s) → can ask for 4_s
    //   p2 holds 1_h 2_h 3_h (low_h) + 5_s (low_s) → has a low_s card but NOT 4_s → ask FAILS
    //     (target must hold ≥1 card in the requested half-suit per server rule)
    //   p3 holds 4_h 5_h 6_h (low_h)  → another Team 2 member (must NOT get turn)
    //   bots hold remaining cards
    gs.hands.set(p1Id,    new Set(['1_s', '2_s', '3_s']));
    gs.hands.set(p2Id,    new Set(['1_h', '2_h', '3_h', '5_s'])); // +5_s: p2 holds low_s
    gs.hands.set(p3Id,    new Set(['4_h', '5_h', '6_h']));
    gs.hands.set('bot-A', new Set(['4_s', '6_s']));               // -5_s moved to p2
    gs.hands.set('bot-B', new Set(['8_s', '9_s', '10_s']));
    gs.hands.set('bot-C', new Set(['11_s', '12_s', '13_s']));
    gs.currentTurnPlayerId = p1Id;
    gs.status              = 'active';

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
    // ── Phase 1: Pre-emptively mark ALL players as bots ──────────────────────
    // The previous test's WS connections close asynchronously; their server-side
    // `ws.on('close')` handlers may fire AFTER this `beforeEach` starts running.
    // By marking everyone as `isBot = true` first, those handlers see
    // `player.isBot === true` and skip `_startReconnectWindow` entirely — no
    // stale `game_state` broadcasts, no stray bot-turn timers.
    for (const player of gs.players) {
      player.isBot = true;
    }

    // ── Phase 2: Drain pending close events ──────────────────────────────────
    // Give Node.js 100 ms to drain any pending close callbacks from the
    // previous test's WS teardown.  The players already look like bots, so
    // _startReconnectWindow will be skipped in those callbacks even if they
    // fire during this wait.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // ── Phase 3: Cancel any timers that slipped through ───────────────────────
    gameSocketServer.cancelTurnTimer(ROOM_CODE);
    if (gameSocketServer.cancelBotTimer) {
      gameSocketServer.cancelBotTimer(ROOM_CODE);
    }
    if (gameSocketServer._cancelReconnectWindow) {
      gameSocketServer._cancelReconnectWindow(p1Id);
      gameSocketServer._cancelReconnectWindow(p2Id);
      gameSocketServer._cancelReconnectWindow(p3Id);
    }
    // Nuke the entire map: handles any window created after per-player cancels.
    if (gameSocketServer._clearAllReconnectWindows) {
      gameSocketServer._clearAllReconnectWindows();
    }
    if (disconnectStore) {
      disconnectStore.cancelDisconnectTimer(ROOM_CODE, p1Id);
      disconnectStore.cancelDisconnectTimer(ROOM_CODE, p2Id);
      disconnectStore.cancelDisconnectTimer(ROOM_CODE, p3Id);
      disconnectStore.removeFromReclaimQueue(ROOM_CODE, p1Id);
      disconnectStore.removeFromReclaimQueue(ROOM_CODE, p2Id);
      disconnectStore.removeFromReclaimQueue(ROOM_CODE, p3Id);
    }

    // ── Phase 4: Reset all mutable game state ────────────────────────────────
    gs.hands.set(p1Id,    new Set(['1_s', '2_s', '3_s']));
    gs.hands.set(p2Id,    new Set(['1_h', '2_h', '3_h', '5_s'])); // p2 holds low_s but not 4_s
    gs.hands.set(p3Id,    new Set(['4_h', '5_h', '6_h']));
    gs.hands.set('bot-A', new Set(['4_s', '6_s']));               // 5_s moved to p2
    gs.hands.set('bot-B', new Set(['8_s', '9_s', '10_s']));
    gs.hands.set('bot-C', new Set(['11_s', '12_s', '13_s']));
    gs.currentTurnPlayerId = p1Id;
    gs.status              = 'active';
    gs.lastMove            = null;
    gs.scores              = { team1: 0, team2: 0 };
    gs.winner              = null;
    gs.tiebreakerWinner    = null;
    gs.moveHistory         = [];
    gs.declaredSuits       = new Map();

    // Reset isBot to original values now that close events have been drained.
    for (const player of gs.players) {
      const originalIsBot = ['bot-A', 'bot-B', 'bot-C'].includes(player.playerId);
      player.isBot = originalIsBot;
      delete player.botReplacedAt;
    }

    mockSupabase._chain.maybeSingle.mockResolvedValue({
      data:  { id: 'room-id-flt', code: ROOM_CODE, status: 'in_progress' },
      error: null,
    });
  });

  // ── afterAll ───────────────────────────────────────────────────────────────

  afterAll(async () => {
    // Mark all players as bots BEFORE closing the server so that any pending
    // WS close events skip _startReconnectWindow (same technique as beforeEach).
    if (gs) {
      for (const player of gs.players) {
        player.isBot = true;
      }
    }
    // Wait briefly to drain any remaining close callbacks.
    await new Promise((resolve) => setTimeout(resolve, 100));

    gameSocketServer.cancelTurnTimer(ROOM_CODE);
    if (gameSocketServer.cancelBotTimer) {
      gameSocketServer.cancelBotTimer(ROOM_CODE);
    }
    if (gameSocketServer._cancelReconnectWindow) {
      gameSocketServer._cancelReconnectWindow(p1Id);
      gameSocketServer._cancelReconnectWindow(p2Id);
      gameSocketServer._cancelReconnectWindow(p3Id);
    }
    if (disconnectStore) {
      disconnectStore.cancelDisconnectTimer(ROOM_CODE, p1Id);
      disconnectStore.cancelDisconnectTimer(ROOM_CODE, p2Id);
      disconnectStore.cancelDisconnectTimer(ROOM_CODE, p3Id);
      disconnectStore.removeFromReclaimQueue(ROOM_CODE, p1Id);
      disconnectStore.removeFromReclaimQueue(ROOM_CODE, p2Id);
      disconnectStore.removeFromReclaimQueue(ROOM_CODE, p3Id);
    }
    if (clearGameStore)    clearGameStore();
    if (guestSessionStore) guestSessionStore._clearStore();
    await new Promise((resolve) => httpServer.close(resolve));
    // Nuclear cleanup: cancel every remaining reconnect-window timer.
    // Any close event that fired after our per-player cancellations above could
    // have re-created a 60-second timer; clearing the whole map prevents the
    // "Cannot log after tests are done" Jest warning.
    if (gameSocketServer._clearAllReconnectWindows) {
      gameSocketServer._clearAllReconnectWindows();
    }
    jest.resetModules();
  });

  /**
   * Tear down WS connections from a test without triggering reconnect windows.
   *
   * Marks every player as a bot first (so the server's `ws.on('close')` handler
   * skips `_startReconnectWindow`), closes the provided sockets, then awaits
   * 50 ms for the server-side close callbacks to fire.  Using `await` here
   * guarantees the close events are fully processed BEFORE the test's async
   * function returns — which means they are processed before `beforeEach` for
   * the next test even begins, eliminating any timing-based race.
   */
  async function cleanupConnections(...sockets) {
    // Pre-emptive bot flag: whichever player's close event fires will see
    // isBot === true and skip _startReconnectWindow.
    for (const player of gs.players) {
      player.isBot = true;
    }
    gameSocketServer.cancelTurnTimer(ROOM_CODE);
    for (const ws of sockets) {
      try { ws.close(); } catch (_) {}
    }
    // 50 ms is far more than enough for a local-loopback WS close handshake.
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Belt-and-suspenders: nuke any reconnect-window timer that was somehow
    // created during the 50 ms (extremely unlikely given isBot=true above, but
    // ensures the map is clean before beforeEach resets the isBot flags).
    if (gameSocketServer._clearAllReconnectWindows) {
      gameSocketServer._clearAllReconnectWindows();
    }
  }

  // ── WS helpers ─────────────────────────────────────────────────────────────

  function waitForInit(queryString, initType = 'game_init', timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const wsUrl = `ws://localhost:${port}/ws/game/${ROOM_CODE}?${queryString}`;
      const ws    = new WebSocket(wsUrl);
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { ws.close(); } catch (_) {}
          reject(new Error(`waitForInit timed out after ${timeoutMs}ms waiting for '${initType}'`));
        }
      }, timeoutMs);

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === initType && !settled) {
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
          reject(new Error(`waitForInit: WS closed (${code}) before '${initType}'`));
        }
      });
    });
  }

  function waitForMessage(ws, predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`waitForMessage: timed out after ${timeoutMs}ms`));
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

  // ── Tests ─────────────────────────────────────────────────────────────────

  it('AC 18 (1): failed ask — ask_result.newTurnPlayerId equals the player who was asked', async () => {
    // p1 asks p2 for 4_s.  p2 only holds low_h cards (1_h 2_h 3_h) → FAILED.
    // newTurnPlayerId must be p2Id (the specific player asked).
    const { ws: ws1 } = await waitForInit(`token=${p1Token}`, 'game_init');
    const { ws: ws2 } = await waitForInit(`token=${p2Token}`, 'game_init');

    try {
      const [askResult] = await Promise.all([
        waitForMessage(ws1, (m) => m.type === 'ask_result', 5000),
        new Promise((resolve) => {
          setTimeout(() => {
            ws1.send(JSON.stringify({
              type:           'ask_card',
              targetPlayerId: p2Id,
              cardId:         '4_s', // p2 does NOT hold this card
            }));
            resolve();
          }, 50);
        }),
      ]);

      expect(askResult.type).toBe('ask_result');
      expect(askResult.success).toBe(false);
      expect(askResult.targetId).toBe(p2Id);
      // AC 18: turn must pass to the specific player asked (p2), not retained by p1
      expect(askResult.newTurnPlayerId).toBe(p2Id);
      expect(askResult.newTurnPlayerId).not.toBe(p1Id);
    } finally {
      await cleanupConnections(ws1, ws2);
    }
  });

  it('AC 18 (2): failed ask — game_state broadcast shows currentTurnPlayerId as the player asked', async () => {
    const { ws: ws1 } = await waitForInit(`token=${p1Token}`, 'game_init');
    const { ws: ws2 } = await waitForInit(`token=${p2Token}`, 'game_init');

    try {
      const [gameState] = await Promise.all([
        waitForMessage(ws1, (m) => m.type === 'game_state', 5000),
        new Promise((resolve) => {
          setTimeout(() => {
            ws1.send(JSON.stringify({
              type:           'ask_card',
              targetPlayerId: p2Id,
              cardId:         '4_s', // p2 does NOT hold this card → FAILED
            }));
            resolve();
          }, 50);
        }),
      ]);

      expect(gameState.type).toBe('game_state');
      expect(gameState.state.currentTurnPlayerId).toBe(p2Id);
      // Asker must NOT still be the current turn player after a failed ask
      expect(gameState.state.currentTurnPlayerId).not.toBe(p1Id);
    } finally {
      await cleanupConnections(ws1, ws2);
    }
  });

  it('AC 18 (3): failed ask — game_players broadcast marks the asked player as isCurrentTurn', async () => {
    const { ws: ws1 } = await waitForInit(`token=${p1Token}`, 'game_init');
    const { ws: ws2 } = await waitForInit(`token=${p2Token}`, 'game_init');

    try {
      const [gamePlayers] = await Promise.all([
        waitForMessage(ws1, (m) => m.type === 'game_players', 5000),
        new Promise((resolve) => {
          setTimeout(() => {
            ws1.send(JSON.stringify({
              type:           'ask_card',
              targetPlayerId: p2Id,
              cardId:         '4_s', // p2 does NOT hold this card → FAILED
            }));
            resolve();
          }, 50);
        }),
      ]);

      expect(gamePlayers.type).toBe('game_players');
      const players = gamePlayers.players;
      const p2Player = players.find((p) => p.playerId === p2Id);
      const p1Player = players.find((p) => p.playerId === p1Id);

      // p2 (the asked player) must be the current turn player after a failed ask
      expect(p2Player).toBeDefined();
      expect(p2Player.isCurrentTurn).toBe(true);

      // p1 (the asker) must no longer be the current turn player
      expect(p1Player).toBeDefined();
      expect(p1Player.isCurrentTurn).toBe(false);
    } finally {
      await cleanupConnections(ws1, ws2);
    }
  });

  it('AC 18 (4): failed ask — turn does NOT pass to a different Team 2 member; stays on the SPECIFIC player asked', async () => {
    // This is the critical discriminator: even though p3 is also Team 2 and holds cards,
    // the turn must go to p2 (who was specifically asked) — NOT to p3.
    const { ws: ws1 } = await waitForInit(`token=${p1Token}`, 'game_init');
    const { ws: ws2 } = await waitForInit(`token=${p2Token}`, 'game_init');
    const { ws: ws3 } = await waitForInit(`token=${p3Token}`, 'game_init');

    try {
      const [askResult] = await Promise.all([
        waitForMessage(ws1, (m) => m.type === 'ask_result', 5000),
        new Promise((resolve) => {
          setTimeout(() => {
            ws1.send(JSON.stringify({
              type:           'ask_card',
              targetPlayerId: p2Id,
              cardId:         '4_s', // p2 does NOT hold 4_s; it's with bot-A
            }));
            resolve();
          }, 50);
        }),
      ]);

      expect(askResult.success).toBe(false);
      // Turn must be with p2 (asked) — NOT p3 (another Team 2 member with cards)
      expect(askResult.newTurnPlayerId).toBe(p2Id);
      expect(askResult.newTurnPlayerId).not.toBe(p3Id);
    } finally {
      await cleanupConnections(ws1, ws2, ws3);
    }
  });

  it('AC 18 (5): ask_result is broadcast to ALL clients including the asked player', async () => {
    // After a failed ask, p2 (the newly active player) must receive the ask_result
    // so they know it is now their turn.
    const { ws: ws1 } = await waitForInit(`token=${p1Token}`, 'game_init');
    const { ws: ws2 } = await waitForInit(`token=${p2Token}`, 'game_init');

    try {
      const [result1, result2] = await Promise.all([
        waitForMessage(ws1, (m) => m.type === 'ask_result', 5000),
        waitForMessage(ws2, (m) => m.type === 'ask_result', 5000),
        new Promise((resolve) => {
          setTimeout(() => {
            ws1.send(JSON.stringify({
              type:           'ask_card',
              targetPlayerId: p2Id,
              cardId:         '4_s',
            }));
            resolve();
          }, 50);
        }),
      ]);

      // Both asker (p1) and asked player (p2) must receive the ask_result
      for (const result of [result1, result2]) {
        expect(result.type).toBe('ask_result');
        expect(result.success).toBe(false);
        expect(result.newTurnPlayerId).toBe(p2Id);
      }
    } finally {
      await cleanupConnections(ws1, ws2);
    }
  });

  it('AC 18 (regression): successful ask — turn stays with the asker', async () => {
    // Regression guard: on SUCCESS the asker keeps their turn.
    // We need p1 to ask for a card that p2 holds. p2 holds 1_h 2_h 3_h (low_h).
    // p1 must hold a low_h card to be eligible. Temporarily give p1 a low_h card.
    gs.hands.set(p1Id, new Set(['1_s', '2_s', '3_s', '1_h'])); // add 1_h so p1 can ask for low_h
    // Now p1 asks p2 for 2_h (p2 holds it) → SUCCESS
    const { ws: ws1 } = await waitForInit(`token=${p1Token}`, 'game_init');
    const { ws: ws2 } = await waitForInit(`token=${p2Token}`, 'game_init');

    try {
      const [askResult] = await Promise.all([
        waitForMessage(ws1, (m) => m.type === 'ask_result', 5000),
        new Promise((resolve) => {
          setTimeout(() => {
            ws1.send(JSON.stringify({
              type:           'ask_card',
              targetPlayerId: p2Id,
              cardId:         '2_h', // p2 HOLDS this card → SUCCESS
            }));
            resolve();
          }, 50);
        }),
      ]);

      expect(askResult.type).toBe('ask_result');
      expect(askResult.success).toBe(true);
      // On success, turn stays with asker (p1)
      expect(askResult.newTurnPlayerId).toBe(p1Id);
      expect(askResult.newTurnPlayerId).not.toBe(p2Id);
    } finally {
      await cleanupConnections(ws1, ws2);
    }
  });
});
