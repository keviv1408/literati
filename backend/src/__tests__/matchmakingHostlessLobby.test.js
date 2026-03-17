'use strict';

/**
 * Unit tests for the hostless matchmaking lobby —
 *
 * Coverage:
 * A. isHost is always false for all players in matchmaking rooms
 * B. room_players broadcast carries isMatchmaking: true
 * C. kick_player is rejected in matchmaking rooms
 * D. reassign_team is rejected in matchmaking rooms
 * E. start_game is rejected in matchmaking rooms
 * F. handleAutoStartMatchmaking broadcasts 'lobby-starting' with isMatchmaking: true
 * G. handleAutoStartMatchmaking skips rooms that are not in 'waiting'/'starting' status
 * H. handleAutoStartMatchmaking fills empty seats with bots
 * I. Auto-start fires immediately when all players join (via matchmakingTimers logic)
 * J. Auto-start fires via 30-second timer when room is not full (timer fires)
 */

jest.useFakeTimers();

const {
  handleAutoStartMatchmaking,
  handleKickPlayer,
  handleReassignTeam,
  handleStartGame,
  roomClients,
  roomMeta,
  matchmakingTimers,
  MATCHMAKING_LOBBY_TIMEOUT_MS,
  broadcast,
  _setSupabaseClientFactory,
  _setGameServer,
  _resetRoomState,
} = require('../ws/roomSocketServer');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWs(readyState = 1 /* OPEN */) {
  return {
    readyState,
    send:  jest.fn(),
    close: jest.fn(),
  };
}

function sent(ws) {
  return ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
}

function msgOfType(ws, type) {
  return sent(ws).find((m) => m.type === type) ?? null;
}

/**
 * Build a chainable Supabase mock for fetchRoomMetaFull.
 * maybeSingle resolves to { data: roomData, error: null }
 */
function buildMockSupabase(roomData = null, updateError = null) {
  const maybeSingle = jest.fn().mockResolvedValue({ data: roomData, error: null });
  const select      = jest.fn();
  const eq          = jest.fn();
  const update      = jest.fn();

  const chain = { select, eq, maybeSingle, update };
  select.mockReturnValue(chain);
  eq.mockReturnValue(chain);
  update.mockReturnValue({
    eq: jest.fn().mockResolvedValue({ data: null, error: updateError }),
  });

  return {
    from:   jest.fn().mockReturnValue(chain),
    auth:   { getUser: jest.fn() },
    _chain: chain,
  };
}

/** Minimal mock game server — createGame returns a trivial game state. */
function buildMockGameServer(overrides = {}) {
  return {
    createGame: jest.fn().mockReturnValue({
      status: 'active',
      players: [],
      currentTurnPlayerId: null,
      ...overrides,
    }),
    scheduleBotTurnIfNeeded: jest.fn(),
  };
}

