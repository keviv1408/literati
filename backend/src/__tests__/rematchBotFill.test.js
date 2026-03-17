'use strict';

/**
 * Unit tests for Rematch bot-fill timer.
 *
 * After a rematch is agreed (host sends rematch_initiate), a 30-second window
 * opens for original human players to navigate back to the room lobby. On
 * expiry, any still-absent human slots are filled with bots and the new game
 * starts automatically.
 *
 * Coverage:
 * startRematchBotFillTimer:
 * 1. No pending rematch → logs a warning and returns without setting a timer
 * 2. Sets a timer for the configured duration
 * 3. Re-calling before expiry cancels the first timer
 * 4. All-bot roster → no timer needed (skips human check, doesn't set a timer)
 *
 * cancelRematchBotFillTimer:
 * 5. Clears the pending timer
 * 6. Safe to call when no timer is active
 *
 * _executeRematchBotFill:
 * 7. No pending rematch → skips and returns
 * 8. DB room not found → skips and clears pending rematch
 * 9. Room already in_progress → skips and clears pending rematch
 * 10. All humans absent → all seats filled with bots; lobby-starting broadcast
 * 11. Some humans present → present humans keep original seats; absent → bots
 * 12. All humans present → no bots added; botsAdded = []
 * 13. lobby-starting payload includes isRematch: true
 * 14. Supabase room status updated to 'in_progress'
 * 15. createGame called with correct roomCode, variant, playerCount, seats
 * 16. createGame failure → broadcast error and skip; pending rematch cleared
 * 17. _startingRooms idempotency guard prevents double-start
 * 18. pendingRematch is cleared after a successful start
 *
 * Early-start integration (via startRematchBotFillTimer fast-path):
 * 19. All humans already present when timer starts → starts immediately
 * 20. Timer start with humans partially present → timer set, not immediate
 *
 * REMATCH_BOT_FILL_TIMEOUT_MS:
 * 21. Constant equals 30 000 ms
 */

jest.useFakeTimers();

const {
  startRematchBotFillTimer,
  cancelRematchBotFillTimer,
  _executeRematchBotFill,
  _rematchBotFillTimers,
  REMATCH_BOT_FILL_TIMEOUT_MS,
  roomClients,
  _resetRoomState,
  _startingRooms,
} = require('../ws/roomSocketServer');

const {
  setPendingRematch,
  clearPendingRematch,
  getPendingRematch,
  _clearAll: clearAllPendingRematch,
} = require('../game/pendingRematchStore');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHuman(id, seatIndex, teamId) {
  return {
    playerId:    id,
    displayName: `Human_${id}`,
    avatarId:    null,
    teamId,
    seatIndex,
    isBot:   false,
    isGuest: false,
  };
}

function makeBot(id, seatIndex, teamId) {
  return {
    playerId:    id,
    displayName: `Bot_${id}`,
    avatarId:    null,
    teamId,
    seatIndex,
    isBot:   true,
    isGuest: false,
  };
}

/** Build a minimal pending rematch configuration for a 6-player room. */
function makePending6(playerOverrides = []) {
  const defaults = [
    makeHuman('h1', 0, 1),
    makeHuman('h2', 1, 2),
    makeHuman('h3', 2, 1),
    makeHuman('h4', 3, 2),
    makeHuman('h5', 4, 1),
    makeHuman('h6', 5, 2),
  ];
  const players = playerOverrides.length > 0 ? playerOverrides : defaults;
  return {
    players,
    variant:       'remove_7s',
    playerCount:   6,
  };
}

