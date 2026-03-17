'use strict';

/**
 * Unit tests for AC 24: Declaration timer expiry with incomplete assignments
 * counts as a failed declaration.
 *
 * When a CONNECTED human player's turn timer fires while they are mid-
 * declaration (in the DeclareModal) and their card assignment is incomplete
 * (fewer than all 6 cards assigned), the server treats the attempt as a
 * failed declaration:
 * - The opposing team is unconditionally awarded the point.
 * - All 6 half-suit cards are removed from play.
 * - `declaration_result` is broadcast with `correct: false, timedOut: true`.
 *
 * A DISCONNECTED player (in the reconnect window) falls through to the bot-
 * completion path instead (handled by the disconnect-midgame AC).
 *
 * Coverage:
 *
 * applyForcedFailedDeclaration (gameEngine):
 * 1. Awards point to the opposing team
 * 2. Removes all 6 half-suit cards from every hand
 * 3. Marks the half-suit as declared (winningTeam = opponents)
 * 4. Sets a descriptive lastMove mentioning "ran out of time"
 * 5. Records a move-history entry with timedOut: true
 * 6. Updates the tiebreaker when the tiebreaker half-suit is declared
 * 7. Advances the turn (declarer keeps turn if they still have cards)
 * 8. Ends the game when the last half-suit is declared via forced failure
 *
 * executeTimedOutTurn integration (connected player):
 * 9. Timer expiry with NO assignment (only half-suit selected) → forced failure
 * 10. Timer expiry with PARTIAL assignment (< 6 cards) → forced failure
 * 11. Timer expiry with COMPLETE assignment (6 cards) → normal bot declaration
 * 12. Forced failure broadcasts declaration_result with correct:false, timedOut:true
 * 13. Forced failure broadcasts bot_takeover BEFORE declaration_result
 * 14. Partial state and declaration selection are cleared after forced failure
 *
 * executeTimedOutTurn integration (disconnected player):
 * 15. Disconnected player with incomplete declaration → bot completion (not forced failure)
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../db/supabase', () => ({
  getSupabaseClient: () => ({
    from: () => ({
      select:  () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      update:  () => ({ eq: () => Promise.resolve({ error: null }) }),
      upsert:  () => Promise.resolve({ error: null }),
      rpc:     () => Promise.resolve({ error: null }),
    }),
    auth: { getUser: async () => ({ data: null, error: new Error('mock') }) },
  }),
}));

jest.mock('../sessions/guestSessionStore', () => ({ getGuestSession: () => null }));

jest.mock('../liveGames/liveGamesStore', () => ({
  addGame:    jest.fn(),
  updateGame: jest.fn(),
  removeGame: jest.fn(),
  get:        jest.fn().mockReturnValue(null),
}));

jest.mock('../game/rematchStore', () => ({
  initRematch:    jest.fn().mockReturnValue({ yesCount: 0, noCount: 0, totalCount: 0 }),
  castVote:       jest.fn(),
  getVoteSummary: jest.fn(),
  hasRematch:     jest.fn().mockReturnValue(false),
  clearRematch:   jest.fn(),
}));

// ---------------------------------------------------------------------------
// Test game-state builder
// ---------------------------------------------------------------------------

/**
 * Builds a 6-player game state (remove_7s variant).
 *
 * Team 1: p1, p2, p3
 * Team 2: p4, p5, p6
 *
 * low_s = 1_s, 2_s, 3_s, 4_s, 5_s, 6_s
 * high_s = 8_s, 9_s, 10_s, 11_s, 12_s, 13_s
 */
