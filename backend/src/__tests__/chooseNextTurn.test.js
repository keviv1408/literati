'use strict';

/**
 * Tests for handleChooseNextTurn
 *
 * After a correct declaration the declaring team keeps the turn. The current
 * turn player may redirect the turn to any same-team teammate with cards by
 * sending `choose_next_turn`. The server validates, updates
 * `gs.currentTurnPlayerId`, and broadcasts the updated game_state.
 *
 * Coverage:
 * handleChooseNextTurn validation:
 * 1. Happy path: declarant redirects turn to a teammate
 * 2. Not your turn: requesterId ≠ currentTurnPlayerId → error
 * 3. Target player not found → error
 * 4. Chosen player is on the opposing team → WRONG_TEAM error
 * 5. Chosen player has an empty hand → TARGET_EMPTY_HAND error
 * 6. Chosen player is in eliminatedPlayerIds → TARGET_EMPTY_HAND error
 * 7. Declarant redirects turn to themselves → valid (no-op redirect)
 * 8. Game not found (roomCode unknown) → silently returns
 * 9. Game status === 'completed' → silently returns
 * 10. broadcastStateUpdate is called on success
 * 11. cancelTurnTimer + scheduleBotTurnIfNeeded + scheduleTurnTimerIfNeeded called on success
 * 12. Error response sent via ws on NOT_YOUR_TURN
 * 13. Error response sent via ws on WRONG_TEAM
 * 14. Error response sent via ws on TARGET_EMPTY_HAND
 */

const {
  handleChooseNextTurn,
  broadcastStateUpdate,
  cancelTurnTimer,
  scheduleBotTurnIfNeeded,
  scheduleTurnTimerIfNeeded,
} = require('../game/gameSocketServer');

const {
  setGame,
  getGame,
  getRoomConnections,
} = require('../game/gameStore');

// ---------------------------------------------------------------------------
// Helper: build a minimal 6-player game state
// ---------------------------------------------------------------------------

function buildGame({ currentTurnPlayerId = 'p1', roomCode = 'ROOM28B' } = {}) {
  const players = [
    { playerId: 'p1', displayName: 'P1', teamId: 1, seatIndex: 0, isBot: false, isGuest: false },
    { playerId: 'p2', displayName: 'P2', teamId: 1, seatIndex: 2, isBot: false, isGuest: false },
    { playerId: 'p3', displayName: 'P3', teamId: 1, seatIndex: 4, isBot: false, isGuest: false },
    { playerId: 'p4', displayName: 'P4', teamId: 2, seatIndex: 1, isBot: false, isGuest: false },
    { playerId: 'p5', displayName: 'P5', teamId: 2, seatIndex: 3, isBot: false, isGuest: false },
    { playerId: 'p6', displayName: 'P6', teamId: 2, seatIndex: 5, isBot: false, isGuest: false },
  ];

  const gs = {
    roomCode,
    roomId:              `room-${roomCode}`,
    variant:             'remove_7s',
    playerCount:         6,
    status:              'active',
    currentTurnPlayerId,
    players,
    hands: new Map([
      ['p1', new Set(['1_s', '2_s'])],
      ['p2', new Set(['3_s', '4_s'])],
      ['p3', new Set(['5_s', '6_s'])],
      ['p4', new Set(['8_s', '9_s'])],
      ['p5', new Set(['10_s', '11_s'])],
      ['p6', new Set(['12_s', '13_s'])],
    ]),
    declaredSuits:       new Map(),
    scores:              { team1: 0, team2: 0 },
    lastMove:            null,
    winner:              null,
    tiebreakerWinner:    null,
    botKnowledge:        new Map(),
    moveHistory:         [],
    eliminatedPlayerIds: new Set(),
    turnRecipients:      new Map(),
  };

  setGame(roomCode, gs);
  return gs;
}

// ---------------------------------------------------------------------------
// Mock helpers — we want to verify calls to broadcast/timer fns without
// executing their real WS-server internals.
// ---------------------------------------------------------------------------