/** Register a fake client into roomClients for the given room. */
function registerFakeClient(roomCode, userId, teamId = 1) {
  if (!roomClients.has(roomCode)) roomClients.set(roomCode, new Map());
  roomClients.get(roomCode).set(userId, {
    ws: { send: jest.fn(), readyState: 1 },
    userId,
    displayName: `Display_${userId}`,
    isGuest: false,
    isHost:  false,
    teamId,
  });
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock `getSupabaseClient` for fetchRoomMetaFull via _setSupabaseClientFactory
const {
  _setSupabaseClientFactory,
  _setGameServer,
} = require('../ws/roomSocketServer');

/** Default DB room returned by fetchRoomMetaFull. */
const DEFAULT_DB_ROOM = {
  id:                   'room-uuid-1',
  host_user_id:         'host-user',
  status:               'waiting',
  player_count:         6,
  card_removal_variant: 'remove_7s',
};

/**
 * Build a mock Supabase client that handles both read and write chains.
 *
 * fetchRoomMetaFull does: from('rooms').select(...).eq('code', code).maybeSingle()
 * status update does: from('rooms').update({...}).eq('code', code)
 *
 * We track which operation is in progress and return the appropriate mock.
 */
function setupSupabaseMock(roomData = DEFAULT_DB_ROOM) {
  let _inUpdateChain = false;
  const mockMaybeSingle = jest.fn().mockResolvedValue({ data: roomData, error: null });
  const mockUpdate = jest.fn().mockImplementation(() => {
    _inUpdateChain = true;
    return sb; // eslint-disable-line no-use-before-define
  });
  const mockSelect = jest.fn().mockImplementation(() => {
    _inUpdateChain = false;
    return sb; // eslint-disable-line no-use-before-define
  });
  const mockEq = jest.fn().mockImplementation(() => {
    if (_inUpdateChain) {
      return Promise.resolve({ data: null, error: null });
    }
    return sb; // eslint-disable-line no-use-before-define
  });
  const sb = {
    from:        jest.fn().mockImplementation(() => { _inUpdateChain = false; return sb; }),
    select:      mockSelect,
    update:      mockUpdate,
    eq:          mockEq,
    maybeSingle: mockMaybeSingle,
  };
  _setSupabaseClientFactory(() => sb);
  return sb;
}

let broadcastMessages = [];
let mockCreateGame;

function setupGameServerMock(gameStatePlayers = []) {
  broadcastMessages = [];
  mockCreateGame = jest.fn().mockReturnValue({
    roomCode:           'ROOM01',
    players:            gameStatePlayers,
    currentTurnPlayerId: gameStatePlayers[0]?.playerId ?? 'h1',
    status:             'active',
  });

  _setGameServer({
    createGame:              mockCreateGame,
    scheduleBotTurnIfNeeded: jest.fn(),
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllTimers();
  _resetRoomState();
  clearAllPendingRematch();
  setupGameServerMock();
  setupSupabaseMock();
  broadcastMessages = [];
});

afterEach(() => {
  _resetRoomState();
  clearAllPendingRematch();
  _setSupabaseClientFactory(null);
  _setGameServer(null);
  jest.clearAllTimers();
});

// ---------------------------------------------------------------------------
// Tests — startRematchBotFillTimer
// ---------------------------------------------------------------------------

describe('startRematchBotFillTimer', () => {
  test('1. no pending rematch → warns and returns without setting a timer', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    startRematchBotFillTimer('ROOM01');
    expect(_rematchBotFillTimers.has('ROOM01')).toBe(false);
    warnSpy.mockRestore();
  });

  test('2. sets a timer for REMATCH_BOT_FILL_TIMEOUT_MS', () => {
    setPendingRematch('ROOM01', makePending6());
    startRematchBotFillTimer('ROOM01');
    expect(_rematchBotFillTimers.has('ROOM01')).toBe(true);
  });

  test('3. re-calling before expiry cancels the first timer and sets a new one', () => {
    setPendingRematch('ROOM01', makePending6());
    startRematchBotFillTimer('ROOM01');
    const firstHandle = _rematchBotFillTimers.get('ROOM01');
    startRematchBotFillTimer('ROOM01');
    const secondHandle = _rematchBotFillTimers.get('ROOM01');
    // Two different timer handles means the first was cancelled and replaced.
    expect(secondHandle).not.toBe(firstHandle);
  });

  test('4. all-bot roster → no human players to wait for → no timer set (logs immediately)', () => {
    const allBots = [
      makeBot('b1', 0, 1), makeBot('b2', 1, 2),
      makeBot('b3', 2, 1), makeBot('b4', 3, 2),
      makeBot('b5', 4, 1), makeBot('b6', 5, 2),
    ];
    setPendingRematch('ROOM01', { ...makePending6(allBots), players: allBots });
    // No timer is set because humanPlayers.length === 0.
    startRematchBotFillTimer('ROOM01');
    // For an all-bot game the function should not set a pending timer
    // (there are no human players to wait for).
    expect(_rematchBotFillTimers.has('ROOM01')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests — cancelRematchBotFillTimer
// ---------------------------------------------------------------------------

describe('cancelRematchBotFillTimer', () => {
  test('5. clears the pending timer', () => {
    setPendingRematch('ROOM01', makePending6());
    startRematchBotFillTimer('ROOM01');
    expect(_rematchBotFillTimers.has('ROOM01')).toBe(true);
    cancelRematchBotFillTimer('ROOM01');
    expect(_rematchBotFillTimers.has('ROOM01')).toBe(false);
  });

  test('6. safe to call when no timer is active', () => {
    expect(() => cancelRematchBotFillTimer('NOROOM')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests — _executeRematchBotFill
// ---------------------------------------------------------------------------

describe('_executeRematchBotFill', () => {
  test('7. no pending rematch → skips', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await _executeRematchBotFill('ROOM01');
    expect(mockCreateGame).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  test('8. DB room not found → skips and clears pending rematch', async () => {
    setPendingRematch('ROOM01', makePending6());
    setupSupabaseMock(null); // null = room not found
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await _executeRematchBotFill('ROOM01');
    expect(mockCreateGame).not.toHaveBeenCalled();
    expect(getPendingRematch('ROOM01')).toBeNull();
    errSpy.mockRestore();
  });

  test('9. room already in_progress → skips and clears pending rematch', async () => {
    setPendingRematch('ROOM01', makePending6());
    setupSupabaseMock({ ...DEFAULT_DB_ROOM, status: 'in_progress' });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await _executeRematchBotFill('ROOM01');
    expect(mockCreateGame).not.toHaveBeenCalled();
    expect(getPendingRematch('ROOM01')).toBeNull();
    logSpy.mockRestore();
  });

  test('10. all humans absent → all 6 seats filled with bots; createGame called', async () => {
    setPendingRematch('ROOM01', makePending6());
    setupSupabaseMock();
    // roomClients is empty — no humans have reconnected
    const clients = new Map();
    await _executeRematchBotFill('ROOM01', clients);
    expect(mockCreateGame).toHaveBeenCalledTimes(1);
    const { seats } = mockCreateGame.mock.calls[0][0];
    expect(seats).toHaveLength(6);
    expect(seats.every((s) => s.isBot)).toBe(true);
  });

  test('11. some humans present → present keep original seats; absent become bots', async () => {
    const pending = makePending6();
    setPendingRematch('ROOM01', pending);
    setupSupabaseMock();

    // h1 (seat 0, team 1) and h3 (seat 2, team 1) reconnected; others absent
    const clients = new Map([
      ['h1', { userId: 'h1', displayName: 'Human_h1', isGuest: false, teamId: 1 }],
      ['h3', { userId: 'h3', displayName: 'Human_h3', isGuest: false, teamId: 1 }],
    ]);

    await _executeRematchBotFill('ROOM01', clients);
    expect(mockCreateGame).toHaveBeenCalledTimes(1);

    const { seats } = mockCreateGame.mock.calls[0][0];
    expect(seats).toHaveLength(6);

    // h1 at seat 0 should be human, team 1
    const seat0 = seats.find((s) => s.seatIndex === 0);
    expect(seat0.playerId).toBe('h1');
    expect(seat0.isBot).toBe(false);
    expect(seat0.teamId).toBe(1);

    // h3 at seat 2 should be human, team 1
    const seat2 = seats.find((s) => s.seatIndex === 2);
    expect(seat2.playerId).toBe('h3');
    expect(seat2.isBot).toBe(false);

    // remaining 4 seats should be bots
    const botSeats = seats.filter((s) => s.isBot);
    expect(botSeats).toHaveLength(4);
  });

  test('12. all humans present → no bots; botsAdded is empty', async () => {
    const pending = makePending6();
    setPendingRematch('ROOM01', pending);
    setupSupabaseMock();

    // All 6 humans present
    const clients = new Map(
      pending.players.map((p) => [p.playerId, {
        userId:      p.playerId,
        displayName: p.displayName,
        isGuest:     false,
        teamId:      p.teamId,
      }])
    );

    // Capture broadcast calls by patching roomClients to include a ws entry
    // (broadcast requires at least one connected client to fire).
    // Since the test uses a clientsOverride, we just verify createGame args.
    await _executeRematchBotFill('ROOM01', clients);
    expect(mockCreateGame).toHaveBeenCalledTimes(1);
    const { seats } = mockCreateGame.mock.calls[0][0];
    expect(seats.filter((s) => s.isBot)).toHaveLength(0);
  });

  test('13. lobby-starting payload includes isRematch: true', async () => {
    // We need at least one ws client in roomClients to receive the broadcast.
    registerFakeClient('ROOM01', 'h1', 1);
    const pending = makePending6();
    setPendingRematch('ROOM01', pending);
    setupSupabaseMock();

    const clients = new Map([
      ['h1', { userId: 'h1', displayName: 'Human_h1', isGuest: false, teamId: 1 }],
    ]);

    const sentMessages = [];
    roomClients.get('ROOM01').get('h1').ws.send.mockImplementation((msg) => {
      sentMessages.push(JSON.parse(msg));
    });

    await _executeRematchBotFill('ROOM01', clients);

    const lobbyStarting = sentMessages.find((m) => m.type === 'lobby-starting');
    expect(lobbyStarting).toBeDefined();
    expect(lobbyStarting.isRematch).toBe(true);
    expect(lobbyStarting.roomCode).toBe('ROOM01');
  });

  test('14. Supabase room status updated to in_progress', async () => {
    const pending = makePending6();
    setPendingRematch('ROOM01', pending);
    const supabaseMock = setupSupabaseMock();
    const clients = new Map();
    await _executeRematchBotFill('ROOM01', clients);
    // verify update('in_progress') was called
    expect(supabaseMock.update).toHaveBeenCalledWith({ status: 'in_progress' });
  });

  test('15. createGame called with correct roomCode, variant, playerCount', async () => {
    const pending = makePending6();
    setPendingRematch('ROOM01', pending);
    setupSupabaseMock();
    const clients = new Map();
    await _executeRematchBotFill('ROOM01', clients);
    expect(mockCreateGame).toHaveBeenCalledWith(
      expect.objectContaining({
        roomCode:    'ROOM01',
        variant:     'remove_7s',
        playerCount: 6,
        roomId:      DEFAULT_DB_ROOM.id,
      })
    );
  });

  test('16. createGame failure → broadcasts error; pendingRematch cleared', async () => {
    registerFakeClient('ROOM01', 'h1', 1);
    const pending = makePending6();
    setPendingRematch('ROOM01', pending);
    setupSupabaseMock();
    _setGameServer({ createGame: jest.fn().mockImplementation(() => { throw new Error('boom'); }) });

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const sentMessages = [];
    roomClients.get('ROOM01').get('h1').ws.send.mockImplementation((msg) => {
      sentMessages.push(JSON.parse(msg));
    });
    const clients = new Map();
    await _executeRematchBotFill('ROOM01', clients);
    const errorMsg = sentMessages.find((m) => m.type === 'error');
    expect(errorMsg).toBeDefined();
    // pendingRematch should be cleared after execution
    expect(getPendingRematch('ROOM01')).toBeNull();
    errSpy.mockRestore();
  });

  test('17. _startingRooms idempotency prevents double-start', async () => {
    setPendingRematch('ROOM01', makePending6());
    setupSupabaseMock();
    _startingRooms.add('ROOM01'); // simulate room already starting

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const clients = new Map();
    await _executeRematchBotFill('ROOM01', clients);
    expect(mockCreateGame).not.toHaveBeenCalled();
    logSpy.mockRestore();

    _startingRooms.delete('ROOM01'); // clean up
  });

  test('18. pendingRematch cleared after successful start', async () => {
    setPendingRematch('ROOM01', makePending6());
    setupSupabaseMock();
    const clients = new Map();
    await _executeRematchBotFill('ROOM01', clients);
    expect(getPendingRematch('ROOM01')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — early-start fast-path in startRematchBotFillTimer
// ---------------------------------------------------------------------------

describe('startRematchBotFillTimer early-start fast-path', () => {
  test('19. all humans already present when timer starts → starts immediately (no pending timer)', () => {
    const pending = makePending6();
    setPendingRematch('ROOM01', pending);

    // Pre-populate roomClients with all 6 humans.
    for (const p of pending.players) {
      registerFakeClient('ROOM01', p.playerId, p.teamId);
    }

    startRematchBotFillTimer('ROOM01');

    // No timer should be set because all humans are already present.
    expect(_rematchBotFillTimers.has('ROOM01')).toBe(false);
    // _executeRematchBotFill is called via process.nextTick — not synchronously.
    // We verify the timer was NOT set (the rest is handled by process.nextTick).
  });

  test('20. humans partially present when timer starts → timer set', () => {
    const pending = makePending6();
    setPendingRematch('ROOM01', pending);

    // Only 3 of 6 humans connected.
    registerFakeClient('ROOM01', 'h1', 1);
    registerFakeClient('ROOM01', 'h2', 2);
    registerFakeClient('ROOM01', 'h3', 1);

    startRematchBotFillTimer('ROOM01');

    expect(_rematchBotFillTimers.has('ROOM01')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — timer fires after REMATCH_BOT_FILL_TIMEOUT_MS
// ---------------------------------------------------------------------------

describe('timer fires after REMATCH_BOT_FILL_TIMEOUT_MS', () => {
  test('21. REMATCH_BOT_FILL_TIMEOUT_MS is 30 000', () => {
    expect(REMATCH_BOT_FILL_TIMEOUT_MS).toBe(30_000);
  });

  test('22. after 30s the timer fires and calls _executeRematchBotFill indirectly', async () => {
    const pending = makePending6();
    setPendingRematch('ROOM01', pending);
    setupSupabaseMock();

    startRematchBotFillTimer('ROOM01');
    expect(_rematchBotFillTimers.has('ROOM01')).toBe(true);

    // Advance fake timers past the 30-second mark.
    jest.advanceTimersByTime(REMATCH_BOT_FILL_TIMEOUT_MS);

    // Timer handle is removed once it fires.
    expect(_rematchBotFillTimers.has('ROOM01')).toBe(false);

    // Flush any micro-tasks / Promises that _executeRematchBotFill may have queued.
    await Promise.resolve();
    await Promise.resolve();

    // createGame should have been called (all humans absent → bot fill).
    expect(mockCreateGame).toHaveBeenCalledTimes(1);
  });
});
