'use strict';

/**
 * Unit tests for * Detect mid-declaration disconnect and trigger bot takeover.
 *
 * When the active declarer disconnects during an ongoing declaration, the
 * server must:
 * 1. Identify that the disconnecting player is mid-declaration.
 * 2. Mark the declaration as bot-controlled (_botControlledDeclarations).
 * 3. Preserve the already-assigned card mappings from partialSelectionStore.
 *
 * Coverage:
 *
 * handlePlayerDisconnect — mid-declaration detection:
 * 1. Marks bot-controlled when active declarer disconnects with flow:'declare' partial
 * 2. Marks bot-controlled when active declarer disconnects after declare_selecting (Step 1 only)
 * 3. Marks bot-controlled when _declarationPhaseStarted flag is set (no partial, no selection)
 * 4. Preserves the full assignment map from the partial selection
 * 5. Preserves halfSuitId from declare partial when declaration selection also present
 * 6. Does NOT mark bot-controlled if a non-active player disconnects mid-declaration
 * 7. Does NOT mark bot-controlled if the active player disconnects with no declaration signals
 * 8. Does NOT mark bot-controlled if the active player disconnects with an ask-flow partial
 * 9. Does NOT mark bot-controlled if the game is not active
 *
 * _botControlledDeclarations lifecycle:
 * 10. Cleared when handleDeclare completes successfully
 * 11. Cleared when handleForcedFailedDeclaration resolves
 * 12. Cleared when handleAskCard supersedes the declaration
 * 13. Stores playerId of the original human declarant
 * 14. Preserves empty assignment when only Step 1 suit was chosen
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
// Helpers
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
function buildGame({ handOverrides = {}, currentTurnPlayerId = 'p1' } = {}) {
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
    roomCode:            'MIDDC',
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
    declaredSuits:    new Map(),
    scores:           { team1: 0, team2: 0 },
    lastMove:         null,
    winner:           null,
    tiebreakerWinner: null,
    botKnowledge:     new Map(),
    moveHistory:      [],
  };
}

// ---------------------------------------------------------------------------
// Module-under-test
// ---------------------------------------------------------------------------

describe('handlePlayerDisconnect — mid-declaration detection', () => {
  let handlePlayerDisconnect;
  let _botControlledDeclarations, _declarationSelections, _declarationPhaseStarted, _reconnectWindows;
  let setGame, registerConnection, removeConnection;
  let setPartialSelection, clearPartialStore;

  beforeAll(() => {
    ({
      handlePlayerDisconnect,
      _botControlledDeclarations,
      _declarationSelections,
      _declarationPhaseStarted,
      _reconnectWindows,
    } = require('../game/gameSocketServer'));

    ({ setGame, registerConnection, removeConnection } = require('../game/gameStore'));
    ({
      setPartialSelection,
      _clearAll: clearPartialStore,
    } = require('../game/partialSelectionStore'));
  });

  function makeWs() {
    return { readyState: 1, send: jest.fn() };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    _botControlledDeclarations.clear();
    _declarationSelections.clear();
    _declarationPhaseStarted.clear();
    _reconnectWindows.clear();
    clearPartialStore();
  });

  afterEach(() => {
    jest.useRealTimers();
    _botControlledDeclarations.clear();
    _declarationSelections.clear();
    _declarationPhaseStarted.clear();
    _reconnectWindows.clear();
    clearPartialStore();
    removeConnection('MIDDC', 'p1');
    removeConnection('MIDDC', 'p2');
    removeConnection('MIDDC', 'p3');
    removeConnection('MIDDC', 'p4');
  });

  it('1. marks bot-controlled when active declarer disconnects with flow:declare partial (Step 2)', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('MIDDC', gs);

    // Simulate p1 reached Step 2 of DeclareModal with 2 cards assigned
    setPartialSelection('MIDDC', 'p1', {
      flow:       'declare',
      halfSuitId: 'low_s',
      assignment: { '1_s': 'p1', '2_s': 'p1' },
    });

    registerConnection('MIDDC', 'p2', makeWs());
    handlePlayerDisconnect('MIDDC', 'p1', false);

    expect(_botControlledDeclarations.has('MIDDC')).toBe(true);
    const entry = _botControlledDeclarations.get('MIDDC');
    expect(entry.playerId).toBe('p1');
    expect(entry.halfSuitId).toBe('low_s');
  });

  it('2. marks bot-controlled when active declarer disconnects after declare_selecting (Step 1 only)', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('MIDDC', gs);

    // Simulate p1 chose a suit in Step 1 but has no Step 2 partial yet
    _declarationSelections.set('MIDDC:p1', { halfSuitId: 'high_s' });

    registerConnection('MIDDC', 'p2', makeWs());
    handlePlayerDisconnect('MIDDC', 'p1', false);

    expect(_botControlledDeclarations.has('MIDDC')).toBe(true);
    const entry = _botControlledDeclarations.get('MIDDC');
    expect(entry.playerId).toBe('p1');
    expect(entry.halfSuitId).toBe('high_s');
  });

  it('3. marks bot-controlled when _declarationPhaseStarted flag is set (no partial, no declSel)', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('MIDDC', gs);

    // Simulate the declaration phase timer fired but player hasn't sent partial_selection yet
    _declarationPhaseStarted.add('MIDDC');

    registerConnection('MIDDC', 'p2', makeWs());
    handlePlayerDisconnect('MIDDC', 'p1', false);

    expect(_botControlledDeclarations.has('MIDDC')).toBe(true);
    const entry = _botControlledDeclarations.get('MIDDC');
    expect(entry.playerId).toBe('p1');
    // No half-suit or assignment available in this case
    expect(entry.halfSuitId).toBeNull();
    expect(entry.assignment).toEqual({});
  });

  it('4. preserves the full assignment map from the partial selection', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('MIDDC', gs);

    setPartialSelection('MIDDC', 'p1', {
      flow:       'declare',
      halfSuitId: 'low_s',
      assignment: { '1_s': 'p1', '2_s': 'p1', '3_s': 'p1', '4_s': 'p2' },
    });

    registerConnection('MIDDC', 'p2', makeWs());
    handlePlayerDisconnect('MIDDC', 'p1', false);

    const entry = _botControlledDeclarations.get('MIDDC');
    expect(entry.assignment).toEqual({
      '1_s': 'p1', '2_s': 'p1', '3_s': 'p1', '4_s': 'p2',
    });
  });

  it('5. prefers partial halfSuitId over declaration selection halfSuitId (Step 2 wins)', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('MIDDC', gs);

    // Both partial and declSel present — partial (Step 2) should take precedence
    setPartialSelection('MIDDC', 'p1', {
      flow:       'declare',
      halfSuitId: 'low_s',
      assignment: { '1_s': 'p1' },
    });
    _declarationSelections.set('MIDDC:p1', { halfSuitId: 'high_s' }); // Step 1 (stale)

    registerConnection('MIDDC', 'p2', makeWs());
    handlePlayerDisconnect('MIDDC', 'p1', false);

    const entry = _botControlledDeclarations.get('MIDDC');
    // Partial (Step 2) halfSuitId takes precedence
    expect(entry.halfSuitId).toBe('low_s');
  });

  it('6. does NOT mark bot-controlled if a non-active player disconnects mid-declaration', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('MIDDC', gs);

    // p2 is NOT the active turn holder — even if they have declaration state, ignore
    setPartialSelection('MIDDC', 'p2', {
      flow:       'declare',
      halfSuitId: 'low_s',
      assignment: { '1_s': 'p2' },
    });

    registerConnection('MIDDC', 'p1', makeWs());
    handlePlayerDisconnect('MIDDC', 'p2', false);

    expect(_botControlledDeclarations.has('MIDDC')).toBe(false);
  });

  it('7. does NOT mark bot-controlled if the active player disconnects with no declaration signals', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('MIDDC', gs);

    // No partial selection, no declSel, no declarationPhaseStarted
    registerConnection('MIDDC', 'p2', makeWs());
    handlePlayerDisconnect('MIDDC', 'p1', false);

    expect(_botControlledDeclarations.has('MIDDC')).toBe(false);
  });

  it('8. does NOT mark bot-controlled if the active player disconnects with an ask-flow partial', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('MIDDC', gs);

    // Ask-flow partial — should not trigger declaration bot takeover
    setPartialSelection('MIDDC', 'p1', {
      flow:       'ask',
      halfSuitId: 'low_s',
      cardId:     '3_s',
    });

    registerConnection('MIDDC', 'p2', makeWs());
    handlePlayerDisconnect('MIDDC', 'p1', false);

    expect(_botControlledDeclarations.has('MIDDC')).toBe(false);
  });

  it('9. does NOT mark bot-controlled if the game is not active', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    gs.status = 'completed'; // game already ended
    setGame('MIDDC', gs);

    setPartialSelection('MIDDC', 'p1', {
      flow:       'declare',
      halfSuitId: 'low_s',
      assignment: { '1_s': 'p1' },
    });

    handlePlayerDisconnect('MIDDC', 'p1', false);

    expect(_botControlledDeclarations.has('MIDDC')).toBe(false);
  });

  it('14. preserves empty assignment when only Step 1 suit was chosen (no card assignments yet)', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('MIDDC', gs);

    // Only suit choice — no card assignments
    _declarationSelections.set('MIDDC:p1', { halfSuitId: 'low_s' });

    registerConnection('MIDDC', 'p2', makeWs());
    handlePlayerDisconnect('MIDDC', 'p1', false);

    const entry = _botControlledDeclarations.get('MIDDC');
    expect(entry.halfSuitId).toBe('low_s');
    expect(entry.assignment).toEqual({});
    expect(Object.keys(entry.assignment)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// _botControlledDeclarations lifecycle
// ---------------------------------------------------------------------------

describe('_botControlledDeclarations — lifecycle (cleared on resolution)', () => {
  let handlePlayerDisconnect, handleDeclare, handleAskCard, handleForcedFailedDeclaration;
  let _botControlledDeclarations, _declarationSelections, _declarationPhaseStarted, _reconnectWindows;
  let setGame, registerConnection, removeConnection;
  let setPartialSelection, clearPartialStore;

  beforeAll(() => {
    ({
      handlePlayerDisconnect,
      handleDeclare,
      handleAskCard,
      handleForcedFailedDeclaration,
      _botControlledDeclarations,
      _declarationSelections,
      _declarationPhaseStarted,
      _reconnectWindows,
    } = require('../game/gameSocketServer'));

    ({ setGame, registerConnection, removeConnection } = require('../game/gameStore'));
    ({
      setPartialSelection,
      _clearAll: clearPartialStore,
    } = require('../game/partialSelectionStore'));
  });

  function makeWs(messages = []) {
    return { readyState: 1, send: (d) => messages.push(JSON.parse(d)) };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    _botControlledDeclarations.clear();
    _declarationSelections.clear();
    _declarationPhaseStarted.clear();
    _reconnectWindows.clear();
    clearPartialStore();
  });

  afterEach(() => {
    jest.useRealTimers();
    _botControlledDeclarations.clear();
    _declarationSelections.clear();
    _declarationPhaseStarted.clear();
    _reconnectWindows.clear();
    clearPartialStore();
    removeConnection('MIDDC', 'p1');
    removeConnection('MIDDC', 'p2');
    removeConnection('MIDDC', 'p3');
    removeConnection('MIDDC', 'p4');
    removeConnection('MIDDC', 'p5');
    removeConnection('MIDDC', 'p6');
  });

  it('10. cleared when handleDeclare completes successfully', async () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('MIDDC', gs);

    // Manually seed _botControlledDeclarations as if disconnect was detected
    _botControlledDeclarations.set('MIDDC', {
      playerId:   'p1',
      halfSuitId: 'low_s',
      assignment: { '1_s': 'p1', '2_s': 'p1' },
    });

    // Register connections for broadcasting
    const ws = makeWs();
    registerConnection('MIDDC', 'p1', ws);
    registerConnection('MIDDC', 'p2', ws);

    // Submit a complete, correct declaration
    const assignment = {
      '1_s': 'p1', '2_s': 'p1', '3_s': 'p1',
      '4_s': 'p2', '5_s': 'p2', '6_s': 'p2',
    };
    await handleDeclare('MIDDC', 'p1', 'low_s', assignment, null, true);

    expect(_botControlledDeclarations.has('MIDDC')).toBe(false);
  });

  it('11. cleared when handleForcedFailedDeclaration resolves', async () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('MIDDC', gs);

    _botControlledDeclarations.set('MIDDC', {
      playerId:   'p1',
      halfSuitId: 'low_s',
      assignment: { '1_s': 'p1' },
    });

    const ws = makeWs();
    registerConnection('MIDDC', 'p1', ws);
    registerConnection('MIDDC', 'p2', ws);

    await handleForcedFailedDeclaration('MIDDC', 'p1', 'low_s');

    expect(_botControlledDeclarations.has('MIDDC')).toBe(false);
  });

  it('12. cleared when handleAskCard supersedes the declaration', async () => {
    // Give p4 a low_s card (5_s) so that p1 (who holds low_s) can legally ask p4 for it
    const gs = buildGame({
      currentTurnPlayerId: 'p1',
      handOverrides: {
        p1: new Set(['1_s','2_s','3_s','8_s','9_s','10_s']),
        p2: new Set(['6_s','11_s','12_s','13_s']),
        p3: new Set(['1_h','2_h','3_h','8_h','9_h','10_h']),
        p4: new Set(['4_s','5_s','4_h','5_h','6_h','11_h']),   // p4 holds 4_s (low_s)
        p5: new Set(['1_d','2_d','3_d','8_d','9_d','10_d']),
        p6: new Set(['4_d','5_d','6_d','11_d','12_d','13_d']),
      },
    });
    setGame('MIDDC', gs);

    _botControlledDeclarations.set('MIDDC', {
      playerId:   'p1',
      halfSuitId: 'low_s',
      assignment: {},
    });

    const ws = makeWs();
    registerConnection('MIDDC', 'p1', ws);
    registerConnection('MIDDC', 'p4', ws);

    // p1 (team 1) asks p4 (team 2, opponent) for 4_s — p1 holds low_s, p4 holds 4_s → valid
    await handleAskCard('MIDDC', 'p1', 'p4', '4_s', null, false);

    expect(_botControlledDeclarations.has('MIDDC')).toBe(false);
  });

  it('13. stores playerId of the original human declarant', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p3' });
    setGame('MIDDC', gs);

    setPartialSelection('MIDDC', 'p3', {
      flow:       'declare',
      halfSuitId: 'low_h',
      assignment: { '1_h': 'p3' },
    });

    registerConnection('MIDDC', 'p1', makeWs());
    handlePlayerDisconnect('MIDDC', 'p3', false);

    const entry = _botControlledDeclarations.get('MIDDC');
    expect(entry).toBeDefined();
    expect(entry.playerId).toBe('p3');
  });
});
