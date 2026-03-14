'use strict';

/**
 * declareSelectingPrivacy.test.js
 *
 * Tests for Sub-AC 21a: Private half-suit selection phase.
 *
 * When the active player opens DeclareModal and picks a half-suit in Step 1
 * (the suit picker), the client sends a `declare_selecting` message to the
 * server.  The server MUST:
 *
 *   1. Accept `declare_selecting` silently (no response, no broadcast).
 *   2. Store the selected half-suit ONLY in `_declarationSelections` — a
 *      private server-side map that is NEVER forwarded to other players.
 *   3. Ignore `declare_selecting` from non-active players.
 *   4. Clear `_declarationSelections` when the turn ends.
 *   5. NOT include the declaration suit in the `bot_takeover` broadcast
 *      (privacy guarantee: other players don't learn which suit is being
 *      declared until the final `declare_suit` is confirmed).
 *   6. Use `_declarationSelections` as fallback in bot-takeover logic so
 *      the bot can continue the same declaration the player started.
 *   7. NOT broadcast `declare_selecting` to other connected players.
 *   8. NOT broadcast `declare_selecting` to spectators.
 */

const http      = require('http');
const express   = require('express');
const WebSocket = require('ws');

// ── Test constants ─────────────────────────────────────────────────────────

const ROOM_CODE     = 'PRIVDS';
const SPECTATOR_HEX = 'AABBCCDDEEFF00112233445566778800';

/**
 * Card layout (remove_7s, low_s half-suit):
 *   low_s  = 1_s 2_s 3_s 4_s 5_s 6_s
 *   high_s = 8_s 9_s 10_s 11_s 12_s 13_s
 *
 *   p1 (Team 1) holds: 1_s 2_s 3_s → can declare low_s
 *   p2 (Team 2) holds: 4_s 5_s 6_s
 */

// ── Supabase mock ──────────────────────────────────────────────────────────

