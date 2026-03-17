'use strict';

/**
 * Unit tests for the concurrent timer infrastructure.
 *
 * Verifies that on player disconnect the server:
 * 1. Starts a 60-second turn timer (via scheduleTurnTimerIfNeeded) and a
 * 60-second reconnect window simultaneously when the disconnected player
 * holds the active turn.
 * 2. Starts ONLY the reconnect window (no turn timer) when the disconnected
 * player does NOT hold the active turn.
 * 3. Emits `reconnect_timer` start event immediately on disconnect.
 * 4. Emits `reconnect_tick` events every TIMER_TICK_INTERVAL_MS.
 * 5. Emits `reconnect_expired` when the 60-second window closes.
 * 6. Emits `turn_timer` start event concurrently with the reconnect window.
 * 7. Emits `turn_timer_tick` events every TIMER_TICK_INTERVAL_MS.
 * 8. `bot_takeover` fires when the 60-second turn timer expires.
 * 9. cancelReconnectWindow cancels both the expiry and the tick interval.
 * 10. startReconnectWindow + cancelReconnectWindow are idempotent.
 * 11. handlePlayerDisconnect is a no-op for spectators.
 * 12. handlePlayerDisconnect is a no-op when no game is active.
 * 13. `reconnect_timer` and `turn_timer` expiresAt values are correct.
 * 14. Concurrent timers tracked in _reconnectTimers and _turnTimers maps.
 * 15. `player_disconnected` broadcast excludes the disconnected player.
 * 16. `reconnect_tick` includes remaining time that decreases over time.
 * 17. `turn_timer_tick` includes remaining time during the 30s window.
 */

const {
  scheduleTurnTimerIfNeeded,
  cancelTurnTimer,
  startReconnectWindow,
  cancelReconnectWindow,
  handlePlayerDisconnect,
  RECONNECT_WINDOW_MS,
  TIMER_TICK_INTERVAL_MS,
  _reconnectTimers,
  _turnTimers,                // Exposed for test inspection
} = require('../game/gameSocketServer');

const {
  setGame,
  getGame,
  registerConnection,
  removeConnection,
  getRoomConnections,
} = require('../game/gameStore');
const { createGameState } = require('../game/gameState');

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../db/supabase', () => ({
  getSupabaseClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
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

const mockDecideBotMove          = jest.fn();
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

const ROOM = 'CTINFRA';

function makeSeats(humanIds = ['p1', 'p2', 'p3'], botIds = []) {
  const seats = [];
  let idx = 0;
  for (const id of humanIds) {
    seats.push({
      seatIndex:   idx,
      playerId:    id,
      displayName: `Player ${id}`,
      avatarId:    null,
      teamId:      idx % 2 === 0 ? 1 : 2,
      isBot:       false,
      isGuest:     false,
    });
    idx++;
  }
  for (const id of botIds) {
    seats.push({
      seatIndex:   idx,
      playerId:    id,
      displayName: `Bot ${id}`,
      avatarId:    null,
      teamId:      idx % 2 === 0 ? 1 : 2,
      isBot:       true,
      isGuest:     false,
    });
    idx++;
  }
  return seats;
}