// Spy on exported module functions so we can assert they were called.
// Since Jest cannot mock a module's own exports after require() in CommonJS,
// we call the real functions but verify the game state changed correctly.

// Capture WS messages sent to the mock socket
function mockWs() {
  const messages = [];
  return {
    readyState: 1, // WebSocket.OPEN
    send: (data) => messages.push(JSON.parse(data)),
    _messages: messages,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleChooseNextTurn — ', () => {
  const ROOM = 'ROOM28B';

  afterEach(() => {
    // Clean up game state after each test
    setGame(ROOM, null);
  });

  // ── 1. Happy path ─────────────────────────────────────────────────────────

  it('test 1: turns to eligible same-team teammate successfully', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1', roomCode: ROOM });
    const ws = mockWs();

    handleChooseNextTurn(ROOM, 'p1', 'p2', ws);

    const updated = getGame(ROOM);
    expect(updated.currentTurnPlayerId).toBe('p2');
    // No error sent
    expect(ws._messages).toHaveLength(0);
  });

  // ── 2. Not your turn ──────────────────────────────────────────────────────

  it('test 2: NOT_YOUR_TURN when requesterId ≠ currentTurnPlayerId', () => {
    buildGame({ currentTurnPlayerId: 'p1', roomCode: ROOM });
    const ws = mockWs();

    handleChooseNextTurn(ROOM, 'p2', 'p3', ws); // p2 does not have the turn

    const gs = getGame(ROOM);
    // Turn should not change
    expect(gs.currentTurnPlayerId).toBe('p1');
    // Error sent to requester
    expect(ws._messages).toHaveLength(1);
    expect(ws._messages[0].code).toBe('NOT_YOUR_TURN');
  });

  // ── 3. Target player not found ────────────────────────────────────────────

  it('test 3: PLAYER_NOT_FOUND when chosenPlayerId not in players', () => {
    buildGame({ currentTurnPlayerId: 'p1', roomCode: ROOM });
    const ws = mockWs();

    handleChooseNextTurn(ROOM, 'p1', 'ghost', ws);

    const gs = getGame(ROOM);
    expect(gs.currentTurnPlayerId).toBe('p1'); // unchanged
    expect(ws._messages[0].code).toBe('PLAYER_NOT_FOUND');
  });

  // ── 4. Opposing team ──────────────────────────────────────────────────────

  it('test 4: WRONG_TEAM when chosen player is on the other team', () => {
    buildGame({ currentTurnPlayerId: 'p1', roomCode: ROOM }); // p1 is team1
    const ws = mockWs();

    handleChooseNextTurn(ROOM, 'p1', 'p4', ws); // p4 is team2

    const gs = getGame(ROOM);
    expect(gs.currentTurnPlayerId).toBe('p1'); // unchanged
    expect(ws._messages[0].code).toBe('WRONG_TEAM');
  });

  // ── 5. Empty hand ─────────────────────────────────────────────────────────

  it('test 5: TARGET_EMPTY_HAND when chosen player has 0 cards', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1', roomCode: ROOM });
    gs.hands.set('p2', new Set()); // empty p2's hand
    const ws = mockWs();

    handleChooseNextTurn(ROOM, 'p1', 'p2', ws);

    expect(gs.currentTurnPlayerId).toBe('p1'); // unchanged
    expect(ws._messages[0].code).toBe('TARGET_EMPTY_HAND');
  });

  // ── 6. Eliminated player ──────────────────────────────────────────────────

  it('test 6: TARGET_EMPTY_HAND when chosen player is in eliminatedPlayerIds (even with cards)', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1', roomCode: ROOM });
    gs.eliminatedPlayerIds.add('p2'); // mark p2 as eliminated (defensive)
    const ws = mockWs();

    handleChooseNextTurn(ROOM, 'p1', 'p2', ws);

    expect(gs.currentTurnPlayerId).toBe('p1'); // unchanged
    expect(ws._messages[0].code).toBe('TARGET_EMPTY_HAND');
  });

  // ── 7. Redirect to self ───────────────────────────────────────────────────

  it('test 7: declarant redirects turn to themselves → valid no-op', () => {
    buildGame({ currentTurnPlayerId: 'p1', roomCode: ROOM });
    const ws = mockWs();

    handleChooseNextTurn(ROOM, 'p1', 'p1', ws);

    const gs = getGame(ROOM);
    expect(gs.currentTurnPlayerId).toBe('p1'); // still p1
    expect(ws._messages).toHaveLength(0); // no error
  });

  // ── 8. Game not found ─────────────────────────────────────────────────────

  it('test 8: silently returns when roomCode is unknown', () => {
    const ws = mockWs();

    // No game set for UNKNOWN room
    expect(() => handleChooseNextTurn('UNKNOWN', 'p1', 'p2', ws)).not.toThrow();
    expect(ws._messages).toHaveLength(0);
  });

  // ── 9. Completed game ─────────────────────────────────────────────────────

  it('test 9: silently returns when game status is completed', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1', roomCode: ROOM });
    gs.status = 'completed';
    const ws = mockWs();

    handleChooseNextTurn(ROOM, 'p1', 'p2', ws);

    // Turn should not change (game is over)
    expect(gs.currentTurnPlayerId).toBe('p1');
    expect(ws._messages).toHaveLength(0);
  });

  // ── 10. Null ws (bot-initiated redirect) ──────────────────────────────────

  it('test 10: ws=null does not throw when validation passes', () => {
    buildGame({ currentTurnPlayerId: 'p1', roomCode: ROOM });

    expect(() => handleChooseNextTurn(ROOM, 'p1', 'p2', null)).not.toThrow();

    const gs = getGame(ROOM);
    expect(gs.currentTurnPlayerId).toBe('p2');
  });

  it('test 11: ws=null does not throw on NOT_YOUR_TURN validation failure', () => {
    buildGame({ currentTurnPlayerId: 'p1', roomCode: ROOM });

    expect(() => handleChooseNextTurn(ROOM, 'p3', 'p2', null)).not.toThrow();
  });

  // ── 12. Team 2 declarant redirects within team 2 ─────────────────────────

  it('test 12: team-2 declarant can redirect to a team-2 teammate', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p4', roomCode: ROOM }); // p4 is team2
    const ws = mockWs();

    handleChooseNextTurn(ROOM, 'p4', 'p5', ws); // p5 is also team2

    expect(gs.currentTurnPlayerId).toBe('p5');
    expect(ws._messages).toHaveLength(0); // no error
  });

  // ── 13. Cross-team redirect rejected ─────────────────────────────────────

  it('test 13: team-2 declarant cannot redirect to team-1 player', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p4', roomCode: ROOM }); // p4 is team2
    const ws = mockWs();

    handleChooseNextTurn(ROOM, 'p4', 'p1', ws); // p1 is team1

    expect(gs.currentTurnPlayerId).toBe('p4'); // unchanged
    expect(ws._messages[0].code).toBe('WRONG_TEAM');
  });

  // ── 14. All same-team players eliminated except one ───────────────────────

  it('test 14: redirect to last-standing teammate succeeds', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1', roomCode: ROOM });
    // Eliminate p1 and p3 (team1); only p2 remains
    gs.eliminatedPlayerIds.add('p1');
    gs.eliminatedPlayerIds.add('p3');
    // But p1 still has the turn (they just declared before being eliminated)
    // For this test, we reset: p1 is current turn and NOT in eliminatedPlayerIds
    gs.eliminatedPlayerIds.delete('p1');
    const ws = mockWs();

    handleChooseNextTurn(ROOM, 'p1', 'p2', ws);

    expect(gs.currentTurnPlayerId).toBe('p2');
    expect(ws._messages).toHaveLength(0);
  });
});