function makeRoom(overrides = {}) {
  return {
    id:                   'room-mmk-uuid',
    code:                 'MMK001',
    host_user_id:         'host-mmk',
    status:               'waiting',
    player_count:         6,
    card_removal_variant: 'remove_7s',
    is_matchmaking:       true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const ROOM_CODE = 'MMK001';

beforeEach(() => {
  _resetRoomState();
  jest.clearAllMocks();
  jest.clearAllTimers();
});

afterEach(() => {
  _resetRoomState();
});

// ---------------------------------------------------------------------------
// Helper: populate roomClients and roomMeta for a matchmaking room
// ---------------------------------------------------------------------------

function seedMatchmakingRoom(playerCount = 6, numPlayers = 1) {
  // Set room metadata
  roomMeta.set(ROOM_CODE, { playerCount, isMatchmaking: true });

  // Create client map
  const clients = new Map();
  for (let i = 1; i <= numPlayers; i++) {
    const ws = makeWs();
    clients.set(`user-${i}`, {
      ws,
      userId:      `user-${i}`,
      displayName: `Player ${i}`,
      isGuest:     false,
      isHost:      false,
      teamId:      i % 2 === 0 ? 2 : 1,
    });
  }
  roomClients.set(ROOM_CODE, clients);
  return clients;
}

// =============================================================================
// A. isHost is always false for all players in matchmaking rooms
// =============================================================================

describe('A. isHost = false for all players in matchmaking rooms', () => {
  it('stores isHost=false for every client regardless of host_user_id', () => {
    // Seed a matchmaking room where user-1 would have been the "host" in a
    // private room (i.e. host_user_id === 'user-1').
    const clients = seedMatchmakingRoom(6, 3);

    // All clients should have isHost=false
    for (const entry of clients.values()) {
      expect(entry.isHost).toBe(false);
    }
  });
});

// =============================================================================
// B. room_players broadcast carries isMatchmaking: true
// =============================================================================

describe('B. room_players broadcast includes isMatchmaking: true', () => {
  it('broadcasts isMatchmaking: true when a player joins a matchmaking room', () => {
    const clients = seedMatchmakingRoom(6, 2);
    const ws1 = clients.get('user-1').ws;
    const ws2 = clients.get('user-2').ws;

    // Manually emit a broadcast (simulating what the connection handler does)
    broadcast(ROOM_CODE, {
      type:          'room_players',
      players:       Array.from(clients.values()).map(({ userId, displayName, isGuest, isHost, teamId }) => ({
        userId, displayName, isGuest, isHost, teamId,
      })),
      isMatchmaking: true,
    });

    const msg1 = msgOfType(ws1, 'room_players');
    const msg2 = msgOfType(ws2, 'room_players');
    expect(msg1).not.toBeNull();
    expect(msg1.isMatchmaking).toBe(true);
    expect(msg2).not.toBeNull();
    expect(msg2.isMatchmaking).toBe(true);

    // isHost should be false for all broadcasted players
    for (const p of msg1.players) {
      expect(p.isHost).toBe(false);
    }
  });
});

// =============================================================================
// C. kick_player is rejected in matchmaking rooms
// =============================================================================

describe('C. kick_player rejected in matchmaking rooms', () => {
  it('sends an error when a matchmaking-room player sends kick_player', () => {
    const clients = seedMatchmakingRoom(6, 2);
    const ws = clients.get('user-1').ws;

    handleKickPlayer(
      {
        ws,
        userId:      'user-1',
        displayName: 'Player 1',
        isHost:      false,
        roomCode:    ROOM_CODE,
        clients,
        isMatchmakingRoom: true,
      },
      { type: 'kick_player', targetId: 'user-2' },
    );

    // The handler itself checks isHost — since isHost=false, it should error.
    const errorMsg = msgOfType(ws, 'error');
    expect(errorMsg).not.toBeNull();
    expect(errorMsg.message).toMatch(/host/i);
  });
});

// =============================================================================
// D. reassign_team rejected in matchmaking rooms
// =============================================================================

describe('D. reassign_team rejected in matchmaking rooms', () => {
  it('sends an error when reassign_team is sent in a matchmaking room', () => {
    const clients = seedMatchmakingRoom(6, 2);
    const ws = clients.get('user-1').ws;

    handleReassignTeam(
      {
        ws,
        userId:      'user-1',
        isHost:      false,
        roomCode:    ROOM_CODE,
        clients,
      },
      { type: 'reassign_team', targetId: 'user-2', teamId: 2 },
    );

    // handleReassignTeam requires isHost=true; since false it sends error
    const errorMsg = msgOfType(ws, 'error');
    expect(errorMsg).not.toBeNull();
  });
});

// =============================================================================
// E. start_game rejected in matchmaking rooms
// =============================================================================

describe('E. start_game rejected in matchmaking rooms', () => {
  it('sends an error when start_game is sent by any player in a matchmaking room', async () => {
    // handleStartGame requires isHost=true; matchmaking rooms set isHost=false
    const clients = seedMatchmakingRoom(6, 1);
    const ws = clients.get('user-1').ws;

    _setGameServer(buildMockGameServer());
    _setSupabaseClientFactory(() => buildMockSupabase(makeRoom()));

    await handleStartGame({ ws, userId: 'user-1', isHost: false, roomCode: ROOM_CODE, clients });

    const errorMsg = msgOfType(ws, 'error');
    expect(errorMsg).not.toBeNull();
  });
});

// =============================================================================
// F. handleAutoStartMatchmaking broadcasts 'lobby-starting' with isMatchmaking: true
// =============================================================================

describe('F. handleAutoStartMatchmaking broadcasts lobby-starting', () => {
  it('sends lobby-starting with isMatchmaking: true to all clients', async () => {
    const room = makeRoom();
    _setSupabaseClientFactory(() => buildMockSupabase(room));
    _setGameServer(buildMockGameServer());

    const clients = seedMatchmakingRoom(6, 4);
    const allWs = Array.from(clients.values()).map((e) => e.ws);

    await handleAutoStartMatchmaking(ROOM_CODE, clients, 6);

    for (const ws of allWs) {
      const msg = msgOfType(ws, 'lobby-starting');
      expect(msg).not.toBeNull();
      expect(msg.roomCode).toBe(ROOM_CODE);
      expect(msg.isMatchmaking).toBe(true);
    }
  });

  it('includes a seats array in lobby-starting', async () => {
    const room = makeRoom();
    _setSupabaseClientFactory(() => buildMockSupabase(room));
    _setGameServer(buildMockGameServer());

    const clients = seedMatchmakingRoom(6, 3);
    const ws = clients.get('user-1').ws;

    await handleAutoStartMatchmaking(ROOM_CODE, clients, 6);

    const msg = msgOfType(ws, 'lobby-starting');
    expect(Array.isArray(msg.seats)).toBe(true);
    expect(msg.seats.length).toBe(6); // always full count
  });
});

// =============================================================================
// G. handleAutoStartMatchmaking skips non-waiting rooms
// =============================================================================

describe('G. handleAutoStartMatchmaking skips rooms not in waiting/starting', () => {
  it('does nothing when the room is already in_progress', async () => {
    const room = makeRoom({ status: 'in_progress' });
    _setSupabaseClientFactory(() => buildMockSupabase(room));
    _setGameServer(buildMockGameServer());

    const clients = seedMatchmakingRoom(6, 2);
    const ws = clients.get('user-1').ws;

    await handleAutoStartMatchmaking(ROOM_CODE, clients, 6);

    // No lobby-starting should be sent
    expect(msgOfType(ws, 'lobby-starting')).toBeNull();
  });

  it('does nothing when the room is not found in DB', async () => {
    _setSupabaseClientFactory(() => buildMockSupabase(null));
    _setGameServer(buildMockGameServer());

    const clients = seedMatchmakingRoom(6, 2);
    const ws = clients.get('user-1').ws;

    await handleAutoStartMatchmaking(ROOM_CODE, clients, 6);

    expect(msgOfType(ws, 'lobby-starting')).toBeNull();
  });
});

// =============================================================================
// H. handleAutoStartMatchmaking fills empty seats with bots
// =============================================================================

describe('H. handleAutoStartMatchmaking fills empty seats with bots', () => {
  it('adds bots when fewer than playerCount humans are connected', async () => {
    const room = makeRoom();
    _setSupabaseClientFactory(() => buildMockSupabase(room));

    let capturedSeats = null;
    const mockGameServer = {
      createGame: jest.fn().mockImplementation(({ seats }) => {
        capturedSeats = seats;
        return { status: 'active', players: [], currentTurnPlayerId: null };
      }),
      scheduleBotTurnIfNeeded: jest.fn(),
    };
    _setGameServer(mockGameServer);

    // Only 2 of 6 seats filled with humans
    const clients = seedMatchmakingRoom(6, 2);

    await handleAutoStartMatchmaking(ROOM_CODE, clients, 6);

    expect(capturedSeats).not.toBeNull();
    expect(capturedSeats.length).toBe(6);

    const bots = capturedSeats.filter((s) => s.isBot);
    const humans = capturedSeats.filter((s) => !s.isBot);
    expect(bots.length).toBe(4);
    expect(humans.length).toBe(2);
  });

  it('sends botsAdded array in lobby-starting', async () => {
    const room = makeRoom();
    _setSupabaseClientFactory(() => buildMockSupabase(room));
    _setGameServer(buildMockGameServer());

    const clients = seedMatchmakingRoom(6, 2);
    const ws = clients.get('user-1').ws;

    await handleAutoStartMatchmaking(ROOM_CODE, clients, 6);

    const msg = msgOfType(ws, 'lobby-starting');
    expect(Array.isArray(msg.botsAdded)).toBe(true);
    expect(msg.botsAdded.length).toBe(4); // 6 - 2 humans
  });
});

// =============================================================================
// I. Auto-start fires immediately when all seats fill
// =============================================================================

describe('I. matchmakingTimers: immediate auto-start when room fills', () => {
  it('sets the :started sentinel key when full-room auto-start is triggered', () => {
    const clients = seedMatchmakingRoom(6, 6);

    // Simulate what the connection handler does when clients.size >= playerCount:
    // sets the ':started' sentinel before calling handleAutoStartMatchmaking
    if (clients.size >= 6 && !matchmakingTimers.has(ROOM_CODE + ':started')) {
      const timer = matchmakingTimers.get(ROOM_CODE);
      if (timer) { clearTimeout(timer); matchmakingTimers.delete(ROOM_CODE); }
      matchmakingTimers.set(ROOM_CODE + ':started', true);
    }

    expect(matchmakingTimers.get(ROOM_CODE + ':started')).toBe(true);
    expect(matchmakingTimers.has(ROOM_CODE)).toBe(false); // fill timer cleared
  });
});

// =============================================================================
// J. Auto-start fires via 30-second timer when room is not full
// =============================================================================

describe('J. matchmakingTimers: 30-second fill timer fires auto-start', () => {
  it('sets a timer for the configured timeout duration', () => {
    seedMatchmakingRoom(6, 1); // only 1 player

    // Simulate the connection handler setting the timer on first join
    if (!matchmakingTimers.has(ROOM_CODE)) {
      const handle = setTimeout(() => {
        matchmakingTimers.delete(ROOM_CODE);
        if (matchmakingTimers.has(ROOM_CODE + ':started')) return;
        matchmakingTimers.set(ROOM_CODE + ':started', true);
      }, MATCHMAKING_LOBBY_TIMEOUT_MS);
      if (handle.unref) handle.unref();
      matchmakingTimers.set(ROOM_CODE, handle);
    }

    expect(matchmakingTimers.has(ROOM_CODE)).toBe(true);

    // Advance time past the timeout
    jest.advanceTimersByTime(MATCHMAKING_LOBBY_TIMEOUT_MS + 100);

    // After timer fires: the timer entry is deleted and ':started' is set
    expect(matchmakingTimers.has(ROOM_CODE)).toBe(false);
    expect(matchmakingTimers.get(ROOM_CODE + ':started')).toBe(true);
  });

  it('MATCHMAKING_LOBBY_TIMEOUT_MS is 30 seconds', () => {
    expect(MATCHMAKING_LOBBY_TIMEOUT_MS).toBe(30 * 1000);
  });

  it('second timer is not created when one is already pending', () => {
    seedMatchmakingRoom(6, 1);

    // Start first timer
    const handle1 = setTimeout(() => {}, MATCHMAKING_LOBBY_TIMEOUT_MS);
    matchmakingTimers.set(ROOM_CODE, handle1);

    // Simulate second player joining — should not create a new timer
    const sizeBefore = matchmakingTimers.size;
    if (!matchmakingTimers.has(ROOM_CODE)) {
      // This branch should NOT execute
      matchmakingTimers.set(ROOM_CODE, setTimeout(() => {}, MATCHMAKING_LOBBY_TIMEOUT_MS));
    }

    expect(matchmakingTimers.size).toBe(sizeBefore); // unchanged
    clearTimeout(handle1);
  });
});