function makeGame({ status = 'active', currentPlayer = 'p1' } = {}) {
  const seats = makeSeats(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  const gs = createGameState({
    roomCode:    ROOM,
    roomId:      'room-uuid-ct',
    variant:     'remove_7s',
    playerCount: 6,
    seats,
  });
  gs.status              = status;
  gs.currentTurnPlayerId = currentPlayer;
  return gs;
}

function makeMockWs() {
  const messages = [];
  return {
    readyState: 1, // OPEN
    send: (data) => messages.push(JSON.parse(data)),
    _messages: messages,
  };
}

function setupRoom(playerIds = ['p1', 'p2', 'p3'], currentPlayer = 'p1') {
  const gs  = makeGame({ currentPlayer });
  setGame(ROOM, gs);
  const sockets = {};
  for (const pid of playerIds) {
    const ws = makeMockWs();
    registerConnection(ROOM, pid, ws);
    sockets[pid] = ws;
  }
  return { gs, sockets };
}

function cleanupRoom(playerIds = ['p1', 'p2', 'p3']) {
  for (const pid of playerIds) removeConnection(ROOM, pid);
  cancelTurnTimer(ROOM);
  cancelReconnectWindow(ROOM, 'p1');
  cancelReconnectWindow(ROOM, 'p2');
  cancelReconnectWindow(ROOM, 'p3');
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockDecideBotMove.mockReturnValue({ action: 'pass' });
  mockCompleteBotFromPartial.mockReturnValue({ action: 'pass' });
  try { setGame(ROOM, null); } catch { /* ok */ }
});

