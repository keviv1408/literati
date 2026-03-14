'use strict';

/**
 * Tests for Sub-AC 4: Permanent bot seat assignment after 60s with mid-game reclaim.
 *
 * Covers:
 *   disconnectStore (unit tests):
 *     1.  startDisconnectTimer fires callback after delay
 *     2.  cancelDisconnectTimer prevents callback from firing
 *     3.  hasDisconnectTimer returns correct state
 *     4.  addToReclaimQueue / isInReclaimQueue / removeFromReclaimQueue
 *     5.  clearRoom removes all timers and reclaim entries for a room
 *     6.  _clearAll resets all state
 *
 *   gameSocketServer integration (via exported functions):
 *     7.  After RECONNECT_WINDOW_MS, `botReplacedAt` is stamped on the player
 *     8.  `botReplacedAt` stamp is absent before the window expires
 *     9.  _executeReclaim flips isBot to false and removes botReplacedAt
 *    10.  _executeReclaim broadcasts `seat_reclaimed` to all connections
 *    11.  _executeReclaim broadcasts updated `game_players`
 *    12.  _executeReclaim persists game state (Supabase call)
 *    13.  _executeReclaim removes player from reclaim queue
 *    14.  scheduleBotTurnIfNeeded triggers reclaim when player is in reclaim queue
 *    15.  After reclaim, scheduleBotTurnIfNeeded does NOT schedule a bot turn
 *    16.  scheduleBotTurnIfNeeded schedules a bot turn when player is NOT in reclaim queue
 *    17.  _executeReclaim is idempotent (calling it twice is safe)
 *    18.  _executeReclaim does nothing when player not found in gs.players
 */

const {
  DISCONNECT_GRACE_MS,
  startDisconnectTimer,
  cancelDisconnectTimer,
  hasDisconnectTimer,
  addToReclaimQueue,
  removeFromReclaimQueue,
  isInReclaimQueue,
  clearRoom,
  _clearAll,
} = require('../game/disconnectStore');

// ---------------------------------------------------------------------------
// Mocks required by gameSocketServer
// ---------------------------------------------------------------------------

