'use strict';

/**
 * Unit tests for Sub-AC 17.3: Bot completion from partial selection state.
 *
 * Coverage:
 *
 *   partialSelectionStore:
 *     1. setPartialSelection / getPartialSelection roundtrip
 *     2. clearPartialSelection removes the entry
 *     3. clearRoomPartialSelections removes all entries for a room
 *     4. getPartialSelection returns null for missing entries
 *     5. Room-code comparison is case-insensitive
 *
 *   completeBotFromPartial — null / unknown input:
 *     6. Falls back to decideBotMove when partial is null
 *     7. Falls back to decideBotMove when partial has no `flow` field
 *     8. Falls back to decideBotMove when flow is unrecognised
 *
 *   completeBotFromPartial — ask flow, step 2 (half-suit only):
 *     9.  Returns a valid ask using a card from the specified half-suit
 *    10.  Falls back to decideBotMove if the half-suit is already declared
 *    11.  Falls back to decideBotMove if there are no opponents left to ask
 *    12.  Prefers opponent known to have the card (inference-based)
 *
 *   completeBotFromPartial — ask flow, step 3 (half-suit + card):
 *    13.  Returns a valid ask using the specified card against any valid opponent
 *    14.  Falls back to decideBotMove if the specified card is no longer askable
 *    15.  Prefers opponent known to have the card (inference-based)
 *
 *   completeBotFromPartial — declare flow:
 *    16.  Completes a partial assignment — all 6 cards are covered
 *    17.  Respects player's existing partial assignments (does not override them)
 *    18.  Falls back to decideBotMove if the half-suit is already declared
 *    19.  Uses actual hand data to fill gaps in the assignment
 *    20.  Result passes validateDeclaration when team holds all cards
 *
 *   handlePartialSelection (gameSocketServer integration):
 *    21.  Stores partial state when player is active turn holder
 *    22.  Ignores partial state when player is NOT the active turn holder
 *    23.  Ignores unknown flow values
 *    24.  Stores cardId for ask-step-3 partial
 *    25.  Stores assignment for declare partial
 *
 *   executeTimedOutTurn integration:
 *    26.  Uses partial state from store when completing a timed-out ask
 *    27.  Clears partial state after execution
 *    28.  Broadcasts bot_takeover before executing the move
 *    29.  Falls back gracefully when partial state is stale/invalid
 */

const {
  completeBotFromPartial,
  decideBotMove,
  updateKnowledgeAfterAsk,
} = require('../game/botLogic');

const {
  setPartialSelection,
  getPartialSelection,
  clearPartialSelection,
  clearRoomPartialSelections,
  _clearAll: clearPartialStore,
} = require('../game/partialSelectionStore');

const { validateAsk, validateDeclaration } = require('../game/gameEngine');
const { buildHalfSuitMap }                 = require('../game/halfSuits');

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
 * Builds a 6-player game state for remove_7s variant.
 *
 *   Team 1: p1 (bot), p2, p3
 *   Team 2: p4, p5, p6
 *
 * With remove_7s:
 *   low_s  = 1_s,2_s,3_s,4_s,5_s,6_s
 *   high_s = 8_s,9_s,10_s,11_s,12_s,13_s
 *   ... (same pattern for h, d, c)
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
    roomCode:            'BOTCMP',
    roomId:              'room-uuid',
    variant:             'remove_7s',
    playerCount:         6,
    status:              'active',
    currentTurnPlayerId,
    players: [
      { playerId: 'p1', displayName: 'Bot',  teamId: 1, seatIndex: 0, isBot: true,  isGuest: false },
      { playerId: 'p2', displayName: 'P2',   teamId: 1, seatIndex: 2, isBot: false, isGuest: false },
      { playerId: 'p3', displayName: 'P3',   teamId: 1, seatIndex: 4, isBot: false, isGuest: false },
      { playerId: 'p4', displayName: 'P4',   teamId: 2, seatIndex: 1, isBot: false, isGuest: false },
      { playerId: 'p5', displayName: 'P5',   teamId: 2, seatIndex: 3, isBot: false, isGuest: false },
      { playerId: 'p6', displayName: 'P6',   teamId: 2, seatIndex: 5, isBot: false, isGuest: false },
    ],
    hands,
    declaredSuits: new Map(),
    scores:        { team1: 0, team2: 0 },
    lastMove:      null,
    winner:        null,
    tiebreakerWinner: null,
    botKnowledge:  new Map(),
    moveHistory:   [],
    inferenceMode: false,
  };
}

