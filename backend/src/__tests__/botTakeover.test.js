'use strict';

/**
 * Unit tests for the bot-takeover feature.
 *
 * When a human player's turn timer expires:
 * 1. The server reads any partial selection state reported by the player.
 * 2. Broadcasts a `bot_takeover` event with that partial state (or null).
 * 3. Uses `completeBotFromPartial` to finish the move using the partial context.
 * 4. Partial state is cleared after takeover (even if no action executed).
 *
 * Complementary coverage for handlePartialSelection:
 * 5. Stores partial state only when it's the sender's turn.
 * 6. Ignores messages from non-active players.
 * 7. Requires a valid `flow` field ('ask' or 'declare').
 * 8. Requires a halfSuitId.
 * 9. Stores { flow: 'ask', halfSuitId } after step 1 of the wizard.
 * 10. Stores { flow: 'ask', halfSuitId, cardId } after step 2 of the wizard.
 * 11. Partial state is cleared when the active player makes a valid ask.
 * 12. Partial state is cleared when the active player makes a valid declaration.
 */

const {
  scheduleTurnTimerIfNeeded,
  cancelTurnTimer,
  handleAskCard,
  handleDeclare,
  handlePartialSelection,
  executeTimedOutTurn,
} = require('../game/gameSocketServer');

const { setGame, getGame, registerConnection, removeConnection } = require('../game/gameStore');
const { createGameState } = require('../game/gameState');
const { getPartialSelection, _clearAll: clearAllPartial } = require('../game/partialSelectionStore');

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../db/supabase', () => ({
  getSupabaseClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      rpc:    () => Promise.resolve({ error: null }),
    }),
    auth: { getUser: async () => ({ data: null, error: new Error('mock') }) },
  }),
}));

jest.mock('../sessions/guestSessionStore', () => ({
  getGuestSession: () => null,
}));

jest.mock('../liveGames/liveGamesStore', () => ({
  addGame:    jest.fn(),
  updateGame: jest.fn(),
  removeGame: jest.fn(),
  get:        jest.fn().mockReturnValue(null),
}));

const mockDecideBotMove        = jest.fn();
const mockCompleteBotFromPartial = jest.fn();