function buildSupabaseMock() {
  const chain = {};
  chain.select      = jest.fn().mockReturnValue(chain);
  chain.eq          = jest.fn().mockReturnValue(chain);
  chain.update      = jest.fn().mockReturnValue(chain);
  chain.upsert      = jest.fn().mockResolvedValue({ data: null, error: null });
  chain.insert      = jest.fn().mockReturnValue(chain);
  chain.maybeSingle = jest.fn().mockResolvedValue({
    data:  { id: 'room-id-ds', code: ROOM_CODE, status: 'in_progress', spectator_token: SPECTATOR_HEX },
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

// ── Suite ──────────────────────────────────────────────────────────────────

describe('declare_selecting — private suit selection (Sub-AC 21a)', () => {
  let httpServer;
  let port;
  let mockSupabase;
  let gameSocketServer;
  let guestSessionStore;
  let clearGameStore;

  let gs;         // live game-state object
  let p1Token;    // bearer for active player (Team 1)
  let p1Id;
  let p2Token;    // bearer for non-active player (Team 2)
  let p2Id;

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

    gameSocketServer              = require('../game/gameSocketServer');
    ({ _clearAll: clearGameStore } = require('../game/gameStore'));

    // Build 6-player game:
    //   p1 (Team 1, seat 0) — current turn holder
    //   p2 (Team 2, seat 1)
    //   4 bots filling remaining seats
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
      roomId:      'room-id-ds',
      variant:     'remove_7s',
      playerCount: 6,
      seats,
    });

    // Deterministic hand layout:
    //   low_s (remove_7s) = 1_s 2_s 3_s 4_s 5_s 6_s
    //   p1 holds 3 cards from low_s → can declare low_s
    gs.hands.set(p1Id,    new Set(['1_s', '2_s', '3_s']));
    gs.hands.set(p2Id,    new Set(['4_s', '5_s', '6_s']));
    gs.hands.set('bot-1', new Set(['1_h', '2_h', '3_h']));
    gs.hands.set('bot-2', new Set(['4_h', '5_h', '6_h']));
    gs.hands.set('bot-3', new Set(['1_d', '2_d', '3_d']));
    gs.hands.set('bot-4', new Set(['4_d', '5_d', '6_d']));
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

  // ── beforeEach: reset mutable state ─────────────────────────────────────
  beforeEach(() => {
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

    // Clear any stored declaration selections between tests
    gameSocketServer._declarationSelections.clear();
    gameSocketServer.cancelTurnTimer(ROOM_CODE);

    mockSupabase._chain.maybeSingle.mockResolvedValue({
      data:  { id: 'room-id-ds', code: ROOM_CODE, status: 'in_progress', spectator_token: SPECTATOR_HEX },
      error: null,
    });
  });

  // ── afterAll ──────────────────────────────────────────────────────────────
  afterAll((done) => {
    gameSocketServer.cancelTurnTimer(ROOM_CODE);
    if (clearGameStore)    clearGameStore();
    if (guestSessionStore) guestSessionStore._clearStore();
    httpServer.close(done);
    jest.resetModules();
  });

  // ── WS helpers ──────────────────────────────────────────────────────────

  function waitForInit(queryString, initType = 'game_init', timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const wsUrl = `ws://localhost:${port}/ws/game/${ROOM_CODE}?${queryString}`;
      const ws    = new WebSocket(wsUrl);
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { ws.close(); } catch (_) {}
          reject(new Error(`waitForInit timed out waiting for '${initType}'`));
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
          reject(new Error(`WS closed (${code}) before '${initType}'`));
        }
      });
    });
  }

  function waitForMessage(ws, predicate, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.off('message', handler);
          reject(new Error(`waitForMessage timed out after ${timeoutMs}ms`));
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

  function collectMessages(ws, windowMs = 300) {
    return new Promise((resolve) => {
      const collected = [];
      const handler = (raw) => {
        try { collected.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
      };
      ws.on('message', handler);
      setTimeout(() => {
        ws.off('message', handler);
        resolve(collected);
      }, windowMs);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. SERVER-SIDE PRIVACY — no broadcast on declare_selecting
  // ═══════════════════════════════════════════════════════════════════════════

  it('declare_selecting from active player is accepted silently — no response to sender', async () => {
    const { ws: ws1 } = await waitForInit(`token=${p1Token}`, 'game_init');

    try {
      const messages = collectMessages(ws1, 400);

      ws1.send(JSON.stringify({ type: 'declare_selecting', halfSuitId: 'low_s' }));

      const received = await messages;

      // Sender should receive NO response (not even an ack or error)
      const responseMessages = received.filter(
        (m) => m.type !== 'turn_timer' && m.type !== 'game_state' && m.type !== 'game_players'
      );
      expect(responseMessages).toHaveLength(0);
    } finally {
      ws1.close();
    }
  });

  it('declare_selecting is NOT broadcast to other connected players', async () => {
    const { ws: ws1 } = await waitForInit(`token=${p1Token}`, 'game_init');
    const { ws: ws2 } = await waitForInit(`token=${p2Token}`, 'game_init');

    try {
      const p2Messages = collectMessages(ws2, 400);

      ws1.send(JSON.stringify({ type: 'declare_selecting', halfSuitId: 'low_s' }));

      const received = await p2Messages;

      // p2 must receive NO message related to p1's suit selection
      const leaks = received.filter(
        (m) => m.type === 'declare_selecting'
          || m.type === 'declare_suit_selected'
          || (typeof m.halfSuitId === 'string' && m.halfSuitId === 'low_s')
      );
      expect(leaks).toHaveLength(0);
    } finally {
      ws1.close();
      ws2.close();
    }
  });

  it('declare_selecting is NOT broadcast to spectators', async () => {
    const { ws: ws1 }    = await waitForInit(`token=${p1Token}`, 'game_init');
    const { ws: spectWs } = await waitForInit(`spectatorToken=${SPECTATOR_HEX}`, 'spectator_init');

    try {
      const spectMessages = collectMessages(spectWs, 400);

      ws1.send(JSON.stringify({ type: 'declare_selecting', halfSuitId: 'low_s' }));

      const received = await spectMessages;

      // Spectator must receive NO message exposing the suit selection
      const leaks = received.filter(
        (m) => m.type === 'declare_selecting'
          || m.type === 'declare_suit_selected'
          || (typeof m.halfSuitId === 'string' && m.halfSuitId === 'low_s')
      );
      expect(leaks).toHaveLength(0);
    } finally {
      ws1.close();
      spectWs.close();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. SERVER-SIDE STATE — _declarationSelections map
  // ═══════════════════════════════════════════════════════════════════════════

  it('handleDeclareSelecting stores halfSuitId in _declarationSelections for active player', () => {
    gameSocketServer.handleDeclareSelecting(ROOM_CODE, p1Id, 'low_s');

    const stored = gameSocketServer._declarationSelections.get(`${ROOM_CODE}:${p1Id}`);
    expect(stored).toEqual({ halfSuitId: 'low_s' });
  });

  it('handleDeclareSelecting is a no-op for non-active player', () => {
    gameSocketServer.handleDeclareSelecting(ROOM_CODE, p2Id, 'low_s');

    const stored = gameSocketServer._declarationSelections.get(`${ROOM_CODE}:${p2Id}`);
    expect(stored).toBeUndefined();
  });

  it('handleDeclareSelecting clears stored selection when halfSuitId is null', () => {
    // First store a selection
    gameSocketServer.handleDeclareSelecting(ROOM_CODE, p1Id, 'low_s');
    expect(gameSocketServer._declarationSelections.has(`${ROOM_CODE}:${p1Id}`)).toBe(true);

    // Then clear it
    gameSocketServer.handleDeclareSelecting(ROOM_CODE, p1Id, null);
    expect(gameSocketServer._declarationSelections.has(`${ROOM_CODE}:${p1Id}`)).toBe(false);
  });

  it('handleDeclareSelecting clears stored selection when halfSuitId is undefined', () => {
    gameSocketServer.handleDeclareSelecting(ROOM_CODE, p1Id, 'low_s');
    gameSocketServer.handleDeclareSelecting(ROOM_CODE, p1Id, undefined);

    expect(gameSocketServer._declarationSelections.has(`${ROOM_CODE}:${p1Id}`)).toBe(false);
  });

  it('_declarationSelections is cleared when a valid declaration is submitted', async () => {
    // Pre-store a declaration selection
    gameSocketServer.handleDeclareSelecting(ROOM_CODE, p1Id, 'low_s');
    expect(gameSocketServer._declarationSelections.has(`${ROOM_CODE}:${p1Id}`)).toBe(true);

    // Submit a valid declaration — ALL cards must be assigned to Team 1 players
    // (p2Id is on Team 2; assigning to opponents fails CROSS_TEAM_ASSIGN validation).
    // bot-1 and bot-3 are on Team 1 (seats 2 and 4).
    const assignment = {
      '1_s': p1Id,    '2_s': p1Id,    '3_s': p1Id,
      '4_s': 'bot-1', '5_s': 'bot-1', '6_s': 'bot-3',
    };
    await gameSocketServer.handleDeclare(ROOM_CODE, p1Id, 'low_s', assignment, null, false);

    // Declaration selection must be cleared
    expect(gameSocketServer._declarationSelections.has(`${ROOM_CODE}:${p1Id}`)).toBe(false);
  });

  it('_declarationSelections is cleared when a valid ask is submitted', async () => {
    // Active player (p1) had stored a declaration selection before switching to ask
    gameSocketServer.handleDeclareSelecting(ROOM_CODE, p1Id, 'low_s');
    expect(gameSocketServer._declarationSelections.has(`${ROOM_CODE}:${p1Id}`)).toBe(true);

    // p1 asks p2 for 4_s (valid ask — p1 holds low_s cards)
    await gameSocketServer.handleAskCard(ROOM_CODE, p1Id, p2Id, '4_s', null, false);

    // Declaration selection must be cleared
    expect(gameSocketServer._declarationSelections.has(`${ROOM_CODE}:${p1Id}`)).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. BOT_TAKEOVER PRIVACY — halfSuitId NOT in broadcast
  // ═══════════════════════════════════════════════════════════════════════════

  it('sanitizePartialStateForBroadcast returns null when partialState is null', () => {
    const result = gameSocketServer.sanitizePartialStateForBroadcast(null);
    expect(result).toBeNull();
  });

  it('sanitizePartialStateForBroadcast redacts halfSuitId and assignment for declare flow', () => {
    const partial = { flow: 'declare', halfSuitId: 'low_s', assignment: { '1_s': p1Id } };
    const result  = gameSocketServer.sanitizePartialStateForBroadcast(partial);

    // Only the flow field is preserved — halfSuitId and assignment are redacted
    expect(result).toEqual({ flow: 'declare' });
    expect(result.halfSuitId).toBeUndefined();
    expect(result.assignment).toBeUndefined();
  });

  it('sanitizePartialStateForBroadcast keeps halfSuitId and cardId for ask flow', () => {
    const partial = { flow: 'ask', halfSuitId: 'low_s', cardId: '4_s' };
    const result  = gameSocketServer.sanitizePartialStateForBroadcast(partial);

    // Ask flow is safe to broadcast as-is
    expect(result).toEqual({ flow: 'ask', halfSuitId: 'low_s', cardId: '4_s' });
  });

  it('bot_takeover broadcast does NOT include halfSuitId from declaration context', async () => {
    const { ws: ws1 } = await waitForInit(`token=${p1Token}`, 'game_init');
    const { ws: ws2 } = await waitForInit(`token=${p2Token}`, 'game_init');

    try {
      // p1 sends declare_selecting (stored privately, should not appear in bot_takeover)
      gameSocketServer.handleDeclareSelecting(ROOM_CODE, p1Id, 'low_s');

      // Also store a declare-flow partial selection (Step 2 in progress)
      const { setPartialSelection } = require('../game/partialSelectionStore');
      setPartialSelection(ROOM_CODE, p1Id, {
        flow:       'declare',
        halfSuitId: 'low_s',
        assignment: { '1_s': p1Id, '2_s': p1Id, '3_s': p1Id },
      });

      // Both p1 and p2 listen for bot_takeover
      const [takeover1, takeover2] = await Promise.all([
        waitForMessage(ws1, (m) => m.type === 'bot_takeover', 3000),
        waitForMessage(ws2, (m) => m.type === 'bot_takeover', 3000),
        // Simulate timer expiry by calling executeTimedOutTurn directly
        new Promise((resolve) => {
          setTimeout(() => {
            gameSocketServer.executeTimedOutTurn(ROOM_CODE, p1Id).then(resolve);
          }, 50);
        }),
      ]);

      for (const takeover of [takeover1, takeover2]) {
        expect(takeover.type).toBe('bot_takeover');
        expect(takeover.playerId).toBe(p1Id);

        // PRIVACY GUARANTEE: halfSuitId must NOT be in the broadcast
        const ps = takeover.partialState;
        if (ps !== null) {
          expect(ps.halfSuitId).toBeUndefined();
          expect(ps.assignment).toBeUndefined();
          // Only flow: 'declare' is acceptable
          expect(ps.flow).toBe('declare');
        }
      }
    } finally {
      gameSocketServer.cancelTurnTimer(ROOM_CODE);
      ws1.close();
      ws2.close();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. NON-ACTIVE PLAYER ISOLATION
  // ═══════════════════════════════════════════════════════════════════════════

  it('declare_selecting from non-active player is silently ignored (no error, no storage)', async () => {
    const { ws: ws2 } = await waitForInit(`token=${p2Token}`, 'game_init');

    try {
      const messages = collectMessages(ws2, 400);

      // p2 is NOT the active player
      ws2.send(JSON.stringify({ type: 'declare_selecting', halfSuitId: 'low_s' }));

      const received = await messages;

      // p2 should receive NO error (the message is silently ignored)
      const errors = received.filter((m) => m.type === 'error');
      expect(errors).toHaveLength(0);

      // No entry stored for p2
      expect(gameSocketServer._declarationSelections.has(`${ROOM_CODE}:${p2Id}`)).toBe(false);
    } finally {
      ws2.close();
    }
  });

  it('declare_selecting from spectator returns SPECTATOR error (spectator cannot send any messages)', async () => {
    const { ws: spectWs } = await waitForInit(`spectatorToken=${SPECTATOR_HEX}`, 'spectator_init');

    try {
      spectWs.send(JSON.stringify({ type: 'declare_selecting', halfSuitId: 'low_s' }));

      const error = await waitForMessage(spectWs, (m) => m.type === 'error', 3000);
      expect(error.code).toBe('SPECTATOR');
    } finally {
      spectWs.close();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. WS INTEGRATION — declare_selecting via WebSocket
  // ═══════════════════════════════════════════════════════════════════════════

  it('active player sending declare_selecting via WS stores halfSuitId in _declarationSelections', async () => {
    const { ws: ws1 } = await waitForInit(`token=${p1Token}`, 'game_init');

    try {
      ws1.send(JSON.stringify({ type: 'declare_selecting', halfSuitId: 'low_s' }));

      // Give the server a moment to process
      await new Promise((r) => setTimeout(r, 150));

      const stored = gameSocketServer._declarationSelections.get(`${ROOM_CODE}:${p1Id}`);
      expect(stored).toEqual({ halfSuitId: 'low_s' });
    } finally {
      ws1.close();
    }
  });

  it('active player can clear their stored selection via declare_selecting with null halfSuitId', async () => {
    const { ws: ws1 } = await waitForInit(`token=${p1Token}`, 'game_init');

    try {
      // Select a suit
      ws1.send(JSON.stringify({ type: 'declare_selecting', halfSuitId: 'low_s' }));
      await new Promise((r) => setTimeout(r, 100));

      expect(gameSocketServer._declarationSelections.get(`${ROOM_CODE}:${p1Id}`)).toBeDefined();

      // Clear it (Back button pressed)
      ws1.send(JSON.stringify({ type: 'declare_selecting' })); // no halfSuitId = clear
      await new Promise((r) => setTimeout(r, 100));

      expect(gameSocketServer._declarationSelections.get(`${ROOM_CODE}:${p1Id}`)).toBeUndefined();
    } finally {
      ws1.close();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. DECLARE_SELECTING vs DECLARE_PROGRESS — different privacy levels
  // ═══════════════════════════════════════════════════════════════════════════

  it('declare_selecting (Step 1) is private — NOT broadcast; declare_progress (Step 2) IS broadcast', async () => {
    const { ws: ws1 } = await waitForInit(`token=${p1Token}`, 'game_init');
    const { ws: ws2 } = await waitForInit(`token=${p2Token}`, 'game_init');

    try {
      const p2Messages = collectMessages(ws2, 500);

      // Step 1: suit selection — private
      ws1.send(JSON.stringify({ type: 'declare_selecting', halfSuitId: 'low_s' }));

      // Step 2: assignment progress — broadcast
      ws1.send(JSON.stringify({
        type:       'declare_progress',
        halfSuitId: 'low_s',
        assignment: { '1_s': p1Id, '2_s': p1Id, '3_s': p1Id },
      }));

      const received = await p2Messages;

      // p2 should see declare_progress (Step 2) but NOT declare_selecting (Step 1)
      const declareSelectingMsgs = received.filter((m) => m.type === 'declare_selecting');
      const declareProgressMsgs  = received.filter((m) => m.type === 'declare_progress');

      expect(declareSelectingMsgs).toHaveLength(0);  // Step 1: private ✓
      expect(declareProgressMsgs).toHaveLength(1);   // Step 2: broadcast ✓

      // Verify the declare_progress content is correct
      expect(declareProgressMsgs[0].halfSuitId).toBe('low_s');
      expect(declareProgressMsgs[0].declarerId).toBe(p1Id);
    } finally {
      ws1.close();
      ws2.close();
    }
  });
});
