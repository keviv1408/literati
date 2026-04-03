'use strict';

/**
 * askCardPrivacy.test.js
 *
 * Tests for Server-side privacy of the card request flow.
 *
 * The "in-progress selection" phase covers the period when an active player
 * opens the AskCardModal, selects a card, and picks a target opponent.
 * During this phase NO WebSocket events are emitted by the client until the
 * player clicks "Ask", which sends a single `ask_card` message.
 *
 * The server MUST enforce the following privacy guarantees:
 *
 * 1. No data about an in-progress selection is broadcast to non-active
 * players or spectators before the `ask_card` message is submitted.
 * Selection state is purely local to the active player's browser.
 *
 * 2. An `ask_card` attempt from a non-active player (wrong turn) returns
 * an error ONLY to the sender — it is NOT broadcast to other clients.
 *
 * 3. A game-action message from a spectator returns a SPECTATOR error ONLY
 * to the spectator — it is NOT broadcast to player connections.
 *
 * 4. Any unrecognised message type (e.g. a hypothetical "ask_preview"
 * snooping event) is rejected with UNKNOWN_TYPE ONLY to the sender.
 *
 * 5. ONLY after a valid `ask_card` is fully validated and applied do
 * `ask_result`, `game_state`, and `game_players` get broadcast to ALL
 * connected clients (active player, non-active players, and spectators).
 *
 * 6. `spectator_init` and subsequent broadcast events sent to spectators
 * contain NO player hands, NO move history, and NO pending-selection
 * fields.
 *
 * 7. `game_init` for a non-active (but authenticated) player contains NO
 * other players' hands, NO move history, and NO selection-state fields.
 */

const http      = require('http');
const express   = require('express');
const WebSocket = require('ws');

// ── Test constants ─────────────────────────────────────────────────────────

const ROOM_CODE     = 'PRVACY';
/** Valid 32-char uppercase hex spectator token */
const SPECTATOR_HEX = 'AABBCCDDEEFF00112233445566778899';

/**
 * Card ask setup (remove_7s variant, low_s half-suit):
 * - p1 (Team 1) holds 1_s 2_s 3_s → can ask for 4_s (same half-suit)
 * - p2 (Team 2) holds 4_s 5_s 6_s → p2 is the target
 */
const ASK_CARD = '4_s'; // p1 requests from p2 — valid ask (p1 holds low_s card)

// ── Supabase mock factory ──────────────────────────────────────────────────

/**
 * Build a minimal Supabase mock that:
 * - auth.getUser: always returns "no user" (forces guest-session path)
 * - from().select().eq().maybeSingle(): returns the room row for spectator
 * token lookup AND for the crash-recovery path (if triggered)
 * - from().update().eq(): resolves silently (for persistGameState)
 * - rpc(): resolves silently (for increment_user_stats — won't be called
 * during asks, but included for completeness)
 */
function buildSupabaseMock() {
  const chain = {};
  chain.select      = jest.fn().mockReturnValue(chain);
  chain.eq          = jest.fn().mockReturnValue(chain);
  chain.update      = jest.fn().mockReturnValue(chain);
  chain.upsert      = jest.fn().mockReturnValue(chain);
  chain.insert      = jest.fn().mockReturnValue(chain);
  chain.maybeSingle = jest.fn().mockResolvedValue({
    data:  { id: 'room-id-prv', code: ROOM_CODE, status: 'in_progress' },
    error: null,
  });

  return {
    from:   jest.fn().mockReturnValue(chain),
    auth:   {
      getUser: jest.fn().mockResolvedValue({ data: { user: null }, error: 'no-user' }),
    },
    rpc:    jest.fn().mockResolvedValue({ data: null, error: null }),
    _chain: chain,
  };
}

// ── Test suite ─────────────────────────────────────────────────────────────