jest.mock('../game/botLogic', () => ({
  decideBotMove:                   (...args) => mockDecideBotMove(...args),
  completeBotFromPartial:          (...args) => mockCompleteBotFromPartial(...args),
  updateKnowledgeAfterAsk:         jest.fn(),
  updateKnowledgeAfterDeclaration: jest.fn(),
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

const ROOM = 'TAKEO1';

function makeGame({ status = 'active', currentPlayer = 'p1' } = {}) {
  const seats = ['p1','p2','p3','p4','p5','p6'].map((id, idx) => ({
    seatIndex:   idx,
    playerId:    id,
    displayName: `Player ${id}`,
    avatarId:    null,
    teamId:      idx % 2 === 0 ? 1 : 2,
    isBot:       false,
    isGuest:     false,
  }));

  const gs = createGameState({
    roomCode:    ROOM,
    roomId:      'room-uuid-takeover',
    variant:     'remove_7s',
    playerCount: 6,
    seats,
  });
  gs.status              = status;
  gs.currentTurnPlayerId = currentPlayer;
  return gs;
}

function makeMockWs() {
  const msgs = [];
  return {
    readyState: 1, // WebSocket.OPEN
    send: (data) => msgs.push(JSON.parse(data)),
    _messages: msgs,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();

  // Default: completeBotFromPartial falls back to pass (tests override as needed)
  mockCompleteBotFromPartial.mockReturnValue({ action: 'pass' });
  mockDecideBotMove.mockReturnValue({ action: 'pass' });

  clearAllPartial();

  try { setGame(ROOM, null); } catch { /* ok */ }
});

afterEach(() => {
  jest.useRealTimers();
  cancelTurnTimer(ROOM);

  // Clean up any registered connections
  removeConnection(ROOM, 'p1');
  removeConnection(ROOM, 'p2');
  removeConnection(ROOM, 'p3');

  clearAllPartial();
});

// ---------------------------------------------------------------------------
// handlePartialSelection
// ---------------------------------------------------------------------------

describe('handlePartialSelection', () => {
  it('5. stores partial state when it is the sender\'s turn', () => {
    const gs = makeGame({ currentPlayer: 'p1' });
    setGame(ROOM, gs);

    handlePartialSelection(ROOM, 'p1', 'ask', 'low_s', undefined, undefined);

    const stored = getPartialSelection(ROOM, 'p1');
    expect(stored).not.toBeNull();
    expect(stored.flow).toBe('ask');
    expect(stored.halfSuitId).toBe('low_s');
  });

  it('6. ignores partial_selection from a non-active player', () => {
    const gs = makeGame({ currentPlayer: 'p1' });
    setGame(ROOM, gs);

    // p2 is NOT the current player
    handlePartialSelection(ROOM, 'p2', 'ask', 'low_s', undefined, undefined);

    expect(getPartialSelection(ROOM, 'p2')).toBeNull();
  });

  it('7. ignores partial_selection with an unknown flow', () => {
    const gs = makeGame({ currentPlayer: 'p1' });
    setGame(ROOM, gs);

    handlePartialSelection(ROOM, 'p1', 'invalid_flow', 'low_s', undefined, undefined);

    expect(getPartialSelection(ROOM, 'p1')).toBeNull();
  });

  it('8. ignores partial_selection with no halfSuitId', () => {
    const gs = makeGame({ currentPlayer: 'p1' });
    setGame(ROOM, gs);

    handlePartialSelection(ROOM, 'p1', 'ask', undefined, undefined, undefined);

    expect(getPartialSelection(ROOM, 'p1')).toBeNull();
  });

  it('9. stores { flow: ask, halfSuitId } after step 1 of the ask wizard', () => {
    const gs = makeGame({ currentPlayer: 'p1' });
    setGame(ROOM, gs);

    handlePartialSelection(ROOM, 'p1', 'ask', 'high_d', undefined, undefined);

    const stored = getPartialSelection(ROOM, 'p1');
    expect(stored).toEqual({ flow: 'ask', halfSuitId: 'high_d' });
  });

  it('10. stores { flow: ask, halfSuitId, cardId } after step 2 of the ask wizard', () => {
    const gs = makeGame({ currentPlayer: 'p1' });
    setGame(ROOM, gs);

    handlePartialSelection(ROOM, 'p1', 'ask', 'high_d', '11_d', undefined);

    const stored = getPartialSelection(ROOM, 'p1');
    expect(stored).toEqual({ flow: 'ask', halfSuitId: 'high_d', cardId: '11_d' });
  });

  it('ignores when game is not active', () => {
    const gs = makeGame({ status: 'completed', currentPlayer: 'p1' });
    setGame(ROOM, gs);

    handlePartialSelection(ROOM, 'p1', 'ask', 'low_s', undefined, undefined);

    expect(getPartialSelection(ROOM, 'p1')).toBeNull();
  });

  it('ignores when game is not found', () => {
    // No game set for ROOM
    expect(() => {
      handlePartialSelection(ROOM, 'p1', 'ask', 'low_s', undefined, undefined);
    }).not.toThrow();
    expect(getPartialSelection(ROOM, 'p1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// executeTimedOutTurn — bot_takeover broadcast
// ---------------------------------------------------------------------------

describe('executeTimedOutTurn — bot_takeover broadcast', () => {
  it('broadcasts bot_takeover with null partialState when no partial selection stored', async () => {
    const gs = makeGame({ currentPlayer: 'p1' });
    setGame(ROOM, gs);

    const ws1 = makeMockWs();
    const ws2 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);
    registerConnection(ROOM, 'p2', ws2);

    await executeTimedOutTurn(ROOM, 'p1');

    const takeover1 = ws1._messages.find((m) => m.type === 'bot_takeover');
    expect(takeover1).toBeDefined();
    expect(takeover1.playerId).toBe('p1');
    expect(takeover1.partialState).toBeNull();

    const takeover2 = ws2._messages.find((m) => m.type === 'bot_takeover');
    expect(takeover2).toBeDefined();
    expect(takeover2.partialState).toBeNull();
  });

  it('broadcasts bot_takeover with partial state when step 1 was completed', async () => {
    const gs = makeGame({ currentPlayer: 'p1' });
    setGame(ROOM, gs);

    // Player reported step 1 completion
    handlePartialSelection(ROOM, 'p1', 'ask', 'low_s', undefined, undefined);

    const ws1 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);

    await executeTimedOutTurn(ROOM, 'p1');

    const takeover = ws1._messages.find((m) => m.type === 'bot_takeover');
    expect(takeover).toBeDefined();
    expect(takeover.playerId).toBe('p1');
    expect(takeover.partialState).toEqual({ flow: 'ask', halfSuitId: 'low_s' });
  });

  it('broadcasts bot_takeover with partial state when step 2 was completed', async () => {
    const gs = makeGame({ currentPlayer: 'p1' });
    setGame(ROOM, gs);

    // Player reported step 2 completion (half-suit + card chosen)
    handlePartialSelection(ROOM, 'p1', 'ask', 'high_d', '11_d', undefined);

    const ws1 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);

    await executeTimedOutTurn(ROOM, 'p1');

    const takeover = ws1._messages.find((m) => m.type === 'bot_takeover');
    expect(takeover).toBeDefined();
    expect(takeover.partialState).toEqual({
      flow:       'ask',
      halfSuitId: 'high_d',
      cardId:     '11_d',
    });
  });

  it('broadcasts bot_takeover to ALL connected clients in the room', async () => {
    const gs = makeGame({ currentPlayer: 'p1' });
    setGame(ROOM, gs);

    const ws1 = makeMockWs();
    const ws2 = makeMockWs();
    const ws3 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);
    registerConnection(ROOM, 'p2', ws2);
    registerConnection(ROOM, 'p3', ws3);

    await executeTimedOutTurn(ROOM, 'p1');

    expect(ws1._messages.some((m) => m.type === 'bot_takeover')).toBe(true);
    expect(ws2._messages.some((m) => m.type === 'bot_takeover')).toBe(true);
    expect(ws3._messages.some((m) => m.type === 'bot_takeover')).toBe(true);
  });

  it('clears partial state from the store after takeover', async () => {
    const gs = makeGame({ currentPlayer: 'p1' });
    setGame(ROOM, gs);

    handlePartialSelection(ROOM, 'p1', 'ask', 'low_s', undefined, undefined);
    expect(getPartialSelection(ROOM, 'p1')).not.toBeNull();

    const ws1 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);

    await executeTimedOutTurn(ROOM, 'p1');

    // After takeover, partial state must be cleared
    expect(getPartialSelection(ROOM, 'p1')).toBeNull();
  });

  it('passes partial state to completeBotFromPartial', async () => {
    const gs = makeGame({ currentPlayer: 'p1' });
    setGame(ROOM, gs);

    const partial = { flow: 'ask', halfSuitId: 'low_s' };
    handlePartialSelection(ROOM, 'p1', 'ask', 'low_s', undefined, undefined);

    const ws1 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);

    await executeTimedOutTurn(ROOM, 'p1');

    expect(mockCompleteBotFromPartial).toHaveBeenCalledWith(
      expect.objectContaining({ roomCode: ROOM }),
      'p1',
      partial,
    );
  });

  it('passes null to completeBotFromPartial when no partial state', async () => {
    const gs = makeGame({ currentPlayer: 'p1' });
    setGame(ROOM, gs);

    const ws1 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);

    await executeTimedOutTurn(ROOM, 'p1');

    expect(mockCompleteBotFromPartial).toHaveBeenCalledWith(
      expect.objectContaining({ roomCode: ROOM }),
      'p1',
      null,
    );
  });

  it('does nothing when game is not found', async () => {
    // Ensure no game is set
    await expect(executeTimedOutTurn(ROOM, 'p1')).resolves.not.toThrow();
    expect(mockCompleteBotFromPartial).not.toHaveBeenCalled();
  });

  it('does nothing when game is not active', async () => {
    const gs = makeGame({ status: 'completed', currentPlayer: 'p1' });
    setGame(ROOM, gs);

    await executeTimedOutTurn(ROOM, 'p1');

    expect(mockCompleteBotFromPartial).not.toHaveBeenCalled();
  });

  it('does nothing when turn has already passed to another player', async () => {
    const gs = makeGame({ currentPlayer: 'p2' }); // p1's timer fires but it's now p2's turn
    setGame(ROOM, gs);

    await executeTimedOutTurn(ROOM, 'p1');

    expect(mockCompleteBotFromPartial).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Partial state cleared on valid move (11, 12)
// ---------------------------------------------------------------------------

describe('Partial state cleared on valid move', () => {
  /**
   * Helper: force a known, valid ask scenario.
   * - p1 holds '1_s' (low_s for remove_7s variant).
   * - p2 holds '2_s' (same half-suit, different card — valid to ask).
   * Returns the card to ask for ('2_s').
   */
  function setupKnownAsk(gs) {
    const card1 = '1_s'; // p1 holds this
    const card2 = '2_s'; // p2 holds this — p1 will ask for it

    // Remove both cards from all players first, then re-assign deterministically
    for (const pid of gs.players.map((p) => p.playerId)) {
      gs.hands.get(pid)?.delete(card1);
      gs.hands.get(pid)?.delete(card2);
    }
    gs.hands.get('p1').add(card1);
    gs.hands.get('p2').add(card2);

    return card2; // the card p1 will ask p2 for
  }

  it('11. clears partial state when the active player makes a valid ask', async () => {
    const gs = makeGame({ currentPlayer: 'p1' });
    setGame(ROOM, gs);

    const cardToAsk = setupKnownAsk(gs);

    // Store partial selection for p1
    handlePartialSelection(ROOM, 'p1', 'ask', 'low_s', undefined, undefined);
    expect(getPartialSelection(ROOM, 'p1')).not.toBeNull();

    const ws1 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);

    // Ask p2 for '2_s' — p1 holds '1_s' (same half-suit low_s), p2 holds '2_s': valid
    await handleAskCard(ROOM, 'p1', 'p2', cardToAsk, ws1, false);

    // Partial state must be cleared after a valid ask (regardless of success)
    expect(getPartialSelection(ROOM, 'p1')).toBeNull();
  });

  it('12. clears partial state when the active player makes a valid declaration', async () => {
    const gs = makeGame({ currentPlayer: 'p1' });
    setGame(ROOM, gs);

    // Force the game state so p1's team holds all 6 cards of low_c (for a valid declaration)
    // This requires directly manipulating the game state for testing purposes
    const variant = gs.variant;
    const { buildHalfSuitMap } = require('../game/halfSuits');
    const halfSuitsMap = buildHalfSuitMap(variant);
    const lowCCards = halfSuitsMap.get('low_c') ?? [];

    // Assign all low_c cards to team 1 players (p1 and p3 and p5)
    const team1Players = gs.players.filter((p) => p.teamId === 1).map((p) => p.playerId);
    let cardIdx = 0;
    for (const card of lowCCards) {
      // Remove from all hands first
      for (const pid of gs.players.map((p) => p.playerId)) {
        gs.hands.get(pid)?.delete(card);
      }
      // Assign to team 1 players in round-robin
      const targetPlayer = team1Players[cardIdx % team1Players.length];
      gs.hands.get(targetPlayer)?.add(card);
      cardIdx++;
    }

    // Store partial state for p1
    handlePartialSelection(ROOM, 'p1', 'declare', 'low_c', undefined, undefined);
    expect(getPartialSelection(ROOM, 'p1')).not.toBeNull();

    const ws1 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);

    // Build a valid assignment
    const assignment = {};
    for (const card of lowCCards) {
      let holder = null;
      for (const pid of team1Players) {
        if (gs.hands.get(pid)?.has(card)) {
          holder = pid;
          break;
        }
      }
      if (holder) assignment[card] = holder;
    }

    // Only attempt declaration if we have a complete assignment
    if (Object.keys(assignment).length === lowCCards.length) {
      await handleDeclare(ROOM, 'p1', 'low_c', assignment, ws1, false);
      expect(getPartialSelection(ROOM, 'p1')).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// bot_takeover broadcast order
// ---------------------------------------------------------------------------

describe('bot_takeover broadcast precedes the move result', () => {
  it('bot_takeover message arrives before ask_result in the message queue', async () => {
    const gs = makeGame({ currentPlayer: 'p1' });

    // Deterministically set up hands: p1 holds '1_s', p2 holds '2_s' (valid ask)
    for (const pid of gs.players.map((p) => p.playerId)) {
      gs.hands.get(pid)?.delete('1_s');
      gs.hands.get(pid)?.delete('2_s');
    }
    gs.hands.get('p1').add('1_s');
    gs.hands.get('p2').add('2_s');

    setGame(ROOM, gs);

    // completeBotFromPartial returns a valid ask for the deterministic setup
    mockCompleteBotFromPartial.mockReturnValue({
      action:   'ask',
      targetId: 'p2',
      cardId:   '2_s',
    });

    const ws1 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);

    await executeTimedOutTurn(ROOM, 'p1');

    const takeoverIdx  = ws1._messages.findIndex((m) => m.type === 'bot_takeover');
    const askResultIdx = ws1._messages.findIndex((m) => m.type === 'ask_result');

    // Both events must be present
    expect(takeoverIdx).toBeGreaterThanOrEqual(0);
    expect(askResultIdx).toBeGreaterThanOrEqual(0);

    // bot_takeover must arrive before ask_result
    expect(takeoverIdx).toBeLessThan(askResultIdx);
  });
});