// ---------------------------------------------------------------------------
// partialSelectionStore tests
// ---------------------------------------------------------------------------

describe('partialSelectionStore', () => {
  beforeEach(() => clearPartialStore());

  it('1. set/get roundtrip', () => {
    const partial = { flow: 'ask', halfSuitId: 'low_s' };
    setPartialSelection('ROOM1', 'p1', partial);
    expect(getPartialSelection('ROOM1', 'p1')).toEqual(partial);
  });

  it('2. clearPartialSelection removes entry', () => {
    setPartialSelection('ROOM1', 'p1', { flow: 'ask', halfSuitId: 'low_s' });
    clearPartialSelection('ROOM1', 'p1');
    expect(getPartialSelection('ROOM1', 'p1')).toBeNull();
  });

  it('3. clearRoomPartialSelections removes all entries for a room', () => {
    setPartialSelection('ROOM1', 'p1', { flow: 'ask', halfSuitId: 'low_s' });
    setPartialSelection('ROOM1', 'p2', { flow: 'declare', halfSuitId: 'high_s', assignment: {} });
    setPartialSelection('ROOM2', 'p3', { flow: 'ask', halfSuitId: 'low_h' });

    clearRoomPartialSelections('ROOM1');

    expect(getPartialSelection('ROOM1', 'p1')).toBeNull();
    expect(getPartialSelection('ROOM1', 'p2')).toBeNull();
    // ROOM2 is unaffected
    expect(getPartialSelection('ROOM2', 'p3')).not.toBeNull();
  });

  it('4. getPartialSelection returns null for missing entries', () => {
    expect(getPartialSelection('NOSUCHROOM', 'p99')).toBeNull();
  });

  it('5. room-code lookup is case-insensitive', () => {
    const partial = { flow: 'ask', halfSuitId: 'low_s' };
    setPartialSelection('room1', 'p1', partial);
    expect(getPartialSelection('ROOM1', 'p1')).toEqual(partial);
    expect(getPartialSelection('room1', 'p1')).toEqual(partial);
  });
});

// ---------------------------------------------------------------------------
// completeBotFromPartial — null / unknown fallbacks
// ---------------------------------------------------------------------------

describe('completeBotFromPartial — fallbacks', () => {
  it('6. falls back to decideBotMove when partial is null', () => {
    const gs  = buildGame();
    const res = completeBotFromPartial(gs, 'p1', null);
    // Should be a valid action
    expect(['ask', 'declare']).toContain(res.action);
  });

  it('7. falls back when partial has no flow field', () => {
    const gs  = buildGame();
    const res = completeBotFromPartial(gs, 'p1', { halfSuitId: 'low_s' });
    expect(['ask', 'declare']).toContain(res.action);
  });

  it('8. falls back when flow is unrecognised', () => {
    const gs  = buildGame();
    const res = completeBotFromPartial(gs, 'p1', { flow: 'unknown', halfSuitId: 'low_s' });
    expect(['ask', 'declare']).toContain(res.action);
  });
});

// ---------------------------------------------------------------------------
// completeBotFromPartial — ask flow, step 2 (half-suit only)
// ---------------------------------------------------------------------------