describe('Ask card privacy — server-side enforcement ', () => {
  let httpServer;
  let port;
  let mockSupabase;
  let gameSocketServer;
  let guestSessionStore;
  let clearGameStore;

  /** The live game-state object — mutated directly to reset between tests. */
  let gs;

  /** Guest bearer token for p1 (current-turn player, Team 1). */
  let p1Token;
  /** Stable player ID for p1 (sessionId). */
  let p1Id;

  /** Guest bearer token for p2 (non-active player, Team 2). */
  let p2Token;
  /** Stable player ID for p2 (sessionId). */
  let p2Id;

  // ── beforeAll: set up server, sessions, and game ─────────────────────────
  beforeAll((done) => {
    jest.resetModules();

    mockSupabase = buildSupabaseMock();
    const { _setSupabaseClient } = require('../db/supabase');
    _setSupabaseClient(mockSupabase);

    // Create real guest sessions so resolveUser() authenticates WS connections.
    guestSessionStore = require('../sessions/guestSessionStore');

    const sess1 = guestSessionStore.createGuestSession('Alice');
    p1Token = sess1.token;
    p1Id    = sess1.session.sessionId;

    const sess2 = guestSessionStore.createGuestSession('Bob');
    p2Token = sess2.token;
    p2Id    = sess2.session.sessionId;

    gameSocketServer              = require('../game/gameSocketServer');
    ({ _clearAll: clearGameStore } = require('../game/gameStore'));

    // Build game with deterministic 6-player seating:
    // Seat 0: p1 (Team 1, human — will be the current-turn player)
    // Seat 1: p2 (Team 2, human — non-active)
    // Seats 2-5: bots
    const seats = [
      { seatIndex: 0, playerId: p1Id,    displayName: 'Alice', avatarId: null, teamId: 1, isBot: false, isGuest: true  },
      { seatIndex: 1, playerId: p2Id,    displayName: 'Bob',   avatarId: null, teamId: 2, isBot: false, isGuest: true  },
      { seatIndex: 2, playerId: 'bot-1', displayName: 'Bot1',  avatarId: null, teamId: 1, isBot: true,  isGuest: false },
      { seatIndex: 3, playerId: 'bot-2', displayName: 'Bot2',  avatarId: null, teamId: 2, isBot: true,  isGuest: false },
      { seatIndex: 4, playerId: 'bot-3', displayName: 'Bot3',  avatarId: null, teamId: 1, isBot: true,  isGuest: false },
      { seatIndex: 5, playerId: 'bot-4', displayName: 'Bot4',  avatarId: null, teamId: 2, isBot: true,  isGuest: false },
    ];

    gs = gameSocketServer.createGame({
      roomCode:    ROOM_CODE,
      roomId:      'room-id-prv',
      variant:     'remove_7s',
      playerCount: 6,
      seats,
    });

    // Override hands for deterministic card layout.
    // low_s = 1_s 2_s 3_s 4_s 5_s 6_s (remove_7s variant)
    // p1 holds 1_s 2_s 3_s → can ask for 4_s (same half-suit) from p2
    gs.hands.set(p1Id,    new Set(['1_s', '2_s', '3_s']));
    gs.hands.set(p2Id,    new Set(['4_s', '5_s', '6_s']));
    gs.hands.set('bot-1', new Set(['1_h', '2_h', '3_h']));
    gs.hands.set('bot-2', new Set(['4_h', '5_h', '6_h']));
    gs.hands.set('bot-3', new Set(['1_d', '2_d', '3_d']));
    gs.hands.set('bot-4', new Set(['4_d', '5_d', '6_d']));
    gs.currentTurnPlayerId = p1Id;
    gs.status              = 'active';

    // Start HTTP server with game WS handler.
    const app = express();
    httpServer = http.createServer(app);
    gameSocketServer.attachGameSocketServer(httpServer);

    httpServer.listen(0, () => {
      port = httpServer.address().port;
      done();
    });
  });

  // ── beforeEach: reset mutable game state ──────────────────────────────────
  beforeEach(() => {
    // Restore the hand layout and turn ownership between tests.
    gs.hands.set(p1Id,    new Set(['1_s', '2_s', '3_s']));
    gs.hands.set(p2Id,    new Set(['4_s', '5_s', '6_s']));
    gs.hands.set('bot-1', new Set(['1_h', '2_h', '3_h']));
    gs.hands.set('bot-2', new Set(['4_h', '5_h', '6_h']));
    gs.hands.set('bot-3', new Set(['1_d', '2_d', '3_d']));
    gs.hands.set('bot-4', new Set(['4_d', '5_d', '6_d']));
    gs.currentTurnPlayerId = p1Id;
    gs.status              = 'active';
    gs.lastMove            = null;
    gs.scores              = { team1: 0, team2: 0 };
    gs.winner              = null;
    gs.tiebreakerWinner    = null;
    gs.moveHistory         = [];
    gs.declaredSuits       = new Map();

    // Cancel any lingering human-turn timer to avoid stray broadcasts.
    gameSocketServer.cancelTurnTimer(ROOM_CODE);

    // Refresh Supabase mock resolution for each test.
    mockSupabase._chain.maybeSingle.mockResolvedValue({
      data:  { id: 'room-id-prv', code: ROOM_CODE, status: 'in_progress' },
      error: null,
    });
  });

  // ── afterAll: tear down server ────────────────────────────────────────────
  afterAll((done) => {
    gameSocketServer.cancelTurnTimer(ROOM_CODE);
    if (clearGameStore)    clearGameStore();
    if (guestSessionStore) guestSessionStore._clearStore();
    httpServer.close(done);
    jest.resetModules();
  });

  // ── WS helpers ─────────────────────────────────────────────────────────────

  /**
   * Open a WebSocket to the game endpoint and resolve once the expected init
   * message type is received. Returns { ws, initMsg }.
   *
   * @param {string} queryString e.g. "token=<bearer>" or "spectatorToken=<hex>"
   * @param {string} initType 'game_init' | 'spectator_init'
   * @param {number} [timeoutMs]
   * @returns {Promise<{ws: WebSocket, initMsg: Object}>}
   */
  function waitForInit(queryString, initType = 'game_init', timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const wsUrl = `ws://localhost:${port}/ws/game/${ROOM_CODE}?${queryString}`;
      const ws    = new WebSocket(wsUrl);
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { ws.close(); } catch (_) {}
          reject(new Error(`waitForInit: timed out after ${timeoutMs}ms waiting for '${initType}'`));
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

  /**
   * Wait for the first message matching `predicate` on the given WebSocket.
   * Rejects after `timeoutMs` milliseconds.
   *
   * @param {WebSocket} ws
   * @param {(msg: Object) => boolean} predicate
   * @param {number} [timeoutMs]
   * @returns {Promise<Object>}
   */
  function waitForMessage(ws, predicate, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.off('message', handler);
          reject(new Error(`waitForMessage: timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      const handler = (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (predicate(msg) && !settled) {
          settled = true;
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg);
        }
      };

      ws.on('message', handler);
    });
  }

  /**
   * Collect all messages received by `observerWs` during `windowMs` after
   * `senderWs` sends `payload`.
   *
   * The listener is attached BEFORE the message is sent so there is no race
   * condition between the send and the observer setup.
   *
   * @param {WebSocket} senderWs
   * @param {Object} payload
   * @param {WebSocket} observerWs
   * @param {number} [windowMs]
   * @returns {Promise<Object[]>} All messages observed during the window.
   */
  function sendAndObserve(senderWs, payload, observerWs, windowMs = 300) {
    return new Promise((resolve) => {
      const collected = [];
      const listener  = (raw) => {
        try { collected.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
      };

      // Attach BEFORE sending so no messages can slip through.
      observerWs.on('message', listener);
      senderWs.send(JSON.stringify(payload));

      setTimeout(() => {
        observerWs.off('message', listener);
        resolve(collected);
      }, windowMs);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. NON-ACTIVE PLAYER PRIVACY
  // ─────────────────────────────────────────────────────────────────────────

  it('non-active player ask_card error is NOT broadcast to the active player', async () => {
    const { ws: ws1 } = await waitForInit(`token=${p1Token}`, 'game_init');
    const { ws: ws2 } = await waitForInit(`token=${p2Token}`, 'game_init');

    try {
      // Set up observer on p1 BEFORE p2 sends its (invalid) message.
      const p1Observed = [];
      const p1Observer = (raw) => {
        try { p1Observed.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
      };
      ws1.on('message', p1Observer);

      // p2 (not their turn) attempts to ask — server must reject with NOT_YOUR_TURN.
      ws2.send(JSON.stringify({ type: 'ask_card', targetPlayerId: p1Id, cardId: '1_s' }));

      // Wait for p2 to receive its private error.
      const p2Error = await waitForMessage(ws2, (m) => m.type === 'error', 3000);

      // Wait a short window to detect any spurious broadcast to p1.
      await new Promise((r) => setTimeout(r, 150));

      ws1.off('message', p1Observer);

      // p2 must receive NOT_YOUR_TURN (not another player).
      expect(p2Error.type).toBe('error');
      expect(p2Error.code).toBe('NOT_YOUR_TURN');

      // p1 must NOT have received any error or selection-related event.
      // Legitimate broadcasts (turn_timer, game_state) are explicitly excluded.
      const privacyLeaks = p1Observed.filter(
        (m) => m.type === 'error',
      );
      expect(privacyLeaks).toHaveLength(0);
    } finally {
      ws1.close();
      ws2.close();
    }
  });

  it('non-active player ask_card error uses correct error code (NOT_YOUR_TURN)', async () => {
    const { ws: ws2 } = await waitForInit(`token=${p2Token}`, 'game_init');

    try {
      ws2.send(JSON.stringify({ type: 'ask_card', targetPlayerId: p1Id, cardId: '1_s' }));

      const p2Error = await waitForMessage(ws2, (m) => m.type === 'error', 3000);

      expect(p2Error.code).toBe('NOT_YOUR_TURN');
      expect(p2Error.message).toBeDefined();
    } finally {
      ws2.close();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. SPECTATOR PRIVACY
  // ─────────────────────────────────────────────────────────────────────────

  it('spectator ask_card attempt returns SPECTATOR error ONLY to spectator', async () => {
    const { ws: spectWs } = await waitForInit(
      `spectatorToken=${SPECTATOR_HEX}`,
      'spectator_init',
    );
    const { ws: ws1 } = await waitForInit(`token=${p1Token}`, 'game_init');

    try {
      // Observe p1's messages for the window period.
      const [spectError, p1Observed] = await Promise.all([
        waitForMessage(spectWs, (m) => m.type === 'error', 3000),
        sendAndObserve(
          spectWs,
          { type: 'ask_card', targetPlayerId: p2Id, cardId: ASK_CARD },
          ws1,
          300,
        ),
      ]);

      // Spectator receives the SPECTATOR error.
      expect(spectError.type).toBe('error');
      expect(spectError.code).toBe('SPECTATOR');

      // p1 must NOT have received any error from the spectator's attempt.
      const leaks = p1Observed.filter((m) => m.type === 'error');
      expect(leaks).toHaveLength(0);
    } finally {
      spectWs.close();
      ws1.close();
    }
  });

  it('spectator declare_suit attempt returns SPECTATOR error ONLY to spectator', async () => {
    const { ws: spectWs } = await waitForInit(
      `spectatorToken=${SPECTATOR_HEX}`,
      'spectator_init',
    );
    const { ws: ws1 } = await waitForInit(`token=${p1Token}`, 'game_init');

    try {
      const [spectError, p1Observed] = await Promise.all([
        waitForMessage(spectWs, (m) => m.type === 'error', 3000),
        sendAndObserve(
          spectWs,
          {
            type:       'declare_suit',
            halfSuitId: 'low_s',
            assignment: { '1_s': p1Id, '2_s': p1Id, '3_s': p1Id, '4_s': p2Id, '5_s': p2Id, '6_s': p2Id },
          },
          ws1,
          300,
        ),
      ]);

      expect(spectError.code).toBe('SPECTATOR');
      const leaks = p1Observed.filter((m) => m.type === 'error');
      expect(leaks).toHaveLength(0);
    } finally {
      spectWs.close();
      ws1.close();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. UNKNOWN / PREVIEW MESSAGE TYPE PRIVACY
  // ─────────────────────────────────────────────────────────────────────────

  it('unknown "ask_preview" message is rejected ONLY to sender (UNKNOWN_TYPE)', async () => {
    const { ws: ws1 } = await waitForInit(`token=${p1Token}`, 'game_init');
    const { ws: ws2 } = await waitForInit(`token=${p2Token}`, 'game_init');

    try {
      // Observe p1 while p2 sends an undocumented preview-style message.
      const p1Observed = [];
      const p1Observer = (raw) => {
        try { p1Observed.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
      };
      ws1.on('message', p1Observer);

      ws2.send(JSON.stringify({ type: 'ask_preview', cardId: ASK_CARD, targetPlayerId: p1Id }));

      // Wait for p2 to receive UNKNOWN_TYPE error.
      const p2Error = await waitForMessage(ws2, (m) => m.type === 'error', 3000);

      await new Promise((r) => setTimeout(r, 150));
      ws1.off('message', p1Observer);

      expect(p2Error.type).toBe('error');
      expect(p2Error.code).toBe('UNKNOWN_TYPE');

      // p1 must NOT see any error from p2's preview attempt.
      const leaks = p1Observed.filter((m) => m.type === 'error');
      expect(leaks).toHaveLength(0);
    } finally {
      ws1.close();
      ws2.close();
    }
  });

  it('unknown "declare_preview" message is rejected ONLY to sender', async () => {
    const { ws: ws1 } = await waitForInit(`token=${p1Token}`, 'game_init');
    const { ws: ws2 } = await waitForInit(`token=${p2Token}`, 'game_init');

    try {
      const [p2Error, p1Observed] = await Promise.all([
        waitForMessage(ws2, (m) => m.type === 'error', 3000),
        sendAndObserve(ws2, { type: 'declare_preview', halfSuitId: 'low_s' }, ws1, 300),
      ]);

      expect(p2Error.code).toBe('UNKNOWN_TYPE');
      expect(p1Observed.filter((m) => m.type === 'error')).toHaveLength(0);
    } finally {
      ws1.close();
      ws2.close();
    }
  });

  it('unknown "card_hover" message is rejected ONLY to sender', async () => {
    const { ws: ws2 } = await waitForInit(`token=${p2Token}`, 'game_init');
    const { ws: ws1 } = await waitForInit(`token=${p1Token}`, 'game_init');

    try {
      const [p2Error, p1Observed] = await Promise.all([
        waitForMessage(ws2, (m) => m.type === 'error', 3000),
        sendAndObserve(ws2, { type: 'card_hover', cardId: ASK_CARD }, ws1, 300),
      ]);

      expect(p2Error.code).toBe('UNKNOWN_TYPE');
      expect(p1Observed.filter((m) => m.type === 'error')).toHaveLength(0);
    } finally {
      ws2.close();
      ws1.close();
    }
  });

  it('unknown "selection_update" message is rejected ONLY to sender', async () => {
    const { ws: ws2 } = await waitForInit(`token=${p2Token}`, 'game_init');
    const { ws: ws1 } = await waitForInit(`token=${p1Token}`, 'game_init');

    try {
      const [p2Error, p1Observed] = await Promise.all([
        waitForMessage(ws2, (m) => m.type === 'error', 3000),
        sendAndObserve(ws2, { type: 'selection_update', state: {} }, ws1, 300),
      ]);

      expect(p2Error.code).toBe('UNKNOWN_TYPE');
      expect(p1Observed.filter((m) => m.type === 'error')).toHaveLength(0);
    } finally {
      ws2.close();
      ws1.close();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. VALID ASK BROADCASTS TO ALL CLIENTS
  // ─────────────────────────────────────────────────────────────────────────

  it('valid ask_card by active player broadcasts ask_result to all connected clients', async () => {
    const { ws: ws1 }    = await waitForInit(`token=${p1Token}`, 'game_init');
    const { ws: ws2 }    = await waitForInit(`token=${p2Token}`, 'game_init');
    const { ws: spectWs } = await waitForInit(
      `spectatorToken=${SPECTATOR_HEX}`,
      'spectator_init',
    );

    try {
      const [result1, result2, resultSpect] = await Promise.all([
        waitForMessage(ws1,    (m) => m.type === 'ask_result', 5000),
        waitForMessage(ws2,    (m) => m.type === 'ask_result', 5000),
        waitForMessage(spectWs, (m) => m.type === 'ask_result', 5000),
        // Send the ask slightly after all listeners are registered.
        new Promise((resolve) => {
          setTimeout(() => {
            ws1.send(JSON.stringify({
              type:           'ask_card',
              targetPlayerId: p2Id,
              cardId:         ASK_CARD,
              batchCardIds:   [ASK_CARD, '5_s'],
            }));
            resolve();
          }, 50);
        }),
      ]);

      // All three clients must receive the same ask_result broadcast.
      for (const result of [result1, result2, resultSpect]) {
        expect(result.type).toBe('ask_result');
        expect(result.askerId).toBe(p1Id);
        expect(result.targetId).toBe(p2Id);
        expect(result.cardId).toBe(ASK_CARD);
        expect(result.batchCardIds).toEqual([ASK_CARD, '5_s']);
        expect(result.botAskNarration).toBeUndefined();
        expect(typeof result.success).toBe('boolean');
        expect(result.newTurnPlayerId).toBeDefined();
        expect(result.lastMove).toBeDefined();
      }
    } finally {
      gameSocketServer.cancelTurnTimer(ROOM_CODE);
      ws1.close();
      ws2.close();
      spectWs.close();
    }
  });

  it('valid ask_card broadcasts game_state and game_players to all clients', async () => {
    const { ws: ws1 }    = await waitForInit(`token=${p1Token}`, 'game_init');
    const { ws: ws2 }    = await waitForInit(`token=${p2Token}`, 'game_init');
    const { ws: spectWs } = await waitForInit(
      `spectatorToken=${SPECTATOR_HEX}`,
      'spectator_init',
    );

    try {
      // After a valid ask, each client receives ask_result + game_state + game_players.
      const [gs1, gs2, gsSpect] = await Promise.all([
        waitForMessage(ws1,     (m) => m.type === 'game_state', 5000),
        waitForMessage(ws2,     (m) => m.type === 'game_state', 5000),
        waitForMessage(spectWs, (m) => m.type === 'game_state', 5000),
        new Promise((resolve) => {
          setTimeout(() => {
            ws1.send(JSON.stringify({
              type:           'ask_card',
              targetPlayerId: p2Id,
              cardId:         ASK_CARD,
            }));
            resolve();
          }, 50);
        }),
      ]);

      // All clients receive the same public state (no private data).
      for (const gsMsg of [gs1, gs2, gsSpect]) {
        expect(gsMsg.type).toBe('game_state');
        expect(gsMsg.state).toBeDefined();
        expect(gsMsg.state.currentTurnPlayerId).toBeDefined();
        expect(gsMsg.state.scores).toBeDefined();
        // Private fields MUST be absent.
        expect(gsMsg.state.hands).toBeUndefined();
        expect(gsMsg.state.botKnowledge).toBeUndefined();
        expect(gsMsg.state.moveHistory).toBeUndefined();
      }
    } finally {
      gameSocketServer.cancelTurnTimer(ROOM_CODE);
      ws1.close();
      ws2.close();
      spectWs.close();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. SPECTATOR_INIT EXCLUDES PRIVATE STATE BUT INCLUDES GOD-MODE HAND MAP
  // ─────────────────────────────────────────────────────────────────────────

  it('spectator_init.gameState contains no player hands, no move history, no selection state', async () => {
    const { ws: spectWs, initMsg } = await waitForInit(
      `spectatorToken=${SPECTATOR_HEX}`,
      'spectator_init',
    );

    try {
      const { gameState } = initMsg;
      expect(gameState).toBeDefined();

      // Required public fields.
      expect(gameState.status).toBeDefined();
      expect(gameState.currentTurnPlayerId).toBeDefined();
      expect(gameState.scores).toBeDefined();
      expect(Array.isArray(gameState.declaredSuits)).toBe(true);

      // Private fields MUST be absent.
      expect(gameState.hands).toBeUndefined();
      expect(gameState.botKnowledge).toBeUndefined();
      expect(gameState.moveHistory).toBeUndefined();

      // Selection-state fields MUST NOT exist (would be a privacy leak).
      expect(gameState.pendingAsk).toBeUndefined();
      expect(gameState.activeSelection).toBeUndefined();
      expect(gameState.currentSelection).toBeUndefined();
      expect(initMsg.pendingAsk).toBeUndefined();
      expect(initMsg.activeSelection).toBeUndefined();
    } finally {
      spectWs.close();
    }
  });

  it('spectator_init.players has cardCount but no actual hand data', async () => {
    const { ws: spectWs, initMsg } = await waitForInit(
      `spectatorToken=${SPECTATOR_HEX}`,
      'spectator_init',
    );

    try {
      expect(Array.isArray(initMsg.players)).toBe(true);
      expect(initMsg.players.length).toBeGreaterThan(0);

      for (const player of initMsg.players) {
        // Card count (public info) must be present.
        expect(typeof player.cardCount).toBe('number');
        // Actual card data (private) must be absent.
        expect(player.hand).toBeUndefined();
        expect(player.cards).toBeUndefined();
        expect(player.handData).toBeUndefined();
      }
    } finally {
      spectWs.close();
    }
  });

  it('spectator_init includes a spectator-only hand map for God mode', async () => {
    const { ws: spectWs, initMsg } = await waitForInit(
      `spectatorToken=${SPECTATOR_HEX}`,
      'spectator_init',
    );

    try {
      expect(initMsg.hands).toBeDefined();
      expect(typeof initMsg.hands).toBe('object');

      for (const player of initMsg.players) {
        expect(Array.isArray(initMsg.hands[player.playerId])).toBe(true);
        expect(initMsg.hands[player.playerId].length).toBe(player.cardCount);
      }
    } finally {
      spectWs.close();
    }
  });

  it('spectator_init includes a spectator-only formatted move log for God mode', async () => {
    const { ws: spectWs, initMsg } = await waitForInit(
      `spectatorToken=${SPECTATOR_HEX}`,
      'spectator_init',
    );

    try {
      expect(Array.isArray(initMsg.moveHistory)).toBe(true);
      for (const move of initMsg.moveHistory) {
        expect(typeof move.type).toBe('string');
        expect(typeof move.ts).toBe('number');
        expect(typeof move.message).toBe('string');
      }
    } finally {
      spectWs.close();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. GAME_INIT FOR NON-ACTIVE PLAYER CONTAINS NO SELECTION STATE
  // ─────────────────────────────────────────────────────────────────────────

  it('game_init for non-active player contains only their own hand (not others)', async () => {
    const { ws: ws2, initMsg } = await waitForInit(`token=${p2Token}`, 'game_init');

    try {
      // p2 receives their own hand.
      expect(Array.isArray(initMsg.myHand)).toBe(true);
      expect(initMsg.myPlayerId).toBe(p2Id);

      // No selection-state or pending-ask fields.
      expect(initMsg.pendingAsk).toBeUndefined();
      expect(initMsg.activeSelection).toBeUndefined();
      expect(initMsg.currentSelection).toBeUndefined();

      const { gameState } = initMsg;
      if (gameState) {
        // Public state present; private state absent.
        expect(gameState.hands).toBeUndefined();
        expect(gameState.botKnowledge).toBeUndefined();
        expect(gameState.moveHistory).toBeUndefined();
        expect(gameState.pendingAsk).toBeUndefined();
        expect(gameState.activeSelection).toBeUndefined();
      }

      // The serialized player list must not include other players' hands.
      for (const player of (initMsg.players ?? [])) {
        expect(player.hand).toBeUndefined();
        expect(player.cards).toBeUndefined();
      }
    } finally {
      ws2.close();
    }
  });

  it('game_init for active player contains only their own hand (not others)', async () => {
    const { ws: ws1, initMsg } = await waitForInit(`token=${p1Token}`, 'game_init');

    try {
      expect(Array.isArray(initMsg.myHand)).toBe(true);
      // p1's hand must match the cards we assigned.
      expect(new Set(initMsg.myHand)).toEqual(new Set(['1_s', '2_s', '3_s']));
      expect(initMsg.myPlayerId).toBe(p1Id);

      // No selection-state fields on game_init.
      expect(initMsg.pendingAsk).toBeUndefined();
      expect(initMsg.activeSelection).toBeUndefined();

      // Player list: card counts only, no raw hand data.
      for (const player of (initMsg.players ?? [])) {
        if (player.playerId !== p1Id) {
          // Other players' hands must NOT be in the player list.
          expect(player.hand).toBeUndefined();
          expect(player.cards).toBeUndefined();
        }
        // cardCount (public info) should be present for all.
        expect(typeof player.cardCount).toBe('number');
      }
    } finally {
      gameSocketServer.cancelTurnTimer(ROOM_CODE);
      ws1.close();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7. HAND_UPDATE PRIVACY — only changed players receive their new hand
  // ─────────────────────────────────────────────────────────────────────────

  it('hand_update is sent only to players whose hand changed (not to uninvolved players)', async () => {
    const { ws: ws1 }    = await waitForInit(`token=${p1Token}`, 'game_init');
    const { ws: ws2 }    = await waitForInit(`token=${p2Token}`, 'game_init');
    const { ws: spectWs } = await waitForInit(
      `spectatorToken=${SPECTATOR_HEX}`,
      'spectator_init',
    );

    // In our hand layout:
    // bot-1 (Team 1) has cards; bot-3 (Team 1) also has cards
    // p1 asks p2 → hands that change: p1 and p2
    // bot-1, bot-3 (team-mates of p1) should NOT receive hand_update
    // spectator should NOT receive hand_update

    // We cannot directly test bot connections (they are not WebSocket clients),
    // so we verify that the spectator does NOT receive a hand_update.
    const spectHandUpdates = [];
    const spectObserver = (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'hand_update') spectHandUpdates.push(m);
      } catch { /* ignore */ }
    };
    spectWs.on('message', spectObserver);

    try {
      // Trigger a valid ask to cause hand_update messages.
      await Promise.all([
        waitForMessage(ws1, (m) => m.type === 'ask_result', 5000),
        new Promise((resolve) => {
          setTimeout(() => {
            ws1.send(JSON.stringify({
              type:           'ask_card',
              targetPlayerId: p2Id,
              cardId:         ASK_CARD,
            }));
            resolve();
          }, 50);
        }),
      ]);

      // Wait a short window for any stray hand_update to the spectator.
      await new Promise((r) => setTimeout(r, 200));

      spectWs.off('message', spectObserver);

      // Spectator must NOT receive hand_update (hand data is private).
      expect(spectHandUpdates).toHaveLength(0);
    } finally {
      gameSocketServer.cancelTurnTimer(ROOM_CODE);
      ws1.close();
      ws2.close();
      spectWs.close();
    }
  });

  it('the active player receives hand_update when their hand changes', async () => {
    const { ws: ws1 } = await waitForInit(`token=${p1Token}`, 'game_init');
    const { ws: ws2 } = await waitForInit(`token=${p2Token}`, 'game_init');

    try {
      // p1 asks p2 for ASK_CARD ('4_s') which p2 holds → success, card transfers to p1.
      const [handUpdate] = await Promise.all([
        waitForMessage(ws1, (m) => m.type === 'hand_update', 5000),
        new Promise((resolve) => {
          setTimeout(() => {
            ws1.send(JSON.stringify({
              type:           'ask_card',
              targetPlayerId: p2Id,
              cardId:         ASK_CARD,
            }));
            resolve();
          }, 50);
        }),
      ]);

      // p1's hand now includes ASK_CARD.
      expect(handUpdate.type).toBe('hand_update');
      expect(Array.isArray(handUpdate.hand)).toBe(true);
      expect(handUpdate.hand).toContain(ASK_CARD);
    } finally {
      gameSocketServer.cancelTurnTimer(ROOM_CODE);
      ws1.close();
      ws2.close();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 8. INVALID ASK FIELDS — partial/malformed asks stay private
  // ─────────────────────────────────────────────────────────────────────────

  it('ask_card with missing fields returns error ONLY to sender', async () => {
    const { ws: ws1 } = await waitForInit(`token=${p1Token}`, 'game_init');
    const { ws: ws2 } = await waitForInit(`token=${p2Token}`, 'game_init');

    try {
      const p1Observed = [];
      const p1Observer = (raw) => {
        try { p1Observed.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
      };
      ws1.on('message', p1Observer);

      // p2 sends an ask_card with missing fields.
      ws2.send(JSON.stringify({ type: 'ask_card' /* missing targetPlayerId and cardId */ }));

      const p2Error = await waitForMessage(ws2, (m) => m.type === 'error', 3000);
      await new Promise((r) => setTimeout(r, 150));
      ws1.off('message', p1Observer);

      expect(p2Error.type).toBe('error');
      // Error should be MISSING_FIELDS or NOT_YOUR_TURN (both are private).
      expect(['MISSING_FIELDS', 'NOT_YOUR_TURN']).toContain(p2Error.code);

      // p1 must not receive any error.
      expect(p1Observed.filter((m) => m.type === 'error')).toHaveLength(0);
    } finally {
      ws1.close();
      ws2.close();
    }
  });

  it('ask for a card the active player already holds returns error ONLY to sender', async () => {
    // p1 tries to ask for 1_s which p1 already holds — ALREADY_HELD.
    const { ws: ws1 } = await waitForInit(`token=${p1Token}`, 'game_init');
    const { ws: ws2 } = await waitForInit(`token=${p2Token}`, 'game_init');

    try {
      const p2Observed = [];
      const p2Observer = (raw) => {
        try { p2Observed.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
      };
      ws2.on('message', p2Observer);

      // p1 asks for their own card — server should return ALREADY_HELD.
      ws1.send(JSON.stringify({
        type:           'ask_card',
        targetPlayerId: p2Id,
        cardId:         '1_s', // p1 already holds this
      }));

      const p1Error = await waitForMessage(ws1, (m) => m.type === 'error', 3000);
      await new Promise((r) => setTimeout(r, 150));
      ws2.off('message', p2Observer);

      expect(p1Error.type).toBe('error');
      expect(p1Error.code).toBe('ALREADY_HELD');

      // p2 must NOT have received any error from p1's invalid attempt.
      expect(p2Observed.filter((m) => m.type === 'error')).toHaveLength(0);
    } finally {
      ws1.close();
      ws2.close();
    }
  });

  it('ask for a teammate (same team) returns error ONLY to sender', async () => {
    // p1 (Team 1) tries to ask bot-1 (also Team 1) — SAME_TEAM error.
    const { ws: ws1 } = await waitForInit(`token=${p1Token}`, 'game_init');
    const { ws: ws2 } = await waitForInit(`token=${p2Token}`, 'game_init');

    try {
      const p2Observed = [];
      const p2Observer = (raw) => {
        try { p2Observed.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
      };
      ws2.on('message', p2Observer);

      ws1.send(JSON.stringify({
        type:           'ask_card',
        targetPlayerId: 'bot-1', // same team as p1
        cardId:         ASK_CARD,
      }));

      const p1Error = await waitForMessage(ws1, (m) => m.type === 'error', 3000);
      await new Promise((r) => setTimeout(r, 150));
      ws2.off('message', p2Observer);

      expect(p1Error.type).toBe('error');
      expect(p1Error.code).toBe('SAME_TEAM');

      // p2 must NOT have received any error from p1's invalid attempt.
      expect(p2Observed.filter((m) => m.type === 'error')).toHaveLength(0);
    } finally {
      ws1.close();
      ws2.close();
    }
  });
});
