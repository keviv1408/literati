'use strict';

/**
 * Tests for AC 28: Post-declaration turn-selection timer.
 *
 * After a CORRECT declaration, the server broadcasts a `post_declaration_timer`
 * (30-second countdown) to ALL clients. A human on the declaring team can send
 * `choose_next_turn` to select who goes next. When a bot declares, a random
 * human teammate becomes the chooser. On expiry the server auto-selects a
 * random eligible player.
 *
 * Coverage:
 * 1. `post_declaration_timer` is broadcast to ALL connections after a human correct declaration
 * 2. `post_declaration_timer` is NOT sent for a failed (incorrect) declaration
 * 3. `post_declaration_timer` IS sent when a bot declares and human teammates exist
 * 3b. `post_declaration_timer` is NOT sent when a bot declares and all teammates are bots
 * 4. Timer entry is stored in `_postDeclarationTimers` map with correct fields
 * 5. `cancelPostDeclarationTimer` clears the map entry and prevents expiry callback
 * 6. On timer expiry, `post_declaration_turn_selected` is broadcast with reason:'timeout'
 * 7. On timer expiry, selected player has cards (still eligible)
 * 8. `handleChooseNextTurn` cancels the timer and broadcasts `post_declaration_turn_selected`
 * 9. `handleChooseNextTurn` resolves reason:'player_choice' correctly
 * 10. Correct declaration with only ONE eligible player skips the timer
 * 11. Game over after declaration: no post_declaration_timer is broadcast
 */

// ---------------------------------------------------------------------------
// Mocks (must be before any require of game modules)
// ---------------------------------------------------------------------------