afterEach(() => {
  cleanupRoom();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('Timer constants', () => {
  it('RECONNECT_WINDOW_MS is 60_000', () => {
    expect(RECONNECT_WINDOW_MS).toBe(60_000);
  });

  it('TIMER_TICK_INTERVAL_MS is 5_000', () => {
    expect(TIMER_TICK_INTERVAL_MS).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// startReconnectWindow — basic API
// ---------------------------------------------------------------------------

describe('startReconnectWindow', () => {
  it('3. broadcasts reconnect_timer start event immediately', () => {
    const { sockets } = setupRoom();
    startReconnectWindow(ROOM, 'p1');

    const msg = sockets.p1._messages.find((m) => m.type === 'reconnect_timer');
    expect(msg).toBeDefined();
    expect(msg.playerId).toBe('p1');
    expect(msg.durationMs).toBe(RECONNECT_WINDOW_MS);
    expect(typeof msg.expiresAt).toBe('number');
    cleanupRoom();
  });

  it('13. reconnect_timer expiresAt is approximately Date.now() + 60000', () => {
    const { sockets } = setupRoom();
    const before = Date.now();
    startReconnectWindow(ROOM, 'p1');
    const after = Date.now();

    const msg = sockets.p1._messages.find((m) => m.type === 'reconnect_timer');
    expect(msg.expiresAt).toBeGreaterThanOrEqual(before + RECONNECT_WINDOW_MS);
    expect(msg.expiresAt).toBeLessThanOrEqual(after + RECONNECT_WINDOW_MS + 200);
    cleanupRoom();
  });

  it('broadcasts reconnect_timer to all connected clients', () => {
    const { sockets } = setupRoom(['p1', 'p2', 'p3']);
    startReconnectWindow(ROOM, 'p1');

    for (const pid of ['p1', 'p2', 'p3']) {
      expect(sockets[pid]._messages.some((m) => m.type === 'reconnect_timer')).toBe(true);
    }
    cleanupRoom();
  });

  it('4. emits reconnect_tick events every TIMER_TICK_INTERVAL_MS', () => {
    const { sockets } = setupRoom();
    startReconnectWindow(ROOM, 'p1');

    // No tick yet (interval not fired)
    expect(sockets.p1._messages.filter((m) => m.type === 'reconnect_tick')).toHaveLength(0);

    // Advance one tick interval
    jest.advanceTimersByTime(TIMER_TICK_INTERVAL_MS);
    expect(sockets.p1._messages.filter((m) => m.type === 'reconnect_tick')).toHaveLength(1);

    // Advance another tick
    jest.advanceTimersByTime(TIMER_TICK_INTERVAL_MS);
    expect(sockets.p1._messages.filter((m) => m.type === 'reconnect_tick')).toHaveLength(2);
    cleanupRoom();
  });

  it('16. reconnect_tick includes remainingMs and expiresAt', () => {
    const { sockets } = setupRoom();
    const startTime = Date.now();
    startReconnectWindow(ROOM, 'p1');

    jest.advanceTimersByTime(TIMER_TICK_INTERVAL_MS);

    const tickMsg = sockets.p1._messages.find((m) => m.type === 'reconnect_tick');
    expect(tickMsg).toBeDefined();
    expect(tickMsg.playerId).toBe('p1');
    expect(typeof tickMsg.remainingMs).toBe('number');
    expect(tickMsg.remainingMs).toBeGreaterThan(0);
    expect(tickMsg.remainingMs).toBeLessThanOrEqual(RECONNECT_WINDOW_MS);
    expect(typeof tickMsg.expiresAt).toBe('number');
    cleanupRoom();
  });

  it('5. emits reconnect_expired when 60-second window closes', () => {
    const { sockets } = setupRoom();
    startReconnectWindow(ROOM, 'p1');

    // No expiry yet
    expect(sockets.p1._messages.some((m) => m.type === 'reconnect_expired')).toBe(false);

    // Advance to expiry
    jest.advanceTimersByTime(RECONNECT_WINDOW_MS);

    const expiredMsg = sockets.p1._messages.find((m) => m.type === 'reconnect_expired');
    expect(expiredMsg).toBeDefined();
    expect(expiredMsg.playerId).toBe('p1');
    cleanupRoom();
  });

  it('14. tracks active window in _reconnectTimers map', () => {
    const { sockets } = setupRoom();
    const key = `${ROOM}:p1`;

    expect(_reconnectTimers.has(key)).toBe(false);
    startReconnectWindow(ROOM, 'p1');
    expect(_reconnectTimers.has(key)).toBe(true);

    const entry = _reconnectTimers.get(key);
    expect(entry).toHaveProperty('timerId');
    expect(entry).toHaveProperty('tickId');
    expect(entry).toHaveProperty('expiresAt');
    cleanupRoom();
  });

  it('removes entry from _reconnectTimers on expiry', () => {
    setupRoom();
    const key = `${ROOM}:p1`;
    startReconnectWindow(ROOM, 'p1');

    jest.advanceTimersByTime(RECONNECT_WINDOW_MS);

    expect(_reconnectTimers.has(key)).toBe(false);
    cleanupRoom();
  });

  it('stops emitting ticks after expiry', () => {
    const { sockets } = setupRoom();
    startReconnectWindow(ROOM, 'p1');

    jest.advanceTimersByTime(RECONNECT_WINDOW_MS + TIMER_TICK_INTERVAL_MS * 3);

    // After expiry the tick count should be bounded (≤ RECONNECT_WINDOW_MS/TICK = 12)
    const ticks = sockets.p1._messages.filter((m) => m.type === 'reconnect_tick');
    expect(ticks.length).toBeLessThanOrEqual(RECONNECT_WINDOW_MS / TIMER_TICK_INTERVAL_MS);
    cleanupRoom();
  });

  it('10. is idempotent — double call replaces previous window', () => {
    const { sockets } = setupRoom();
    startReconnectWindow(ROOM, 'p1');
    startReconnectWindow(ROOM, 'p1');

    // Should still have exactly one active entry
    expect(_reconnectTimers.has(`${ROOM}:p1`)).toBe(true);

    // Only the second window should fire (first was cancelled)
    jest.advanceTimersByTime(RECONNECT_WINDOW_MS);

    const expiredMsgs = sockets.p1._messages.filter((m) => m.type === 'reconnect_expired');
    expect(expiredMsgs).toHaveLength(1);
    cleanupRoom();
  });
});

// ---------------------------------------------------------------------------
// cancelReconnectWindow
// ---------------------------------------------------------------------------

describe('cancelReconnectWindow', () => {
  it('9. cancels the expiry timeout — no reconnect_expired fires', () => {
    const { sockets } = setupRoom();
    startReconnectWindow(ROOM, 'p1');
    cancelReconnectWindow(ROOM, 'p1');

    jest.advanceTimersByTime(RECONNECT_WINDOW_MS + 5_000);

    expect(sockets.p1._messages.some((m) => m.type === 'reconnect_expired')).toBe(false);
    cleanupRoom();
  });

  it('9. cancels the tick interval — no more reconnect_tick after cancel', () => {
    const { sockets } = setupRoom();
    startReconnectWindow(ROOM, 'p1');

    jest.advanceTimersByTime(TIMER_TICK_INTERVAL_MS);
    const ticksBefore = sockets.p1._messages.filter((m) => m.type === 'reconnect_tick').length;

    cancelReconnectWindow(ROOM, 'p1');
    jest.advanceTimersByTime(TIMER_TICK_INTERVAL_MS * 5);

    const ticksAfter = sockets.p1._messages.filter((m) => m.type === 'reconnect_tick').length;
    expect(ticksAfter).toBe(ticksBefore); // no new ticks after cancel
    cleanupRoom();
  });

  it('removes entry from _reconnectTimers on cancel', () => {
    setupRoom();
    const key = `${ROOM}:p1`;
    startReconnectWindow(ROOM, 'p1');
    expect(_reconnectTimers.has(key)).toBe(true);

    cancelReconnectWindow(ROOM, 'p1');
    expect(_reconnectTimers.has(key)).toBe(false);
    cleanupRoom();
  });

  it('10. is idempotent — safe to call when no window exists', () => {
    expect(() => cancelReconnectWindow(ROOM, 'p1')).not.toThrow();
    expect(() => cancelReconnectWindow('NOTEXIST', 'nobody')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// handlePlayerDisconnect — public orchestration API
// ---------------------------------------------------------------------------

describe('handlePlayerDisconnect', () => {
  it('11. is a no-op for spectators', () => {
    const { sockets } = setupRoom();
    handlePlayerDisconnect(ROOM, 'spectator_abc', true /* isSpectator */);

    // No reconnect_timer should be broadcast
    for (const ws of Object.values(sockets)) {
      expect(ws._messages.some((m) => m.type === 'reconnect_timer')).toBe(false);
    }
    cleanupRoom();
  });

  it('12. is a no-op when no game exists', () => {
    const ws = makeMockWs();
    registerConnection(ROOM, 'p1', ws);
    // No game set

    handlePlayerDisconnect(ROOM, 'p1', false);

    expect(ws._messages.some((m) => m.type === 'reconnect_timer')).toBe(false);
    removeConnection(ROOM, 'p1');
  });

  it('12. is a no-op when game is completed', () => {
    const { sockets } = setupRoom();
    getGame(ROOM).status = 'completed';

    handlePlayerDisconnect(ROOM, 'p1', false);

    expect(sockets.p2._messages.some((m) => m.type === 'reconnect_timer')).toBe(false);
    cleanupRoom();
  });

  it('15. broadcasts player_disconnected to all OTHER clients (not disconnecting player)', () => {
    const { sockets } = setupRoom(['p1', 'p2', 'p3'], 'p2');
    // p1 is disconnecting
    handlePlayerDisconnect(ROOM, 'p1', false);

    // p2 and p3 should receive player_disconnected
    expect(sockets.p2._messages.some((m) => m.type === 'player_disconnected' && m.playerId === 'p1')).toBe(true);
    expect(sockets.p3._messages.some((m) => m.type === 'player_disconnected' && m.playerId === 'p1')).toBe(true);
    // p1's own connection should NOT receive the event (excluded)
    expect(sockets.p1._messages.some((m) => m.type === 'player_disconnected')).toBe(false);
    cleanupRoom();
  });

  it('1. starts 60-second reconnect window when active player disconnects', () => {
    const { sockets } = setupRoom(['p1', 'p2', 'p3'], 'p1');
    handlePlayerDisconnect(ROOM, 'p1', false);

    expect(sockets.p1._messages.some((m) => m.type === 'reconnect_timer')).toBe(true);
    expect(_reconnectTimers.has(`${ROOM}:p1`)).toBe(true);
    cleanupRoom();
  });

  it('1. starts 60-second reconnect window when NON-active player disconnects', () => {
    const { sockets } = setupRoom(['p1', 'p2', 'p3'], 'p2'); // p2 has the turn
    handlePlayerDisconnect(ROOM, 'p1', false); // p1 disconnects (not their turn)

    const rtMsg = sockets.p2._messages.find((m) => m.type === 'reconnect_timer');
    expect(rtMsg).toBeDefined();
    expect(rtMsg.playerId).toBe('p1');
    expect(_reconnectTimers.has(`${ROOM}:p1`)).toBe(true);
    cleanupRoom();
  });

  it('6. starts 60-second turn timer when active player disconnects', () => {
    const { sockets } = setupRoom(['p1', 'p2', 'p3'], 'p1'); // p1 has the turn
    handlePlayerDisconnect(ROOM, 'p1', false);

    // turn_timer should be broadcast
    const timerMsg = sockets.p2._messages.find((m) => m.type === 'turn_timer');
    expect(timerMsg).toBeDefined();
    expect(timerMsg.playerId).toBe('p1');
    expect(timerMsg.durationMs).toBe(60_000);
    cleanupRoom();
  });

  it('2. does NOT start turn timer when NON-active player disconnects', () => {
    const { sockets } = setupRoom(['p1', 'p2', 'p3'], 'p2'); // p2 has the turn
    handlePlayerDisconnect(ROOM, 'p1', false); // p1 disconnects (not active)

    // No turn_timer for p1's disconnect (p2 still has the turn and timer isn't started)
    // The reconnect_timer IS emitted for p1, but NOT the turn_timer for p1
    const timerMsgForP1 = sockets.p3._messages.find(
      (m) => m.type === 'turn_timer' && m.playerId === 'p1'
    );
    expect(timerMsgForP1).toBeUndefined();
    cleanupRoom();
  });

  it('1. both timers start simultaneously (both active in their respective maps)', () => {
    const { sockets } = setupRoom(['p1', 'p2', 'p3'], 'p1');
    handlePlayerDisconnect(ROOM, 'p1', false);

    // Both timer entries should exist
    expect(_reconnectTimers.has(`${ROOM}:p1`)).toBe(true); // 60s reconnect
    expect(_turnTimers.has(ROOM)).toBe(true);               // 60s turn timer
    cleanupRoom();
  });

  it('8. bot_takeover fires when the 60-second turn timer expires', () => {
    const { sockets } = setupRoom(['p1', 'p2', 'p3'], 'p1');
    mockCompleteBotFromPartial.mockReturnValue({ action: 'pass' });

    handlePlayerDisconnect(ROOM, 'p1', false);

    // Advance 60 seconds — turn timer fires
    jest.advanceTimersByTime(60_000);

    const takeover = sockets.p2._messages.find((m) => m.type === 'bot_takeover');
    expect(takeover).toBeDefined();
    expect(takeover.playerId).toBe('p1');
    cleanupRoom();
  });

  it('5. reconnect_expired fires after 60 seconds', () => {
    const { sockets } = setupRoom(['p1', 'p2', 'p3'], 'p1');
    handlePlayerDisconnect(ROOM, 'p1', false);

    jest.advanceTimersByTime(RECONNECT_WINDOW_MS);

    expect(sockets.p2._messages.some((m) => m.type === 'reconnect_expired' && m.playerId === 'p1')).toBe(true);
    cleanupRoom();
  });

  it('4. emits reconnect_tick events during the 60-second window', () => {
    const { sockets } = setupRoom(['p1', 'p2', 'p3'], 'p2'); // p1 disconnects, not active
    handlePlayerDisconnect(ROOM, 'p1', false);

    // Advance one tick interval
    jest.advanceTimersByTime(TIMER_TICK_INTERVAL_MS);

    const ticks = sockets.p2._messages.filter(
      (m) => m.type === 'reconnect_tick' && m.playerId === 'p1'
    );
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    cleanupRoom();
  });

  it('7. emits timer_tick events during the 30-second window', () => {
    const { sockets } = setupRoom(['p1', 'p2', 'p3'], 'p1');
    handlePlayerDisconnect(ROOM, 'p1', false);

    jest.advanceTimersByTime(TIMER_TICK_INTERVAL_MS);

    // timerService now emits 'timer_tick' (phase:'turn') every 1 second.
    const ticks = sockets.p2._messages.filter((m) => m.type === 'timer_tick' && m.phase === 'turn');
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks[0].playerId).toBe('p1');
    cleanupRoom();
  });
});

// ---------------------------------------------------------------------------
// scheduleTurnTimerIfNeeded — tick events (new in )
// ---------------------------------------------------------------------------

describe('scheduleTurnTimerIfNeeded — tick events', () => {
  it('broadcasts timer_tick (phase:turn) every second', () => {
    const gs = makeGame({ currentPlayer: 'p1' });
    setGame(ROOM, gs);

    const ws1 = makeMockWs();
    const ws2 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);
    registerConnection(ROOM, 'p2', ws2);

    scheduleTurnTimerIfNeeded(gs);

    // timerService fires 'timer_tick' every 1 second; advance > 1 s to get at least one
    jest.advanceTimersByTime(TIMER_TICK_INTERVAL_MS);

    // New event name: 'timer_tick' with phase:'turn' (timerService )
    expect(ws1._messages.some((m) => m.type === 'timer_tick' && m.phase === 'turn')).toBe(true);
    expect(ws2._messages.some((m) => m.type === 'timer_tick' && m.phase === 'turn')).toBe(true);

    removeConnection(ROOM, 'p1');
    removeConnection(ROOM, 'p2');
    cancelTurnTimer(ROOM);
  });

  it('timer_tick includes remainingMs, remainingS, playerId, and expiresAt', () => {
    const gs = makeGame({ currentPlayer: 'p1' });
    setGame(ROOM, gs);
    const ws = makeMockWs();
    registerConnection(ROOM, 'p1', ws);

    scheduleTurnTimerIfNeeded(gs);
    jest.advanceTimersByTime(TIMER_TICK_INTERVAL_MS);

    // New event name: 'timer_tick' with phase:'turn' (timerService )
    const tick = ws._messages.find((m) => m.type === 'timer_tick' && m.phase === 'turn');
    expect(tick).toBeDefined();
    expect(tick.playerId).toBe('p1');
    expect(typeof tick.remainingMs).toBe('number');
    expect(tick.remainingMs).toBeGreaterThan(0);
    expect(tick.remainingMs).toBeLessThanOrEqual(60_000);
    expect(typeof tick.expiresAt).toBe('number');

    removeConnection(ROOM, 'p1');
    cancelTurnTimer(ROOM);
  });

  it('cancelTurnTimer stops tick emissions', () => {
    const gs = makeGame({ currentPlayer: 'p1' });
    setGame(ROOM, gs);
    const ws = makeMockWs();
    registerConnection(ROOM, 'p1', ws);

    scheduleTurnTimerIfNeeded(gs);
    jest.advanceTimersByTime(TIMER_TICK_INTERVAL_MS);
    const countBefore = ws._messages.filter((m) => m.type === 'timer_tick' && m.phase === 'turn').length;

    cancelTurnTimer(ROOM);
    jest.advanceTimersByTime(TIMER_TICK_INTERVAL_MS * 5);

    const countAfter = ws._messages.filter((m) => m.type === 'timer_tick' && m.phase === 'turn').length;
    expect(countAfter).toBe(countBefore);

    removeConnection(ROOM, 'p1');
  });
});