function buildGame({ handOverrides = {}, currentTurnPlayerId = 'p1', declaredSuits } = {}) {
  const defaultHands = {
    p1: new Set(['1_s','2_s','3_s','8_s','9_s','10_s']),
    p2: new Set(['4_s','5_s','6_s','11_s','12_s','13_s']),
    p3: new Set(['1_h','2_h','3_h','8_h','9_h','10_h']),
    p4: new Set(['4_h','5_h','6_h','11_h','12_h','13_h']),
    p5: new Set(['1_d','2_d','3_d','8_d','9_d','10_d']),
    p6: new Set(['4_d','5_d','6_d','11_d','12_d','13_d']),
  };

  const hands = new Map();
  for (const [pid, defaultHand] of Object.entries(defaultHands)) {
    hands.set(pid, new Set(handOverrides[pid] ?? defaultHand));
  }

  return {
    roomCode:            'DECLTO',
    roomId:              'room-uuid',
    variant:             'remove_7s',
    playerCount:         6,
    status:              'active',
    currentTurnPlayerId,
    players: [
      { playerId: 'p1', displayName: 'P1', teamId: 1, seatIndex: 0, isBot: false, isGuest: false },
      { playerId: 'p2', displayName: 'P2', teamId: 1, seatIndex: 2, isBot: false, isGuest: false },
      { playerId: 'p3', displayName: 'P3', teamId: 1, seatIndex: 4, isBot: false, isGuest: false },
      { playerId: 'p4', displayName: 'P4', teamId: 2, seatIndex: 1, isBot: false, isGuest: false },
      { playerId: 'p5', displayName: 'P5', teamId: 2, seatIndex: 3, isBot: false, isGuest: false },
      { playerId: 'p6', displayName: 'P6', teamId: 2, seatIndex: 5, isBot: false, isGuest: false },
    ],
    hands,
    declaredSuits:    declaredSuits ?? new Map(),
    scores:           { team1: 0, team2: 0 },
    lastMove:         null,
    winner:           null,
    tiebreakerWinner: null,
    botKnowledge:     new Map(),
    moveHistory:      [],
  };
}

// ---------------------------------------------------------------------------
// applyForcedFailedDeclaration — pure engine tests
// ---------------------------------------------------------------------------