describe('completeBotFromPartial — ask, step 2 (half-suit only)', () => {
  it('9. returns a valid ask using a card from the specified half-suit', () => {
    // Give p3 the turn — p3 holds 8_h,9_h,10_h so CAN ask for high_h cards
    // on the opponent team (p4 holds 11_h,12_h,13_h).
    const gs = buildGame({ currentTurnPlayerId: 'p3' });
    const partial = { flow: 'ask', halfSuitId: 'high_h' };

    const result = completeBotFromPartial(gs, 'p3', partial);

    expect(result.action).toBe('ask');
    // The asked card must be in high_h (8,9,10,11,12,13 without 7)
    const hsMap      = buildHalfSuitMap('remove_7s');
    const highHCards = new Set(hsMap.get('high_h'));
    expect(highHCards.has(result.cardId)).toBe(true);

    // Validate via game engine to confirm legal
    const v = validateAsk(gs, 'p3', result.targetId, result.cardId);
    expect(v.valid).toBe(true);
  });

  it('10. falls back to decideBotMove if the half-suit is already declared', () => {
    const gs = buildGame();
    gs.declaredSuits.set('high_h', { teamId: 1, declaredBy: 'p1' });

    const result = completeBotFromPartial(gs, 'p3', { flow: 'ask', halfSuitId: 'high_h' });
    // Can't use high_h (declared) — must be a different action
    expect(['ask', 'declare']).toContain(result.action);
    if (result.action === 'ask') {
      const hsMap   = buildHalfSuitMap('remove_7s');
      const highHCards = new Set(hsMap.get('high_h'));
      // Should NOT ask for a card in the declared suit
      expect(highHCards.has(result.cardId)).toBe(false);
    }
  });

  it('11. falls back gracefully when no opponents have cards', () => {
    // Give all opponent cards to the bot's team (empty opponents)
    const gs = buildGame({
      handOverrides: {
        p1: new Set(['1_s','2_s','3_s','8_s','9_s','10_s','11_h','12_h','13_h']),
        p4: new Set(), // opponent p4 has no cards
        p5: new Set(), // opponent p5 has no cards
        p6: new Set(), // opponent p6 has no cards
      },
    });

    // With all opponents empty, the only legal action is declare
    const result = completeBotFromPartial(gs, 'p1', { flow: 'ask', halfSuitId: 'low_s' });
    // Must fall back to declare (ask not possible)
    expect(result.action).toBe('declare');
  });

  it('12. prefers opponent known to have the card via bot knowledge', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p3' });
    // Directly inject knowledge: p4 is known to hold 11_h
    if (!gs.botKnowledge.has('p4')) gs.botKnowledge.set('p4', new Map());
    gs.botKnowledge.get('p4').set('11_h', true);

    const result = completeBotFromPartial(gs, 'p3', { flow: 'ask', halfSuitId: 'high_h' });
    expect(result.action).toBe('ask');
    // Should prefer p4 since we know they have 11_h
    if (result.cardId === '11_h') {
      expect(result.targetId).toBe('p4');
    }
  });
});

// ---------------------------------------------------------------------------
// completeBotFromPartial — ask flow, step 3 (half-suit + card)
// ---------------------------------------------------------------------------

describe('completeBotFromPartial — ask, step 3 (half-suit + card)', () => {
  it('13. returns a valid ask using the specified card', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p3' });
    // p4 holds 11_h, p3 holds 8_h,9_h,10_h so p3 can ask for 11_h
    const partial = { flow: 'ask', halfSuitId: 'high_h', cardId: '11_h' };

    const result = completeBotFromPartial(gs, 'p3', partial);

    expect(result.action).toBe('ask');
    expect(result.cardId).toBe('11_h');

    const v = validateAsk(gs, 'p3', result.targetId, '11_h');
    expect(v.valid).toBe(true);
  });

  it('14. falls back to decideBotMove if the card is no longer askable', () => {
    const gs = buildGame();
    // Make 11_h already held by p3 (so p3 can't ask for it)
    gs.hands.get('p3').add('11_h');
    gs.hands.get('p4').delete('11_h');

    const partial = { flow: 'ask', halfSuitId: 'high_h', cardId: '11_h' };
    const result  = completeBotFromPartial(gs, 'p3', partial);

    // 11_h is now in p3's hand — can't ask for it; must use fallback
    expect(['ask', 'declare']).toContain(result.action);
    if (result.action === 'ask') {
      expect(result.cardId).not.toBe('11_h');
    }
  });

  it('15. prefers opponent known to have the card via bot knowledge', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p3' });
    // p4 holds 11_h; p5 also has cards but we don't know what.
    // Directly inject knowledge that p4 holds 11_h.
    if (!gs.botKnowledge.has('p4')) gs.botKnowledge.set('p4', new Map());
    gs.botKnowledge.get('p4').set('11_h', true);

    const partial = { flow: 'ask', halfSuitId: 'high_h', cardId: '11_h' };
    const result  = completeBotFromPartial(gs, 'p3', partial);

    expect(result.action).toBe('ask');
    expect(result.cardId).toBe('11_h');
    // Should pick p4 first since we know they have it
    expect(result.targetId).toBe('p4');
  });
});

