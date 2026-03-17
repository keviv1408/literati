'use strict';

/**
 * Tests for 30-second rematch gathering countdown.
 *
 * After a rematch is initiated (majority vote OR host-initiated), the server
 * starts a 30-second gathering countdown that:
 * 1. Tracks which players from the finished game have rejoined the room lobby.
 * 2. Broadcasts live `rematch_gathering` events to all connected game-socket
 * clients (both immediately and on every TIMER_TICK_INTERVAL_MS tick).
 * 3. Fires a final broadcast with `expired: true` when the 30s window closes.
 * 4. Fires an early broadcast with `allRejoined: true` if every expected
 * player rejoins before the 30s window closes.
 * 5. Ignores players who were not in the previous game (no-op).
 * 6. Excludes bot players from the expected-reconnect set (bots are always
 * "present" — they do not navigate away from the game page).
 *
 * Coverage:
 * _startRematchGatheringCountdown:
 * 1. Creates gathering state with correct expectedPlayerIds (humans only)
 * 2. Broadcasts initial `rematch_gathering` event immediately
 * 3. Initial broadcast has correct shape (roomCode, expiresAt, durationMs,
 * reconnectedCount:0, totalCount, reconnectedPlayerIds:[], pendingPlayerIds:[...])
 * 4. Broadcasts tick event every TIMER_TICK_INTERVAL_MS
 * 5. Fires expiry with `expired:true` after REMATCH_GATHER_TIMEOUT_MS
 * 6. Expiry broadcast includes correct reconnected/pending counts
 * 7. Does nothing (no state, no broadcast) when player list is all bots
 * 8. Re-initialising cancels any existing gathering timer before starting new one
 * notifyRematchPlayerJoined:
 * 9. Marks player as reconnected, re-broadcasts updated state
 * 10. Updated broadcast has incremented reconnectedCount and removed player from pending
 * 11. Unknown player (not in expectedPlayerIds) is silently ignored
 * 12. Bot player is silently ignored (not in expectedPlayerIds)
 * 13. No-op when no gathering is active for the room
 * 14. Early completion: when all players rejoin, cancels timer + broadcasts allRejoined:true
 * 15. After early completion, further notifyRematchPlayerJoined calls are no-ops
 * _cancelRematchGathering:
 * 16. Removes state so _rematchGatheringState has no entry
 * 17. Cancels the timer so expiry callback never fires
 * 18. Safe to call when no gathering is active (no-op)
 * _clearAllRematchGatherings:
 * 19. Clears multiple active gatherings at once
 * 20. Prevents any expiry callbacks from firing after clearing
 */

// ---------------------------------------------------------------------------
// Mocks (must come before any require of game modules)
// ---------------------------------------------------------------------------