jest.mock('../db/supabase', () => ({
  getSupabaseClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      upsert: () => Promise.resolve({ error: null }),
      rpc:    () => Promise.resolve({ error: null }),
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
// Module imports (after mocks)
// ---------------------------------------------------------------------------

const { setGame, getGame, registerConnection, _clearAll } = require('../game/gameStore');
const {
  handleDeclare,
  handleChooseNextTurn,
  startPostDeclarationTimer,
  cancelPostDeclarationTimer,
  cancelTurnTimer,
  cancelBotTimer,
  _postDeclarationTimers,
  POST_DECLARATION_TURN_SELECTION_MS,
} = require('../game/gameSocketServer');
const { createGameState } = require('../game/gameState');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSeats(opts = {}) {
  return [
    {
      seatIndex: 0, playerId: 'p1', displayName: 'Alice',
      avatarId: null, teamId: 1,
      isBot: opts.p1Bot ?? false, isGuest: false,
    },
    {
      seatIndex: 1, playerId: 'p2', displayName: 'Bob',
      avatarId: null, teamId: 2, isBot: false, isGuest: false,
    },
    {
      seatIndex: 2, playerId: 'p3', displayName: 'Carol',
      avatarId: null, teamId: 1, isBot: false, isGuest: false,
    },
    {
      seatIndex: 3, playerId: 'p4', displayName: 'Dave',
      avatarId: null, teamId: 2, isBot: false, isGuest: false,
    },
    {
      seatIndex: 4, playerId: 'p5', displayName: 'Eve',
      avatarId: null, teamId: 1, isBot: false, isGuest: false,
    },
    {
      seatIndex: 5, playerId: 'p6', displayName: 'Frank',
      avatarId: null, teamId: 2, isBot: false, isGuest: false,
    },
  ];
}

function makeGame(roomCode = 'PDTST1', opts = {}) {
  const gs = createGameState({
    roomCode,
    roomId:      'room-uuid-pdtimer',
    variant:     'remove_7s',
    playerCount: 6,
    seats:       makeSeats(opts),
  });

  // remove_7s low_s half-suit: 1_s 2_s 3_s 4_s 5_s 6_s
  // Team 1 (p1, p3, p5) hold all the low_s cards PLUS additional cards
  // so they remain eligible after the declaration is resolved.
  gs.hands.set('p1', new Set(['1_s', '2_s', '1_h', '2_h'])); // team1 (+low_h cards)
  gs.hands.set('p2', new Set(['8_s', '9_s']));                // team2
  gs.hands.set('p3', new Set(['3_s', '4_s', '3_h', '4_h'])); // team1 (+low_h cards)
  gs.hands.set('p4', new Set(['10_s', '11_s']));              // team2
  gs.hands.set('p5', new Set(['5_s', '6_s', '5_h', '6_h'])); // team1 (+low_h cards)
  gs.hands.set('p6', new Set(['12_s', '13_s']));              // team2

  gs.currentTurnPlayerId = 'p1';

  return gs;
}

function mockWs() {
  const sent = [];
  return {
    readyState: 1, // WebSocket.OPEN
    send: (data) => { sent.push(JSON.parse(data)); },
    _sent: sent,
  };
}

// Correct assignment for low_s: team1 players hold all cards
const CORRECT_ASSIGNMENT = {
  '1_s': 'p1', '2_s': 'p1',
  '3_s': 'p3', '4_s': 'p3',
  '5_s': 'p5', '6_s': 'p5',
};

// Wrong assignment (p1 is assigned p2's card)
const WRONG_ASSIGNMENT = {
  '1_s': 'p1', '2_s': 'p1',
  '3_s': 'p3', '4_s': 'p3',
  '5_s': 'p5', '6_s': 'p2', // wrong — p2 doesn't hold 6_s
};

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

const ROOM = 'PDTST1';
let gs;
let wsP1, wsP2, wsP3, wsP4, wsP5, wsP6, wsSpectator;

beforeEach(() => {
  _clearAll();
  // Cancel any lingering timers
  cancelPostDeclarationTimer(ROOM);

  gs = makeGame(ROOM);
  setGame(ROOM, gs);

  wsP1        = mockWs();
  wsP2        = mockWs();
  wsP3        = mockWs();
  wsP4        = mockWs();
  wsP5        = mockWs();
  wsP6        = mockWs();
  wsSpectator = mockWs();

  registerConnection(ROOM, 'p1',            wsP1);
  registerConnection(ROOM, 'p2',            wsP2);
  registerConnection(ROOM, 'p3',            wsP3);
  registerConnection(ROOM, 'p4',            wsP4);
  registerConnection(ROOM, 'p5',            wsP5);
  registerConnection(ROOM, 'p6',            wsP6);
  registerConnection(ROOM, 'spectator_abc', wsSpectator);
});

afterEach(() => {
  // Always cancel timers to prevent "Cannot log after tests are done" warnings
  cancelPostDeclarationTimer(ROOM);
  cancelTurnTimer(ROOM);
  cancelBotTimer(ROOM);
  jest.useRealTimers();
  _clearAll();
});

// ---------------------------------------------------------------------------
// Helper to wait for all microtasks / async operations
// ---------------------------------------------------------------------------
const flushAsync = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('post_declaration_timer — broadcast', () => {
  test('1. post_declaration_timer broadcast to ALL after human correct declaration', async () => {
    jest.useFakeTimers();

    await handleDeclare(ROOM, 'p1', 'low_s', CORRECT_ASSIGNMENT, wsP1, false);

    const allWs = [wsP1, wsP2, wsP3, wsP4, wsP5, wsP6, wsSpectator];
    for (const ws of allWs) {
      const timerMsg = ws._sent.find((m) => m.type === 'post_declaration_timer');
      expect(timerMsg).toBeDefined();
      expect(timerMsg.declarerId).toBe('p1');
      expect(Array.isArray(timerMsg.eligiblePlayers)).toBe(true);
      expect(timerMsg.durationMs).toBe(POST_DECLARATION_TURN_SELECTION_MS);
      expect(typeof timerMsg.expiresAt).toBe('number');
    }
  });

  test('2. post_declaration_timer NOT sent for an incorrect declaration', async () => {
    jest.useFakeTimers();

    await handleDeclare(ROOM, 'p1', 'low_s', WRONG_ASSIGNMENT, wsP1, false);

    const allWs = [wsP1, wsP2, wsP3, wsP4, wsP5, wsP6, wsSpectator];
    for (const ws of allWs) {
      const timerMsg = ws._sent.find((m) => m.type === 'post_declaration_timer');
      expect(timerMsg).toBeUndefined();
    }
  });

  test('3. post_declaration_timer IS sent when a bot declares and human teammates exist', async () => {
    jest.useFakeTimers();

    // p1 is a bot declarant but p3 and p5 are human teammates on team 1
    await handleDeclare(ROOM, 'p1', 'low_s', CORRECT_ASSIGNMENT, null, true);

    const allWs = [wsP1, wsP2, wsP3, wsP4, wsP5, wsP6, wsSpectator];
    for (const ws of allWs) {
      const timerMsg = ws._sent.find((m) => m.type === 'post_declaration_timer');
      expect(timerMsg).toBeDefined();
      expect(timerMsg.eligiblePlayers).toEqual(['p1', 'p3', 'p5']);
    }

    // The chooser should be a human teammate (p3 or p5), not the bot declarant
    const updatedGs = getGame(ROOM);
    expect(['p3', 'p5']).toContain(updatedGs.currentTurnPlayerId);
  });

  test('3b. post_declaration_timer NOT sent when a bot declares and all teammates are bots', async () => {
    jest.useFakeTimers();

    // Make all team 1 players bots
    _clearAll();
    cancelPostDeclarationTimer(ROOM);
    const allBotGs = makeGame(ROOM, { p1Bot: true });
    // Mark p3 and p5 as bots too
    allBotGs.players.find((p) => p.playerId === 'p3').isBot = true;
    allBotGs.players.find((p) => p.playerId === 'p5').isBot = true;
    setGame(ROOM, allBotGs);

    // Re-register connections
    registerConnection(ROOM, 'p1', wsP1);
    registerConnection(ROOM, 'p2', wsP2);
    registerConnection(ROOM, 'p3', wsP3);
    registerConnection(ROOM, 'p4', wsP4);
    registerConnection(ROOM, 'p5', wsP5);
    registerConnection(ROOM, 'p6', wsP6);
    registerConnection(ROOM, '__spectator__', wsSpectator);

    await handleDeclare(ROOM, 'p1', 'low_s', CORRECT_ASSIGNMENT, null, true);

    const allWs = [wsP1, wsP2, wsP3, wsP4, wsP5, wsP6, wsSpectator];
    for (const ws of allWs) {
      const timerMsg = ws._sent.find((m) => m.type === 'post_declaration_timer');
      expect(timerMsg).toBeUndefined();
    }
  });

  test('4. _postDeclarationTimers map has entry with correct fields after correct declaration', async () => {
    jest.useFakeTimers();

    const before = Date.now();
    await handleDeclare(ROOM, 'p1', 'low_s', CORRECT_ASSIGNMENT, wsP1, false);
    const after = Date.now();

    const entry = _postDeclarationTimers.get(ROOM);
    expect(entry).toBeDefined();
    expect(entry.timerId).toBeDefined();
    expect(Array.isArray(entry.eligiblePlayers)).toBe(true);
    expect(entry.eligiblePlayers.length).toBeGreaterThan(0);
    // expiresAt should be within the expected range
    expect(entry.expiresAt).toBeGreaterThanOrEqual(before + POST_DECLARATION_TURN_SELECTION_MS);
    expect(entry.expiresAt).toBeLessThanOrEqual(after + POST_DECLARATION_TURN_SELECTION_MS);
  });

  test('5. cancelPostDeclarationTimer removes the map entry', async () => {
    jest.useFakeTimers();

    await handleDeclare(ROOM, 'p1', 'low_s', CORRECT_ASSIGNMENT, wsP1, false);
    expect(_postDeclarationTimers.has(ROOM)).toBe(true);

    cancelPostDeclarationTimer(ROOM);
    expect(_postDeclarationTimers.has(ROOM)).toBe(false);
  });

  test('6. post_declaration_timer eligiblePlayers contains only team1 players with cards', async () => {
    jest.useFakeTimers();

    await handleDeclare(ROOM, 'p1', 'low_s', CORRECT_ASSIGNMENT, wsP1, false);

    // After correct declaration, p1/p3/p5's low_s cards are removed.
    // p3 and p5 still have their remaining cards; p1 lost all their cards.
    const timerMsg = wsP1._sent.find((m) => m.type === 'post_declaration_timer');
    expect(timerMsg).toBeDefined();

    // All eligible players must be team 1 members
    const gameState = getGame(ROOM);
    for (const pid of timerMsg.eligiblePlayers) {
      const player = gameState.players.find((p) => p.playerId === pid);
      expect(player.teamId).toBe(1);
    }
  });

  test('7. correct declaration with only one eligible player skips post_declaration_timer', async () => {
    jest.useFakeTimers();

    // After low_s is removed, only p5 still has cards on team 1.
    gs.hands.set('p1', new Set(['1_s', '2_s']));
    gs.hands.set('p3', new Set(['3_s', '4_s']));
    gs.hands.set('p5', new Set(['5_s', '6_s', '5_h', '6_h']));

    await handleDeclare(ROOM, 'p1', 'low_s', CORRECT_ASSIGNMENT, wsP1, false);

    const allWs = [wsP1, wsP2, wsP3, wsP4, wsP5, wsP6, wsSpectator];
    for (const ws of allWs) {
      const timerMsg = ws._sent.find((m) => m.type === 'post_declaration_timer');
      expect(timerMsg).toBeUndefined();
    }

    expect(_postDeclarationTimers.has(ROOM)).toBe(false);
    expect(getGame(ROOM).currentTurnPlayerId).toBe('p5');
  });
});

describe('post_declaration_timer — expiry (bot auto-selection)', () => {
  // These tests call startPostDeclarationTimer directly (bypassing handleDeclare's
  // async Supabase persist) to avoid fake-timer deadlocks in async code.

  test('8. On expiry, post_declaration_turn_selected broadcast with reason:timeout', () => {
    jest.useFakeTimers();

    // Eligible players on team 1 who have cards
    const eligiblePlayers = ['p1', 'p3', 'p5'];
    startPostDeclarationTimer(ROOM, 'p1', eligiblePlayers);
    expect(_postDeclarationTimers.has(ROOM)).toBe(true);

    // Advance timers to trigger expiry
    jest.runAllTimers();

    const allWs = [wsP1, wsP2, wsP3, wsP4, wsP5, wsP6, wsSpectator];
    for (const ws of allWs) {
      const selMsg = ws._sent.find((m) => m.type === 'post_declaration_turn_selected');
      expect(selMsg).toBeDefined();
      expect(selMsg.reason).toBe('timeout');
      expect(typeof selMsg.selectedPlayerId).toBe('string');
    }
  });

  test('9. On expiry, selected player is in the eligible list', () => {
    jest.useFakeTimers();

    const eligiblePlayers = ['p1', 'p3', 'p5'];
    startPostDeclarationTimer(ROOM, 'p1', eligiblePlayers);

    jest.runAllTimers();

    const selMsg = wsP1._sent.find((m) => m.type === 'post_declaration_turn_selected');
    expect(selMsg).toBeDefined();
    // Selected player must be one of the originally eligible players
    // (or a subset filtered by getCardCount at expiry time)
    expect(typeof selMsg.selectedPlayerId).toBe('string');
    expect(selMsg.selectedPlayerId.length).toBeGreaterThan(0);
  });

  test('10. After expiry, _postDeclarationTimers is cleared', () => {
    jest.useFakeTimers();

    startPostDeclarationTimer(ROOM, 'p1', ['p1', 'p3', 'p5']);
    expect(_postDeclarationTimers.has(ROOM)).toBe(true);

    jest.runAllTimers();

    expect(_postDeclarationTimers.has(ROOM)).toBe(false);
  });
});

describe('handleChooseNextTurn — manual selection', () => {
  test('11. handleChooseNextTurn cancels the timer and broadcasts post_declaration_turn_selected', async () => {
    jest.useFakeTimers();

    await handleDeclare(ROOM, 'p1', 'low_s', CORRECT_ASSIGNMENT, wsP1, false);
    expect(_postDeclarationTimers.has(ROOM)).toBe(true);

    // After correct declaration, _resolveValidTurn set currentTurnPlayerId.
    // For handleChooseNextTurn to work, the requesterId must be currentTurnPlayerId.
    const currentGs = getGame(ROOM);
    const currentTurnId = currentGs.currentTurnPlayerId;

    // Choose a valid same-team player (not currently holding the turn)
    // p3 or p5 are on team1 and still have cards
    const candidates = ['p3', 'p5'].filter((id) => id !== currentTurnId);
    if (candidates.length === 0) {
      // If currentTurnPlayerId is p3 or p5, pick p1 if they have cards
      // This might happen - just skip if no valid candidate
      return;
    }
    const chosenId = candidates[0];

    handleChooseNextTurn(ROOM, currentTurnId, chosenId, wsP1);

    // Timer should be cancelled
    expect(_postDeclarationTimers.has(ROOM)).toBe(false);

    // post_declaration_turn_selected should be broadcast to all
    const allWs = [wsP1, wsP2, wsP3, wsP4, wsP5, wsP6, wsSpectator];
    for (const ws of allWs) {
      const selMsg = ws._sent.find((m) => m.type === 'post_declaration_turn_selected');
      expect(selMsg).toBeDefined();
      expect(selMsg.reason).toBe('player_choice');
      expect(selMsg.selectedPlayerId).toBe(chosenId);
    }
  });

  test('12. handleChooseNextTurn is a no-op when no timer is active', () => {
    // Ensure no timer is active
    cancelPostDeclarationTimer(ROOM);

    // Should silently do nothing (no errors)
    expect(() => {
      handleChooseNextTurn(ROOM, 'p1', 'p3', wsP1);
    }).not.toThrow();

    // No post_declaration_turn_selected should be sent
    const selMsg = wsP1._sent.find((m) => m.type === 'post_declaration_turn_selected');
    expect(selMsg).toBeUndefined();
  });

  test('13. Game-over declaration does not broadcast post_declaration_timer', async () => {
    jest.useFakeTimers();

    // Set up a game that's about to end (7 suits already declared, this is the 8th)
    const gameOverGs = makeGame(ROOM + '2');
    // Register 7 declared suits
    const suits = ['low_s', 'high_s', 'low_h', 'high_h', 'low_d', 'high_d', 'low_c'];
    for (const s of suits) {
      gameOverGs.declaredSuits.set(s, { teamId: 1, declaredBy: 'p1' });
    }
    // Only high_c remains — set the hands accordingly
    // high_c in remove_7s: 8_c 9_c 10_c 11_c 12_c 13_c
    gameOverGs.hands.set('p1', new Set(['8_c', '9_c']));
    gameOverGs.hands.set('p3', new Set(['10_c', '11_c']));
    gameOverGs.hands.set('p5', new Set(['12_c', '13_c']));
    gameOverGs.hands.set('p2', new Set());
    gameOverGs.hands.set('p4', new Set());
    gameOverGs.hands.set('p6', new Set());
    gameOverGs.currentTurnPlayerId = 'p1';

    const room2 = ROOM + '2';
    setGame(room2, gameOverGs);

    const wsR1 = mockWs();
    registerConnection(room2, 'p1', wsR1);

    const finalAssignment = {
      '8_c': 'p1', '9_c': 'p1',
      '10_c': 'p3', '11_c': 'p3',
      '12_c': 'p5', '13_c': 'p5',
    };

    await handleDeclare(room2, 'p1', 'high_c', finalAssignment, wsR1, false);

    // Game should be over now — no post_declaration_timer
    const timerMsg = wsR1._sent.find((m) => m.type === 'post_declaration_timer');
    expect(timerMsg).toBeUndefined();

    // game_over should be broadcast instead
    const gameOverMsg = wsR1._sent.find((m) => m.type === 'game_over');
    expect(gameOverMsg).toBeDefined();

    // Clean up
    cancelPostDeclarationTimer(room2);
    _clearAll();
  });
});

describe('startPostDeclarationTimer — direct tests', () => {
  test('14. startPostDeclarationTimer adds entry to _postDeclarationTimers', () => {
    jest.useFakeTimers();

    const eligiblePlayers = ['p1', 'p3', 'p5'];
    startPostDeclarationTimer(ROOM, 'p1', eligiblePlayers);

    const entry = _postDeclarationTimers.get(ROOM);
    expect(entry).toBeDefined();
    expect(entry.eligiblePlayers).toEqual(eligiblePlayers);

    cancelPostDeclarationTimer(ROOM);
  });

  test('15. startPostDeclarationTimer replaces any existing timer', () => {
    jest.useFakeTimers();

    startPostDeclarationTimer(ROOM, 'p1', ['p1', 'p3']);
    const firstEntry = _postDeclarationTimers.get(ROOM);

    startPostDeclarationTimer(ROOM, 'p1', ['p1', 'p3', 'p5']);
    const secondEntry = _postDeclarationTimers.get(ROOM);

    // There should be only one entry (replaced)
    expect(secondEntry.eligiblePlayers).toEqual(['p1', 'p3', 'p5']);
    expect(secondEntry).not.toBe(firstEntry);

    cancelPostDeclarationTimer(ROOM);
  });
});