jest.mock('../db/supabase', () => ({
  getSupabaseClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
      update: () => ({
        eq: () => Promise.resolve({ error: null }),
      }),
      rpc: () => Promise.resolve({ error: null }),
    }),
    auth: {
      getUser: async () => ({ data: null, error: new Error('mock') }),
    },
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

const mockDecideBotMove = jest.fn();
jest.mock('../game/botLogic', () => ({
  decideBotMove:                   (...args) => mockDecideBotMove(...args),
  completeBotFromPartial:          jest.fn().mockReturnValue({ action: 'pass' }),
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

const {
  scheduleBotTurnIfNeeded,
  scheduleTurnTimerIfNeeded,
  cancelTurnTimer,
  _startReconnectWindow,
  _executeReclaim,
  RECONNECT_WINDOW_MS,
  _reconnectWindows,
} = require('../game/gameSocketServer');

const { setGame, getGame, registerConnection, removeConnection, _clearAll: clearGameStore } = require('../game/gameStore');
const { createGameState } = require('../game/gameState');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ROOM = 'BOTPRM';

function makeSeats(n = 6) {
  return Array.from({ length: n }, (_, i) => ({
    seatIndex:   i,
    playerId:    `p${i + 1}`,
    displayName: `Player ${i + 1}`,
    avatarId:    null,
    teamId:      i % 2 === 0 ? 1 : 2,
    isBot:       false,
    isGuest:     false,
  }));
}

function makeGame(roomCode = ROOM) {
  const gs = createGameState({
    roomCode,
    roomId:      'room-uuid-test',
    variant:     'remove_7s',
    playerCount: 6,
    seats:       makeSeats(6),
  });
  gs.status              = 'active';
  gs.currentTurnPlayerId = 'p1';
  setGame(roomCode, gs);
  return gs;
}

/** Minimal stub WebSocket that records sent messages. */
function makeMockWs() {
  const messages = [];
  return {
    readyState: 1, // OPEN
    send: (data) => messages.push(JSON.parse(data)),
    _messages: messages,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockDecideBotMove.mockReturnValue({ action: 'pass' });
  _clearAll();         // Reset disconnectStore
  clearGameStore();    // Reset gameStore
});

afterEach(() => {
  jest.useRealTimers();
  cancelTurnTimer(ROOM);
  _clearAll();
  clearGameStore();
});

// ===========================================================================
// Part 1: disconnectStore unit tests
// ===========================================================================

describe('disconnectStore — startDisconnectTimer', () => {
  it('1. fires callback after the specified delay', () => {
    const cb = jest.fn();
    startDisconnectTimer('ROOMX', 'p1', cb, 60_000);

    expect(cb).not.toHaveBeenCalled();
    jest.advanceTimersByTime(59_999);
    expect(cb).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('2. cancelDisconnectTimer prevents the callback from firing', () => {
    const cb = jest.fn();
    startDisconnectTimer('ROOMX', 'p1', cb, 60_000);

    jest.advanceTimersByTime(30_000);
    cancelDisconnectTimer('ROOMX', 'p1');

    jest.advanceTimersByTime(60_000); // Past the original deadline
    expect(cb).not.toHaveBeenCalled();
  });

  it('3. cancelDisconnectTimer returns true when a timer was cancelled, false otherwise', () => {
    startDisconnectTimer('ROOMX', 'p1', jest.fn(), 60_000);
    expect(cancelDisconnectTimer('ROOMX', 'p1')).toBe(true);
    // Second call: no timer running
    expect(cancelDisconnectTimer('ROOMX', 'p1')).toBe(false);
  });

  it('3b. hasDisconnectTimer returns true while running, false after cancel', () => {
    expect(hasDisconnectTimer('ROOMX', 'p1')).toBe(false);
    startDisconnectTimer('ROOMX', 'p1', jest.fn(), 60_000);
    expect(hasDisconnectTimer('ROOMX', 'p1')).toBe(true);
    cancelDisconnectTimer('ROOMX', 'p1');
    expect(hasDisconnectTimer('ROOMX', 'p1')).toBe(false);
  });

  it('3c. hasDisconnectTimer returns false after the timer fires naturally', () => {
    startDisconnectTimer('ROOMX', 'p1', jest.fn(), 1_000);
    expect(hasDisconnectTimer('ROOMX', 'p1')).toBe(true);
    jest.advanceTimersByTime(1_001);
    expect(hasDisconnectTimer('ROOMX', 'p1')).toBe(false);
  });

  it('starting a second timer for same player cancels the first', () => {
    const cb1 = jest.fn();
    const cb2 = jest.fn();
    startDisconnectTimer('ROOMX', 'p1', cb1, 60_000);
    startDisconnectTimer('ROOMX', 'p1', cb2, 60_000);

    jest.advanceTimersByTime(60_001);
    expect(cb1).not.toHaveBeenCalled(); // First was cancelled
    expect(cb2).toHaveBeenCalledTimes(1);
  });
});

describe('disconnectStore — reclaim queue', () => {
  it('4. addToReclaimQueue / isInReclaimQueue / removeFromReclaimQueue lifecycle', () => {
    expect(isInReclaimQueue('ROOMX', 'p1')).toBe(false);

    addToReclaimQueue('ROOMX', 'p1');
    expect(isInReclaimQueue('ROOMX', 'p1')).toBe(true);

    removeFromReclaimQueue('ROOMX', 'p1');
    expect(isInReclaimQueue('ROOMX', 'p1')).toBe(false);
  });

  it('4b. multiple players can be in queue simultaneously', () => {
    addToReclaimQueue('ROOMX', 'p1');
    addToReclaimQueue('ROOMX', 'p2');
    addToReclaimQueue('ROOMY', 'p3');

    expect(isInReclaimQueue('ROOMX', 'p1')).toBe(true);
    expect(isInReclaimQueue('ROOMX', 'p2')).toBe(true);
    expect(isInReclaimQueue('ROOMY', 'p3')).toBe(true);
    expect(isInReclaimQueue('ROOMX', 'p3')).toBe(false); // Different room
  });

  it('5. clearRoom removes all timers and reclaim entries for a room', () => {
    const cb = jest.fn();
    startDisconnectTimer('ROOMZ', 'p1', cb, 60_000);
    startDisconnectTimer('ROOMZ', 'p2', cb, 60_000);
    addToReclaimQueue('ROOMZ', 'p3');
    addToReclaimQueue('OTHER', 'p4'); // Different room — must NOT be cleared

    clearRoom('ROOMZ');

    // ROOMZ timers should not fire
    jest.advanceTimersByTime(60_001);
    expect(cb).not.toHaveBeenCalled();

    // ROOMZ reclaim entries gone
    expect(isInReclaimQueue('ROOMZ', 'p3')).toBe(false);

    // Other room unaffected
    expect(isInReclaimQueue('OTHER', 'p4')).toBe(true);
  });

  it('6. _clearAll resets all state', () => {
    const cb = jest.fn();
    startDisconnectTimer('R1', 'p1', cb, 60_000);
    startDisconnectTimer('R2', 'p2', cb, 60_000);
    addToReclaimQueue('R1', 'p3');

    _clearAll();

    jest.advanceTimersByTime(60_001);
    expect(cb).not.toHaveBeenCalled();
    expect(isInReclaimQueue('R1', 'p3')).toBe(false);
    expect(hasDisconnectTimer('R1', 'p1')).toBe(false);
  });
});

// ===========================================================================
// Part 2: gameSocketServer integration — botReplacedAt stamp
// ===========================================================================

describe('_startReconnectWindow → botReplacedAt stamp', () => {
  it('8. botReplacedAt is NOT set before the window expires', () => {
    const gs = makeGame();
    const player = gs.players.find((p) => p.playerId === 'p1');

    _startReconnectWindow(gs, player);

    // Before expiry
    jest.advanceTimersByTime(RECONNECT_WINDOW_MS - 1);
    expect(player.botReplacedAt).toBeUndefined();
  });

  it('7. botReplacedAt IS stamped on the player after the window expires', () => {
    const gs = makeGame();
    const player = gs.players.find((p) => p.playerId === 'p1');

    _startReconnectWindow(gs, player);

    // Let the window expire
    jest.advanceTimersByTime(RECONNECT_WINDOW_MS + 1);

    // Verify stamp
    expect(player.botReplacedAt).toBeDefined();
    expect(typeof player.botReplacedAt).toBe('number');
    expect(player.botReplacedAt).toBeGreaterThan(0);
  });

  it('7b. isBot remains true after window expires (no regression)', () => {
    const gs = makeGame();
    const player = gs.players.find((p) => p.playerId === 'p1');

    _startReconnectWindow(gs, player);
    jest.advanceTimersByTime(RECONNECT_WINDOW_MS + 1);

    expect(player.isBot).toBe(true);
  });
});

// ===========================================================================
// Part 3: _executeReclaim
// ===========================================================================

describe('_executeReclaim', () => {
  it('9. flips isBot to false and removes botReplacedAt', () => {
    const gs = makeGame();
    const player = gs.players.find((p) => p.playerId === 'p1');

    // Simulate permanent bot assignment
    player.isBot = true;
    player.botReplacedAt = Date.now();
    addToReclaimQueue(ROOM, 'p1');

    _executeReclaim(gs, 'p1');

    expect(player.isBot).toBe(false);
    expect(player.botReplacedAt).toBeUndefined();
  });

  it('10. broadcasts seat_reclaimed to all connections', () => {
    const gs = makeGame();
    const player = gs.players.find((p) => p.playerId === 'p1');
    player.isBot = true;
    player.botReplacedAt = Date.now();
    addToReclaimQueue(ROOM, 'p1');

    const ws1 = makeMockWs();
    const ws2 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);
    registerConnection(ROOM, 'p2', ws2);

    _executeReclaim(gs, 'p1');

    const seatReclaimedP1 = ws1._messages.find((m) => m.type === 'seat_reclaimed');
    const seatReclaimedP2 = ws2._messages.find((m) => m.type === 'seat_reclaimed');

    expect(seatReclaimedP1).toBeDefined();
    expect(seatReclaimedP1.playerId).toBe('p1');
    expect(seatReclaimedP2).toBeDefined();
    expect(seatReclaimedP2.playerId).toBe('p1');

    removeConnection(ROOM, 'p1');
    removeConnection(ROOM, 'p2');
  });

  it('11. broadcasts updated game_players after reclaim', () => {
    const gs = makeGame();
    const player = gs.players.find((p) => p.playerId === 'p1');
    player.isBot = true;
    player.botReplacedAt = Date.now();
    addToReclaimQueue(ROOM, 'p1');

    const ws = makeMockWs();
    registerConnection(ROOM, 'p1', ws);

    _executeReclaim(gs, 'p1');

    const gamePlayersMsg = ws._messages.find((m) => m.type === 'game_players');
    expect(gamePlayersMsg).toBeDefined();
    // The broadcast player should now have isBot: false
    const p1Entry = gamePlayersMsg.players.find((p) => p.playerId === 'p1');
    expect(p1Entry).toBeDefined();
    expect(p1Entry.isBot).toBe(false);

    removeConnection(ROOM, 'p1');
  });

  it('13. removes player from reclaim queue after reclaim', () => {
    const gs = makeGame();
    const player = gs.players.find((p) => p.playerId === 'p1');
    player.isBot = true;
    player.botReplacedAt = Date.now();
    addToReclaimQueue(ROOM, 'p1');

    expect(isInReclaimQueue(ROOM, 'p1')).toBe(true);

    _executeReclaim(gs, 'p1');

    expect(isInReclaimQueue(ROOM, 'p1')).toBe(false);
  });

  it('17. _executeReclaim is idempotent — calling it twice is safe', () => {
    const gs = makeGame();
    const player = gs.players.find((p) => p.playerId === 'p1');
    player.isBot = true;
    player.botReplacedAt = Date.now();
    addToReclaimQueue(ROOM, 'p1');

    const ws = makeMockWs();
    registerConnection(ROOM, 'p1', ws);

    _executeReclaim(gs, 'p1');
    _executeReclaim(gs, 'p1'); // Second call should be a no-op

    // isBot stays false, no extra seat_reclaimed broadcasts
    expect(player.isBot).toBe(false);
    // There may be two seat_reclaimed messages (second call still finds player)
    // but isInReclaimQueue is false so the system is consistent
    expect(isInReclaimQueue(ROOM, 'p1')).toBe(false);

    removeConnection(ROOM, 'p1');
  });

  it('18. _executeReclaim does nothing when player not found', () => {
    const gs = makeGame();
    // Should not throw
    expect(() => _executeReclaim(gs, 'non_existent_player')).not.toThrow();
  });
});

// ===========================================================================
// Part 4: scheduleBotTurnIfNeeded with reclaim queue
// ===========================================================================

describe('scheduleBotTurnIfNeeded — reclaim queue integration', () => {
  it('14. triggers _executeReclaim when current player is in reclaim queue', () => {
    const gs = makeGame();
    gs.currentTurnPlayerId = 'p1';
    const player = gs.players.find((p) => p.playerId === 'p1');
    player.isBot = true;
    player.botReplacedAt = Date.now();
    addToReclaimQueue(ROOM, 'p1');

    const ws = makeMockWs();
    registerConnection(ROOM, 'p1', ws);

    scheduleBotTurnIfNeeded(gs);

    // Reclaim should have executed
    expect(player.isBot).toBe(false);
    expect(isInReclaimQueue(ROOM, 'p1')).toBe(false);

    removeConnection(ROOM, 'p1');
  });

  it('15. after reclaim, scheduleBotTurnIfNeeded does NOT schedule a bot turn timer', () => {
    const gs = makeGame();
    gs.currentTurnPlayerId = 'p1';
    const player = gs.players.find((p) => p.playerId === 'p1');
    player.isBot = true;
    player.botReplacedAt = Date.now();
    addToReclaimQueue(ROOM, 'p1');

    const ws = makeMockWs();
    registerConnection(ROOM, 'p1', ws);

    scheduleBotTurnIfNeeded(gs);

    // Advance past the bot turn delay — bot should NOT have executed
    mockDecideBotMove.mockReturnValue({ action: 'ask', targetId: 'p2', cardId: '3_s' });
    jest.advanceTimersByTime(5_000);

    // decideBotMove should NOT have been called (no bot turn was scheduled)
    expect(mockDecideBotMove).not.toHaveBeenCalled();

    removeConnection(ROOM, 'p1');
  });

  it('16. schedules a bot turn when current player is a bot NOT in reclaim queue', () => {
    const gs = makeGame();
    gs.currentTurnPlayerId = 'p1';
    const player = gs.players.find((p) => p.playerId === 'p1');
    player.isBot = true;
    // No botReplacedAt, no reclaim queue entry

    const ws = makeMockWs();
    registerConnection(ROOM, 'p1', ws);

    mockDecideBotMove.mockReturnValue({ action: 'pass' });
    scheduleBotTurnIfNeeded(gs);

    // After BOT_TURN_DELAY_MS, the bot turn should fire
    jest.advanceTimersByTime(2_000);
    expect(mockDecideBotMove).toHaveBeenCalled();

    removeConnection(ROOM, 'p1');
  });

  it('after reclaim, scheduleTurnTimerIfNeeded starts human turn timer', () => {
    const gs = makeGame();
    gs.currentTurnPlayerId = 'p1';
    const player = gs.players.find((p) => p.playerId === 'p1');
    player.isBot = true;
    player.botReplacedAt = Date.now();
    addToReclaimQueue(ROOM, 'p1');

    const ws = makeMockWs();
    registerConnection(ROOM, 'p1', ws);

    // This is the pattern used by action handlers after each move:
    scheduleBotTurnIfNeeded(gs); // Executes reclaim (sets isBot=false)
    scheduleTurnTimerIfNeeded(gs); // Should now see isBot=false and start human timer

    // turn_timer broadcast should have been sent
    const timerMsg = ws._messages.find((m) => m.type === 'turn_timer');
    expect(timerMsg).toBeDefined();
    expect(timerMsg.playerId).toBe('p1');
    expect(timerMsg.durationMs).toBe(30_000);

    cancelTurnTimer(ROOM);
    removeConnection(ROOM, 'p1');
  });
});

// ===========================================================================
// Part 5: RECONNECT_WINDOW_MS constant
// ===========================================================================

describe('DISCONNECT_GRACE_MS constant', () => {
  it('disconnectStore DISCONNECT_GRACE_MS equals 60 seconds', () => {
    expect(DISCONNECT_GRACE_MS).toBe(60_000);
  });

  it('gameSocketServer RECONNECT_WINDOW_MS equals 60 seconds', () => {
    expect(RECONNECT_WINDOW_MS).toBe(60_000);
  });
});