jest.mock('../db/supabase', () => ({
  getSupabaseClient: () => ({
    from: () => ({
      select:    () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      update:    () => ({ eq: () => Promise.resolve({ error: null }) }),
      upsert:    () => Promise.resolve({ error: null }),
      rpc:       () => Promise.resolve({ error: null }),
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

jest.mock('../game/pendingRematchStore', () => ({
  setPendingRematch:    jest.fn(),
  getPendingRematch:    jest.fn().mockReturnValue(null),
  clearPendingRematch:  jest.fn(),
  getRematchGameConfig: jest.fn().mockReturnValue(null),
}));

// ---------------------------------------------------------------------------
// Module imports (after mocks)
// ---------------------------------------------------------------------------

jest.useFakeTimers();

const { setGame, registerConnection, _clearAll: clearGameStore } = require('../game/gameStore');
const {
  _startRematchGatheringCountdown,
  notifyRematchPlayerJoined,
  _cancelRematchGathering,
  _clearAllRematchGatherings,
  _rematchGatheringState,
  REMATCH_GATHER_TIMEOUT_MS,
  TIMER_TICK_INTERVAL_MS,
} = require('../game/gameSocketServer');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock WebSocket that captures outbound messages. */
function makeMockWs() {
  const msgs = [];
  return {
    readyState: 1 /* OPEN */,
    send: (raw) => msgs.push(JSON.parse(raw)),
    _msgs: msgs,
  };
}

/** Build a human player object (as stored in GameState.players). */
function makeHuman(id, teamId = 1, seatIndex = 0) {
  return { playerId: id, displayName: id, teamId, seatIndex, isBot: false, isGuest: false, avatarId: null };
}

/** Build a bot player object. */
function makeBot(id, teamId = 2, seatIndex = 1) {
  return { playerId: id, displayName: id, teamId, seatIndex, isBot: true, isGuest: false, avatarId: null };
}

/**
 * Register a mock WS for the given player in the given room so that
 * broadcastToGame reaches them. Returns the mock WS.
 */
function addConnection(roomCode, playerId) {
  const ws = makeMockWs();
  registerConnection(roomCode, playerId, ws);
  return ws;
}

/** Extract all messages of a given type from a mock WS. */
function getMessages(ws, type) {
  return ws._msgs.filter((m) => m.type === type);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _clearAllRematchGatherings();
  clearGameStore();
  jest.clearAllMocks();
});

afterEach(() => {
  _clearAllRematchGatherings();
  clearGameStore();
  jest.clearAllTimers();
});

// ---------------------------------------------------------------------------
// _startRematchGatheringCountdown
// ---------------------------------------------------------------------------

describe('_startRematchGatheringCountdown', () => {
  test('1. creates gathering state with expected human player ids', () => {
    const players = [makeHuman('h1'), makeHuman('h2'), makeBot('b1')];
    _startRematchGatheringCountdown('GATHER1', players);

    expect(_rematchGatheringState.has('GATHER1')).toBe(true);
    const state = _rematchGatheringState.get('GATHER1');
    expect(state.expectedPlayerIds).toEqual(expect.arrayContaining(['h1', 'h2']));
    expect(state.expectedPlayerIds).not.toContain('b1'); // bot excluded
    expect(state.expectedPlayerIds).toHaveLength(2);
  });

  test('2. broadcasts initial rematch_gathering immediately', () => {
    const ws = addConnection('GATHER2', 'h1');
    const players = [makeHuman('h1'), makeHuman('h2')];
    _startRematchGatheringCountdown('GATHER2', players);

    const msgs = getMessages(ws, 'rematch_gathering');
    expect(msgs).toHaveLength(1);
  });

  test('3. initial broadcast has correct shape', () => {
    const ws = addConnection('GATHER3', 'h1');
    const players = [makeHuman('h1'), makeHuman('h2')];
    _startRematchGatheringCountdown('GATHER3', players);

    const msg = getMessages(ws, 'rematch_gathering')[0];
    expect(msg).toMatchObject({
      type:             'rematch_gathering',
      roomCode:         'GATHER3',
      durationMs:       REMATCH_GATHER_TIMEOUT_MS,
      reconnectedCount: 0,
      totalCount:       2,
    });
    expect(msg.reconnectedPlayerIds).toEqual([]);
    expect(msg.pendingPlayerIds).toEqual(expect.arrayContaining(['h1', 'h2']));
    expect(typeof msg.expiresAt).toBe('number');
    expect(msg.expiresAt).toBeGreaterThan(Date.now());
  });

  test('4. broadcasts tick event every TIMER_TICK_INTERVAL_MS', () => {
    const ws = addConnection('GATHER4', 'h1');
    const players = [makeHuman('h1')];
    _startRematchGatheringCountdown('GATHER4', players);

    // Initial broadcast + 2 ticks
    jest.advanceTimersByTime(TIMER_TICK_INTERVAL_MS * 2);
    const msgs = getMessages(ws, 'rematch_gathering');
    expect(msgs.length).toBeGreaterThanOrEqual(3); // initial + 2 ticks
  });

  test('5. fires expiry with expired:true after REMATCH_GATHER_TIMEOUT_MS', () => {
    const ws = addConnection('GATHER5', 'h1');
    const players = [makeHuman('h1'), makeHuman('h2')];
    _startRematchGatheringCountdown('GATHER5', players);

    jest.advanceTimersByTime(REMATCH_GATHER_TIMEOUT_MS);

    const msgs = getMessages(ws, 'rematch_gathering');
    const expiryMsg = msgs.find((m) => m.expired === true);
    expect(expiryMsg).toBeDefined();
  });

  test('6. expiry broadcast includes correct reconnected/pending counts', () => {
    const ws = addConnection('GATHER6', 'h1');
    const players = [makeHuman('h1'), makeHuman('h2')];
    _startRematchGatheringCountdown('GATHER6', players);

    // h1 rejoins before expiry
    notifyRematchPlayerJoined('GATHER6', 'h1');

    jest.advanceTimersByTime(REMATCH_GATHER_TIMEOUT_MS);

    const msgs = getMessages(ws, 'rematch_gathering');
    const expiryMsg = msgs.find((m) => m.expired === true);
    expect(expiryMsg).toBeDefined();
    expect(expiryMsg.reconnectedCount).toBe(1);
    expect(expiryMsg.pendingPlayerIds).toContain('h2');
    expect(expiryMsg.reconnectedPlayerIds).toContain('h1');
  });

  test('7. does nothing when player list has no humans (all bots)', () => {
    const ws = addConnection('GATHER7', 'b1');
    const players = [makeBot('b1'), makeBot('b2')];
    _startRematchGatheringCountdown('GATHER7', players);

    expect(_rematchGatheringState.has('GATHER7')).toBe(false);
    expect(getMessages(ws, 'rematch_gathering')).toHaveLength(0);
  });

  test('8. re-initialising cancels any existing gathering before starting new one', () => {
    const firstTimeout = jest.fn();
    const ws = addConnection('GATHER8', 'h1');
    const players = [makeHuman('h1')];

    _startRematchGatheringCountdown('GATHER8', players);
    // Spy on the first timer expiry by capturing state reference
    const firstState = _rematchGatheringState.get('GATHER8');

    // Re-initialise — should cancel the first timer
    _startRematchGatheringCountdown('GATHER8', players);
    const secondState = _rematchGatheringState.get('GATHER8');

    expect(firstState).not.toBe(secondState); // Different state objects
    expect(_rematchGatheringState.has('GATHER8')).toBe(true);
    // Only one active gathering — advance time past original duration
    jest.advanceTimersByTime(REMATCH_GATHER_TIMEOUT_MS + 1000);
    // Should still only have expiry from the SECOND gathering
    const expiryMsgs = getMessages(ws, 'rematch_gathering').filter((m) => m.expired === true);
    expect(expiryMsgs).toHaveLength(1); // Only one expiry
  });
});

// ---------------------------------------------------------------------------
// notifyRematchPlayerJoined
// ---------------------------------------------------------------------------

describe('notifyRematchPlayerJoined', () => {
  test('9. marks player as reconnected, re-broadcasts updated state', () => {
    const ws = addConnection('REJOIN1', 'h1');
    const players = [makeHuman('h1'), makeHuman('h2')];
    _startRematchGatheringCountdown('REJOIN1', players);
    const initialCount = ws._msgs.length;

    notifyRematchPlayerJoined('REJOIN1', 'h1');

    expect(ws._msgs.length).toBeGreaterThan(initialCount);
    const lastMsg = ws._msgs[ws._msgs.length - 1];
    expect(lastMsg.type).toBe('rematch_gathering');
  });

  test('10. updated broadcast has incremented reconnectedCount', () => {
    const ws = addConnection('REJOIN2', 'h1');
    const players = [makeHuman('h1'), makeHuman('h2')];
    _startRematchGatheringCountdown('REJOIN2', players);

    notifyRematchPlayerJoined('REJOIN2', 'h1');

    const gatheringMsgs = getMessages(ws, 'rematch_gathering');
    const updateMsg = gatheringMsgs[gatheringMsgs.length - 1];
    expect(updateMsg.reconnectedCount).toBe(1);
    expect(updateMsg.reconnectedPlayerIds).toContain('h1');
    expect(updateMsg.pendingPlayerIds).toContain('h2');
    expect(updateMsg.pendingPlayerIds).not.toContain('h1');
  });

  test('11. unknown player (not in expectedPlayerIds) is silently ignored', () => {
    const ws = addConnection('REJOIN3', 'h1');
    const players = [makeHuman('h1'), makeHuman('h2')];
    _startRematchGatheringCountdown('REJOIN3', players);
    const initialCount = ws._msgs.length;

    notifyRematchPlayerJoined('REJOIN3', 'stranger');

    // No additional broadcast — count should be unchanged
    expect(ws._msgs.length).toBe(initialCount);
    const state = _rematchGatheringState.get('REJOIN3');
    expect(state.reconnectedIds.size).toBe(0);
  });

  test('12. bot player is silently ignored (not in expectedPlayerIds)', () => {
    const ws = addConnection('REJOIN4', 'h1');
    const players = [makeHuman('h1'), makeBot('b1')];
    _startRematchGatheringCountdown('REJOIN4', players);
    const initialCount = ws._msgs.length;

    notifyRematchPlayerJoined('REJOIN4', 'b1'); // bot notifies

    expect(ws._msgs.length).toBe(initialCount);
    const state = _rematchGatheringState.get('REJOIN4');
    expect(state.reconnectedIds.size).toBe(0);
  });

  test('13. no-op when no gathering is active for the room', () => {
    const ws = addConnection('REJOIN5', 'h1');
    // No gathering started

    notifyRematchPlayerJoined('REJOIN5', 'h1');

    expect(getMessages(ws, 'rematch_gathering')).toHaveLength(0);
  });

  test('14. early completion: all players rejoin → cancels timer + broadcasts allRejoined:true', () => {
    const ws = addConnection('REJOIN6', 'h1');
    const players = [makeHuman('h1'), makeHuman('h2')];
    _startRematchGatheringCountdown('REJOIN6', players);

    notifyRematchPlayerJoined('REJOIN6', 'h1');
    notifyRematchPlayerJoined('REJOIN6', 'h2'); // last one

    // Gathering state should be cleared
    expect(_rematchGatheringState.has('REJOIN6')).toBe(false);

    // Final broadcast should have allRejoined:true
    const msgs = getMessages(ws, 'rematch_gathering');
    const finalMsg = msgs[msgs.length - 1];
    expect(finalMsg.allRejoined).toBe(true);
    expect(finalMsg.expired).toBe(false);
    expect(finalMsg.reconnectedCount).toBe(2);
    expect(finalMsg.pendingPlayerIds).toHaveLength(0);
  });

  test('15. after early completion, further joins are no-ops', () => {
    const ws = addConnection('REJOIN7', 'h1');
    const players = [makeHuman('h1')];
    _startRematchGatheringCountdown('REJOIN7', players);

    notifyRematchPlayerJoined('REJOIN7', 'h1'); // completes
    const countAfterComplete = ws._msgs.length;

    // Calling again should not produce additional broadcasts
    notifyRematchPlayerJoined('REJOIN7', 'h1');
    expect(ws._msgs.length).toBe(countAfterComplete);
  });
});

// ---------------------------------------------------------------------------
// _cancelRematchGathering
// ---------------------------------------------------------------------------

describe('_cancelRematchGathering', () => {
  test('16. removes state so _rematchGatheringState has no entry', () => {
    const players = [makeHuman('h1')];
    _startRematchGatheringCountdown('CANCEL1', players);
    expect(_rematchGatheringState.has('CANCEL1')).toBe(true);

    _cancelRematchGathering('CANCEL1');
    expect(_rematchGatheringState.has('CANCEL1')).toBe(false);
  });

  test('17. cancels the timer so expiry callback never fires', () => {
    const ws = addConnection('CANCEL2', 'h1');
    const players = [makeHuman('h1')];
    _startRematchGatheringCountdown('CANCEL2', players);

    _cancelRematchGathering('CANCEL2');

    jest.advanceTimersByTime(REMATCH_GATHER_TIMEOUT_MS + 1000);

    const expiryMsgs = getMessages(ws, 'rematch_gathering').filter((m) => m.expired === true);
    expect(expiryMsgs).toHaveLength(0);
  });

  test('18. safe to call when no gathering is active (no-op)', () => {
    expect(() => _cancelRematchGathering('CANCEL3')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// _clearAllRematchGatherings
// ---------------------------------------------------------------------------

describe('_clearAllRematchGatherings', () => {
  test('19. clears multiple active gatherings at once', () => {
    const players1 = [makeHuman('h1')];
    const players2 = [makeHuman('h2')];
    _startRematchGatheringCountdown('CLEAR1', players1);
    _startRematchGatheringCountdown('CLEAR2', players2);

    expect(_rematchGatheringState.size).toBe(2);

    _clearAllRematchGatherings();

    expect(_rematchGatheringState.size).toBe(0);
  });

  test('20. prevents any expiry callbacks from firing after clearing', () => {
    const ws1 = addConnection('CLEAR3', 'h1');
    const ws2 = addConnection('CLEAR4', 'h2');
    _startRematchGatheringCountdown('CLEAR3', [makeHuman('h1')]);
    _startRematchGatheringCountdown('CLEAR4', [makeHuman('h2')]);

    _clearAllRematchGatherings();

    jest.advanceTimersByTime(REMATCH_GATHER_TIMEOUT_MS + 1000);

    const expiry1 = getMessages(ws1, 'rematch_gathering').filter((m) => m.expired);
    const expiry2 = getMessages(ws2, 'rematch_gathering').filter((m) => m.expired);
    expect(expiry1).toHaveLength(0);
    expect(expiry2).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// REMATCH_GATHER_TIMEOUT_MS constant
// ---------------------------------------------------------------------------

describe('REMATCH_GATHER_TIMEOUT_MS', () => {
  test('21. equals 30 000 ms (30 seconds)', () => {
    expect(REMATCH_GATHER_TIMEOUT_MS).toBe(30_000);
  });
});