// ---------------------------------------------------------------------------
// completeBotFromPartial — declare flow
// ---------------------------------------------------------------------------

describe('completeBotFromPartial — declare flow', () => {
  it('16. completes partial assignment so all 6 cards are covered', () => {
    // Give Team 1 all low_s cards: p1 has 1_s,2_s,3_s; p2 has 4_s,5_s,6_s
    const gs = buildGame({
      handOverrides: {
        p1: new Set(['1_s','2_s','3_s','8_s','9_s','10_s']),
        p2: new Set(['4_s','5_s','6_s','11_s','12_s','13_s']),
      },
    });

    // Player has partial assignment with only 1_s assigned
    const partial = {
      flow:       'declare',
      halfSuitId: 'low_s',
      assignment: { '1_s': 'p1' },
    };

    const result = completeBotFromPartial(gs, 'p1', partial);

    expect(result.action).toBe('declare');
    expect(result.halfSuitId).toBe('low_s');

    const hsMap = buildHalfSuitMap('remove_7s');
    const cards  = hsMap.get('low_s');
    for (const card of cards) {
      expect(result.assignment[card]).toBeTruthy();
    }
  });

  it('17. respects player\'s existing partial assignments (does not override them)', () => {
    const gs = buildGame({
      handOverrides: {
        p1: new Set(['1_s','2_s','3_s','8_s','9_s','10_s']),
        p2: new Set(['4_s','5_s','6_s','11_s','12_s','13_s']),
      },
    });

    // Player explicitly assigned 4_s to p2 (even though p2 holds it — matches reality)
    const partial = {
      flow:       'declare',
      halfSuitId: 'low_s',
      assignment: { '4_s': 'p2' },
    };

    const result = completeBotFromPartial(gs, 'p1', partial);

    expect(result.assignment['4_s']).toBe('p2');
  });

  it('18. falls back to decideBotMove if the half-suit is already declared', () => {
    const gs = buildGame();
    gs.declaredSuits.set('low_s', { teamId: 1, declaredBy: 'p1' });

    const result = completeBotFromPartial(gs, 'p1', {
      flow:       'declare',
      halfSuitId: 'low_s',
      assignment: {},
    });

    // Should not declare low_s again (it's already declared)
    if (result.action === 'declare') {
      expect(result.halfSuitId).not.toBe('low_s');
    }
  });

  it('19. uses actual hand data to fill assignment gaps', () => {
    // Give p1 all of low_s cards
    const gs = buildGame({
      handOverrides: {
        p1: new Set(['1_s','2_s','3_s','4_s','5_s','6_s','8_s','9_s']),
        p2: new Set(['10_s','11_s','12_s','13_s']),
      },
    });

    const partial = {
      flow:       'declare',
      halfSuitId: 'low_s',
      assignment: {},
    };

    const result = completeBotFromPartial(gs, 'p1', partial);

    if (result.action === 'declare' && result.halfSuitId === 'low_s') {
      // p1 holds all low_s cards, so all should be assigned to p1
      for (const [, assignee] of Object.entries(result.assignment)) {
        expect(['p1', 'p2', 'p3']).toContain(assignee); // must be team 1
      }
    }
  });

  it('20. result passes validateDeclaration when team holds all cards', () => {
    // Give team 1 all of low_s: p1 gets 1_s,2_s,3_s; p2 gets 4_s,5_s,6_s
    const gs = buildGame({
      handOverrides: {
        p1: new Set(['1_s','2_s','3_s','8_s','9_s','10_s']),
        p2: new Set(['4_s','5_s','6_s','11_s','12_s','13_s']),
        p3: new Set(['1_h','2_h','3_h','4_h','5_h','6_h']),
        p4: new Set(['8_h','9_h','10_h','11_h','12_h','13_h']),
        p5: new Set(['1_d','2_d','3_d','4_d','5_d','6_d']),
        p6: new Set(['8_d','9_d','10_d','11_d','12_d','13_d']),
      },
    });

    const partial = { flow: 'declare', halfSuitId: 'low_s', assignment: {} };
    const result  = completeBotFromPartial(gs, 'p1', partial);

    expect(result.action).toBe('declare');
    const v = validateDeclaration(gs, 'p1', result.halfSuitId, result.assignment);
    expect(v.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handlePartialSelection (gameSocketServer integration)
// ---------------------------------------------------------------------------

describe('handlePartialSelection (server integration)', () => {
  const {
    handlePartialSelection,
  } = require('../game/gameSocketServer');

  const { setGame } = require('../game/gameStore');

  beforeEach(() => {
    jest.useFakeTimers();
    clearPartialStore();
  });

  afterEach(() => {
    jest.useRealTimers();
    clearPartialStore();
  });

  it('21. stores partial state when player is active turn holder', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('BOTCMP', gs);

    handlePartialSelection('BOTCMP', 'p1', 'ask', 'low_s');

    expect(getPartialSelection('BOTCMP', 'p1')).toEqual({
      flow:       'ask',
      halfSuitId: 'low_s',
    });
  });

  it('22. ignores partial state when player is NOT the active turn holder', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p2' }); // p2 has the turn
    setGame('BOTCMP', gs);

    handlePartialSelection('BOTCMP', 'p1', 'ask', 'low_s'); // p1 is NOT active

    expect(getPartialSelection('BOTCMP', 'p1')).toBeNull();
  });

  it('23. ignores unknown flow values', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('BOTCMP', gs);

    handlePartialSelection('BOTCMP', 'p1', 'unknown_flow', 'low_s');

    expect(getPartialSelection('BOTCMP', 'p1')).toBeNull();
  });

  it('24. stores cardId for ask-step-3 partial', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('BOTCMP', gs);

    handlePartialSelection('BOTCMP', 'p1', 'ask', 'low_s', '4_s');

    expect(getPartialSelection('BOTCMP', 'p1')).toEqual({
      flow:       'ask',
      halfSuitId: 'low_s',
      cardId:     '4_s',
    });
  });

  it('25. stores assignment for declare partial', () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('BOTCMP', gs);

    const asgn = { '1_s': 'p1', '2_s': 'p2' };
    handlePartialSelection('BOTCMP', 'p1', 'declare', 'low_s', undefined, asgn);

    expect(getPartialSelection('BOTCMP', 'p1')).toEqual({
      flow:       'declare',
      halfSuitId: 'low_s',
      assignment: asgn,
    });
  });
});