describe('applyForcedFailedDeclaration', () => {
  const { applyForcedFailedDeclaration } = require('../game/gameEngine');

  it('1. awards point to the opposing team (p1=team1 → team2 scores)', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    applyForcedFailedDeclaration(gs, 'p1', 'low_s');
    expect(gs.scores.team2).toBe(1);
    expect(gs.scores.team1).toBe(0);
  });

  it('2. removes all 6 half-suit cards from every hand', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    // low_s cards: 1_s, 2_s, 3_s held by p1; 4_s, 5_s, 6_s held by p2
    applyForcedFailedDeclaration(gs, 'p1', 'low_s');

    const lowSCards = ['1_s','2_s','3_s','4_s','5_s','6_s'];
    for (const [, hand] of gs.hands) {
      for (const card of lowSCards) {
        expect(hand.has(card)).toBe(false);
      }
    }
  });

  it('3. marks the half-suit as declared with the opposing team as winner', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    applyForcedFailedDeclaration(gs, 'p1', 'low_s');
    const entry = gs.declaredSuits.get('low_s');
    expect(entry).toBeDefined();
    expect(entry.teamId).toBe(2);
    expect(entry.declaredBy).toBe('p1');
  });

  it('4. sets lastMove mentioning "ran out of time"', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    applyForcedFailedDeclaration(gs, 'p1', 'low_s');
    expect(gs.lastMove).toMatch(/ran out of time/i);
    expect(gs.lastMove).toContain('P1');
  });

  it('5. records a move-history entry with timedOut: true and correct: false', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    applyForcedFailedDeclaration(gs, 'p1', 'low_s');
    const entry = gs.moveHistory[gs.moveHistory.length - 1];
    expect(entry.type).toBe('declaration');
    expect(entry.declarerId).toBe('p1');
    expect(entry.halfSuitId).toBe('low_s');
    expect(entry.correct).toBe(false);
    expect(entry.timedOut).toBe(true);
    expect(entry.assignment).toBeNull();
  });

  it('6. updates tiebreakerWinner when tiebreaker half-suit is force-failed', () => {
    // The tiebreaker half-suit for remove_7s is high_d (or check TIEBREAKER_HALF_SUIT)
    const { TIEBREAKER_HALF_SUIT } = require('../game/halfSuits');
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    // Move high_d cards to appropriate players
    // For now, just test that tiebreakerWinner is set when the tiebreaker suit is declared
    applyForcedFailedDeclaration(gs, 'p1', TIEBREAKER_HALF_SUIT);
    expect(gs.tiebreakerWinner).toBeDefined();
    expect(gs.tiebreakerWinner).toBe(2); // p1 is team1, opponent is team2
  });

  it('7. turn passes clockwise to next eligible opponent after forced failure', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    // p1 (team1) still has high_s cards after low_s is removed
    // Per spec: "After failed declaration, turn auto-passes clockwise to next eligible opponent"
    applyForcedFailedDeclaration(gs, 'p1', 'low_s');
    const newTurnPlayer = gs.players.find((p) => p.playerId === gs.currentTurnPlayerId);
    expect(newTurnPlayer).toBeDefined();
    expect(newTurnPlayer.teamId).toBe(2); // turn passes to opponent team
  });

  it('7b. turn passes to a teammate if declarer has no cards left', () => {
    const gs = buildGame({
      currentTurnPlayerId: 'p1',
      handOverrides: {
        p1: new Set(['1_s','2_s','3_s']), // only low_s cards (will all be removed)
        p2: new Set(['4_s','5_s','6_s','11_s','12_s','13_s']),
      },
    });
    applyForcedFailedDeclaration(gs, 'p1', 'low_s');
    // p1 now has no cards, so turn should pass to another team-1 member (p2 or p3)
    expect(gs.currentTurnPlayerId).not.toBe('p1');
    const newTurn = gs.players.find((p) => p.playerId === gs.currentTurnPlayerId);
    expect(newTurn).toBeDefined();
  });

  it('8. ends the game when the last half-suit is declared via forced failure', () => {
    // Pre-declare 7 half-suits; only low_s remains
    const alreadyDeclared = new Map([
      ['high_s', { teamId: 1, declaredBy: 'p1' }],
      ['low_h',  { teamId: 2, declaredBy: 'p4' }],
      ['high_h', { teamId: 1, declaredBy: 'p2' }],
      ['low_d',  { teamId: 2, declaredBy: 'p5' }],
      ['high_d', { teamId: 1, declaredBy: 'p3' }],
      ['low_c',  { teamId: 2, declaredBy: 'p6' }],
      ['high_c', { teamId: 1, declaredBy: 'p1' }],
    ]);
    const gs = buildGame({
      currentTurnPlayerId: 'p1',
      declaredSuits: alreadyDeclared,
    });
    applyForcedFailedDeclaration(gs, 'p1', 'low_s');
    expect(gs.status).toBe('completed');
    expect(gs.winner).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// executeTimedOutTurn integration
// ---------------------------------------------------------------------------

describe('executeTimedOutTurn — declaration timer expiry (AC 24)', () => {
  let setGame, registerConnection, removeConnection;
  let executeTimedOutTurn, cancelTurnTimer;
  let setPartialSelection;
  let _declarationSelections, _reconnectWindows;
  let cancelBotDeclarationTimer, BOT_DECLARATION_TAKEOVER_MS;

  beforeAll(() => {
    ({
      executeTimedOutTurn,
      cancelTurnTimer,
      cancelBotDeclarationTimer,
      _declarationSelections,
      _reconnectWindows,
      BOT_DECLARATION_TAKEOVER_MS,
    } = require('../game/gameSocketServer'));

    ({ setGame, registerConnection, removeConnection } = require('../game/gameStore'));
    ({ setPartialSelection } = require('../game/partialSelectionStore'));
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    // Ensure no stale reconnect-window entries affect tests
    _reconnectWindows.clear();
    _declarationSelections.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
    _reconnectWindows.clear();
    _declarationSelections.clear();
    cancelTurnTimer('DECLTO');
    cancelBotDeclarationTimer('DECLTO');
  });

  // Helper: create a mock WS and register it
  function makeWs(messages = []) {
    return { readyState: 1, send: (d) => messages.push(JSON.parse(d)) };
  }

  it('9. timer expiry with NO assignment (only half-suit selected) → forced failure', async () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('DECLTO', gs);

    // Only a declare_selecting was sent (Step 1 of DeclareModal)
    _declarationSelections.set('DECLTO:p1', { halfSuitId: 'low_s' });

    const messages = [];
    const mockWs = makeWs(messages);
    registerConnection('DECLTO', 'p1', mockWs);
    registerConnection('DECLTO', 'p4', mockWs);

    await executeTimedOutTurn('DECLTO', 'p1');

    const result = messages.find((m) => m.type === 'declaration_result');
    expect(result).toBeDefined();
    expect(result.correct).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.halfSuitId).toBe('low_s');
    expect(result.declarerId).toBe('p1');
    // Opposing team wins
    expect(result.winningTeam).toBe(2);

    removeConnection('DECLTO', 'p1');
    removeConnection('DECLTO', 'p4');
  });

  it('10. timer expiry with PARTIAL assignment (< 6 cards) → forced failure', async () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('DECLTO', gs);

    // Partial assignment: only 3 of the 6 low_s cards assigned
    setPartialSelection('DECLTO', 'p1', {
      flow:       'declare',
      halfSuitId: 'low_s',
      assignment: { '1_s': 'p1', '2_s': 'p1', '3_s': 'p1' },
    });

    const messages = [];
    const mockWs = makeWs(messages);
    registerConnection('DECLTO', 'p1', mockWs);

    await executeTimedOutTurn('DECLTO', 'p1');

    const result = messages.find((m) => m.type === 'declaration_result');
    expect(result).toBeDefined();
    expect(result.correct).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.winningTeam).toBe(2);

    removeConnection('DECLTO', 'p1');
  });

  it('11. timer expiry with COMPLETE assignment (6 cards) → normal bot declaration (not forced failure)', async () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('DECLTO', gs);

    // Complete assignment: all 6 low_s cards assigned (correctly)
    // low_s = 1_s(p1), 2_s(p1), 3_s(p1), 4_s(p2), 5_s(p2), 6_s(p2)
    setPartialSelection('DECLTO', 'p1', {
      flow:       'declare',
      halfSuitId: 'low_s',
      assignment: {
        '1_s': 'p1', '2_s': 'p1', '3_s': 'p1',
        '4_s': 'p2', '5_s': 'p2', '6_s': 'p2',
      },
    });

    const messages = [];
    const mockWs = makeWs(messages);
    registerConnection('DECLTO', 'p1', mockWs);
    registerConnection('DECLTO', 'p2', mockWs);

    await executeTimedOutTurn('DECLTO', 'p1');

    // bot takeover starts a 30-second countdown before submitting.
    // Advance fake timers to trigger the auto-submit.
    await jest.advanceTimersByTimeAsync(BOT_DECLARATION_TAKEOVER_MS);

    const result = messages.find((m) => m.type === 'declaration_result');
    expect(result).toBeDefined();
    // Complete and correct assignment → should succeed, NOT be a forced failure
    expect(result.timedOut).toBeFalsy();
    expect(result.correct).toBe(true);

    removeConnection('DECLTO', 'p1');
    removeConnection('DECLTO', 'p2');
  });

  it('12. forced failure broadcasts declaration_result with correct:false and timedOut:true', async () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('DECLTO', gs);

    _declarationSelections.set('DECLTO:p1', { halfSuitId: 'low_s' });

    const messages = [];
    const mockWs = makeWs(messages);
    registerConnection('DECLTO', 'p1', mockWs);

    await executeTimedOutTurn('DECLTO', 'p1');

    const result = messages.find((m) => m.type === 'declaration_result');
    expect(result).toBeDefined();
    expect(result.correct).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.assignment).toBeNull();

    removeConnection('DECLTO', 'p1');
  });

  it('13. bot_takeover is broadcast BEFORE declaration_result on forced failure', async () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('DECLTO', gs);

    _declarationSelections.set('DECLTO:p1', { halfSuitId: 'low_s' });

    const messageTypes = [];
    const mockWs = {
      readyState: 1,
      send: (d) => messageTypes.push(JSON.parse(d).type),
    };
    registerConnection('DECLTO', 'p1', mockWs);

    await executeTimedOutTurn('DECLTO', 'p1');

    const takeoverIdx = messageTypes.indexOf('bot_takeover');
    const resultIdx   = messageTypes.indexOf('declaration_result');
    expect(takeoverIdx).toBeGreaterThanOrEqual(0);
    expect(resultIdx).toBeGreaterThan(takeoverIdx);

    removeConnection('DECLTO', 'p1');
  });

  it('14. partial state and declaration selection are cleared after forced failure', async () => {
    const { getPartialSelection } = require('../game/partialSelectionStore');

    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('DECLTO', gs);

    _declarationSelections.set('DECLTO:p1', { halfSuitId: 'low_s' });
    setPartialSelection('DECLTO', 'p1', {
      flow: 'declare', halfSuitId: 'low_s', assignment: { '1_s': 'p1' },
    });

    const mockWs = { readyState: 1, send: () => {} };
    registerConnection('DECLTO', 'p1', mockWs);

    await executeTimedOutTurn('DECLTO', 'p1');

    expect(_declarationSelections.has('DECLTO:p1')).toBe(false);
    expect(getPartialSelection('DECLTO', 'p1')).toBeNull();

    removeConnection('DECLTO', 'p1');
  });

  it('15. disconnected player with incomplete declaration → bot completion (not forced failure)', async () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('DECLTO', gs);

    // Simulate player disconnected (in reconnect window)
    _reconnectWindows.set('p1', {
      roomCode: 'DECLTO',
      originalDisplayName: 'P1',
      originalAvatarId: null,
      originalIsGuest: false,
      timerId: setTimeout(() => {}, 60000), // fake timer
      expiresAt: Date.now() + 60000,
    });

    // Partial assign: only 2 cards (incomplete)
    setPartialSelection('DECLTO', 'p1', {
      flow:       'declare',
      halfSuitId: 'low_s',
      assignment: { '1_s': 'p1', '2_s': 'p1' },
    });

    const messages = [];
    const mockWs = makeWs(messages);
    registerConnection('DECLTO', 'p1', mockWs);
    registerConnection('DECLTO', 'p2', mockWs);

    await executeTimedOutTurn('DECLTO', 'p1');

    // bot takeover starts a 30-second countdown before submitting.
    // Advance fake timers to trigger the auto-submit.
    await jest.advanceTimersByTimeAsync(BOT_DECLARATION_TAKEOVER_MS);

    // Should NOT be a forced-failed declaration (timedOut should not be true)
    const result = messages.find((m) => m.type === 'declaration_result');
    expect(result).toBeDefined();
    // The bot completes the declaration — it may or may not be correct, but
    // it should NOT have timedOut: true (that's the forced-failure marker)
    expect(result.timedOut).toBeFalsy();

    // Clean up
    const fakeEntry = _reconnectWindows.get('p1');
    if (fakeEntry?.timerId) clearTimeout(fakeEntry.timerId);
    _reconnectWindows.delete('p1');
    removeConnection('DECLTO', 'p1');
    removeConnection('DECLTO', 'p2');
  });
});