// ---------------------------------------------------------------------------
// executeTimedOutTurn integration
// ---------------------------------------------------------------------------

describe('executeTimedOutTurn with partial state', () => {
  let mockDecideBotMove;
  let mockCompleteBotFromPartial;

  beforeEach(() => {
    jest.useFakeTimers();
    clearPartialStore();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
    clearPartialStore();
  });

  it('26. uses partial state from store when completing a timed-out ask', async () => {
    const {
      executeTimedOutTurn,
      cancelTurnTimer,
    } = require('../game/gameSocketServer');

    const { setGame, registerConnection, removeConnection } = require('../game/gameStore');

    // Set up a valid game with p1 having the turn
    const gs = buildGame({
      handOverrides: {
        // p1 and p2 hold low_s cards; p4 also gets 6_s so at least one
        // opponent (p4) has a low_s card — required because the server now
        // enforces that targets must hold ≥1 card in the requested half-suit.
        p1: new Set(['1_s','2_s','3_s','8_s','9_s']),
        p2: new Set(['4_s','5_s','11_s','12_s']),      // 6_s moved to p4
        p4: new Set(['6_s','13_s','1_h','2_h','3_h']), // +6_s (low_s)
        p5: new Set(['5_h','6_h','8_h','9_h','10_h']),
        p6: new Set(['11_h','12_h','13_h','1_d','2_d']),
      },
      currentTurnPlayerId: 'p1',
    });
    setGame('BOTCMP', gs);

    // Store partial state: p1 had chosen half-suit but not card
    setPartialSelection('BOTCMP', 'p1', { flow: 'ask', halfSuitId: 'low_s' });

    // Register a mock WS connection to capture broadcast
    const messages = [];
    const mockWs = {
      readyState: 1,
      send: (data) => messages.push(JSON.parse(data)),
    };
    registerConnection('BOTCMP', 'p1', mockWs);
    registerConnection('BOTCMP', 'p4', mockWs);

    await executeTimedOutTurn('BOTCMP', 'p1');

    // Verify bot_takeover was broadcast with the partial state
    const takeoverMsg = messages.find((m) => m.type === 'bot_takeover');
    expect(takeoverMsg).toBeDefined();
    expect(takeoverMsg.playerId).toBe('p1');
    expect(takeoverMsg.partialState).toEqual({ flow: 'ask', halfSuitId: 'low_s' });

    // Verify ask_result was broadcast (move was executed)
    const askResult = messages.find((m) => m.type === 'ask_result');
    expect(askResult).toBeDefined();
    expect(askResult.askerId).toBe('p1');

    // The asked card should be in low_s
    const hsMap   = buildHalfSuitMap('remove_7s');
    const lowSCards = new Set(hsMap.get('low_s'));
    expect(lowSCards.has(askResult.cardId)).toBe(true);

    removeConnection('BOTCMP', 'p1');
    removeConnection('BOTCMP', 'p4');
    cancelTurnTimer('BOTCMP');
  });

  it('27. clears partial state from the store after execution', async () => {
    const { executeTimedOutTurn, cancelTurnTimer } = require('../game/gameSocketServer');
    const { setGame, registerConnection, removeConnection } = require('../game/gameStore');

    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('BOTCMP', gs);
    setPartialSelection('BOTCMP', 'p1', { flow: 'ask', halfSuitId: 'low_s' });

    const mockWs = { readyState: 1, send: () => {} };
    registerConnection('BOTCMP', 'p1', mockWs);

    await executeTimedOutTurn('BOTCMP', 'p1');

    // Partial state should be cleared after execution
    expect(getPartialSelection('BOTCMP', 'p1')).toBeNull();

    removeConnection('BOTCMP', 'p1');
    cancelTurnTimer('BOTCMP');
  });

  it('28. broadcasts bot_takeover before executing the move', async () => {
    const { executeTimedOutTurn, cancelTurnTimer } = require('../game/gameSocketServer');
    const { setGame, registerConnection, removeConnection } = require('../game/gameStore');

    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('BOTCMP', gs);

    const messageOrder = [];
    const mockWs = {
      readyState: 1,
      send: (data) => {
        const msg = JSON.parse(data);
        messageOrder.push(msg.type);
      },
    };
    registerConnection('BOTCMP', 'p1', mockWs);

    await executeTimedOutTurn('BOTCMP', 'p1');

    // bot_takeover must appear before ask_result / declaration_result
    const takeoverIdx = messageOrder.indexOf('bot_takeover');
    const actionIdx   = Math.min(
      ...['ask_result', 'declaration_result']
        .map((t) => messageOrder.indexOf(t))
        .filter((i) => i !== -1),
    );
    expect(takeoverIdx).toBeGreaterThanOrEqual(0);
    if (actionIdx !== Infinity) {
      expect(takeoverIdx).toBeLessThan(actionIdx);
    }

    removeConnection('BOTCMP', 'p1');
    cancelTurnTimer('BOTCMP');
  });

  it('29. falls back gracefully when partial state is stale or invalid', async () => {
    const { executeTimedOutTurn, cancelTurnTimer } = require('../game/gameSocketServer');
    const { setGame, registerConnection, removeConnection } = require('../game/gameStore');

    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame('BOTCMP', gs);

    // Stale partial: references a half-suit that has been declared already
    gs.declaredSuits.set('low_s', { teamId: 1, declaredBy: 'p1' });
    setPartialSelection('BOTCMP', 'p1', { flow: 'ask', halfSuitId: 'low_s' });

    const messages = [];
    const mockWs   = { readyState: 1, send: (d) => messages.push(JSON.parse(d)) };
    registerConnection('BOTCMP', 'p1', mockWs);

    await executeTimedOutTurn('BOTCMP', 'p1');

    // Should not throw and should still produce a valid move
    const actionMsg = messages.find((m) =>
      m.type === 'ask_result' || m.type === 'declaration_result'
    );
    expect(actionMsg).toBeDefined();

    removeConnection('BOTCMP', 'p1');
    cancelTurnTimer('BOTCMP');
  });
});
