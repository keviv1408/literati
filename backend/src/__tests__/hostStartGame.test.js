'use strict';

/**
 * Unit tests for handleStartGame —
 *
 * Tests the host-initiated game-start flow that fills empty lobby seats with
 * smart bots and broadcasts 'lobby-starting' to all connected clients.
 *
 * Coverage:
 * A. Authorisation — only the host may start the game
 * B. Status guard — room must be in 'waiting' state
 * C. Bot filling — empty seats are filled with bots; occupied kept
 * D. Broadcast — 'lobby-starting' sent to all connected WS clients
 * E. Supabase — room status updated to 'starting'
 * F. Idempotency — concurrent duplicate calls are serialised / rejected
 * G. Edge cases — solo host (all bots), full room (no bots), 8-player
 */

const {
  handleStartGame,
  roomClients,
  roomMeta,
  _setSupabaseClientFactory,
  _setGameServer,
  _startingRooms,
  _resetRoomState,
} = require('../ws/roomSocketServer');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockWs(readyState = 1 /* OPEN */) {
  return {
    readyState,
    send:  jest.fn(),
    close: jest.fn(),
  };
}

function lastSent(ws) {
  const calls = ws.send.mock.calls;
  if (!calls.length) return null;
  return JSON.parse(calls[calls.length - 1][0]);
}

function allSent(ws) {
  return ws.send.mock.calls.map((c) => JSON.parse(c[0]));
}

function msgOfType(ws, type) {
  return allSent(ws).find((m) => m.type === type) ?? null;
}

/**
 * Build a chainable Supabase mock.
 * maybeSingle always returns `roomData`.
 */
function buildMockSupabase(roomData = null, updateError = null) {
  const maybySingle = jest.fn().mockResolvedValue({ data: roomData, error: null });
  const select      = jest.fn();
  const eq          = jest.fn();
  const update      = jest.fn();

  const chain = { select, eq, maybeSingle: maybySingle, update };
  select.mockReturnValue(chain);
  eq.mockReturnValue(chain);
  update.mockReturnValue({
    eq: jest.fn().mockResolvedValue({ data: null, error: updateError }),
  });

  return {
    from:   jest.fn().mockReturnValue(chain),
    auth:   { getUser: jest.fn() },
    update,
    _chain: chain,
  };
}

/** Minimal mock game server that satisfies handleStartGame's needs. */
function buildMockGameServer() {
  return {
    createGame:              jest.fn().mockReturnValue({ status: 'active', players: [], currentTurnPlayerId: null }),
    scheduleBotTurnIfNeeded: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROOM_CODE  = 'START1';
const ROOM_ID    = 'room-uuid-start1';
const HOST_ID    = 'host-start1';
const PLAYER1_ID = 'player1-start1';

function makeWaitingRoom(overrides = {}) {
  return {
    id:                   ROOM_ID,
    code:                 ROOM_CODE,
    host_user_id:         HOST_ID,
    player_count:         6,
    card_removal_variant: 'remove_7s',
    status:               'waiting',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetRoomState();
  _startingRooms.clear();
  jest.clearAllMocks();
  // Inject a no-op game server by default so tests don't require game engine
  _setGameServer(buildMockGameServer());
});

afterEach(() => {
  _resetRoomState();
  _startingRooms.clear();
  _setGameServer(null);
  _setSupabaseClientFactory(null);
});

// ---------------------------------------------------------------------------
// Helper: register clients in roomClients and roomMeta
// ---------------------------------------------------------------------------

function registerClients(code, playerCount, entries) {
  if (!roomClients.has(code)) roomClients.set(code, new Map());
  const clients = roomClients.get(code);
  for (const e of entries) {
    clients.set(e.userId, e);
  }
  roomMeta.set(code, { playerCount });
}

// ---------------------------------------------------------------------------
// A. Authorisation
// ---------------------------------------------------------------------------

describe('A. Authorisation', () => {
  it('rejects non-host with an error message', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom());
    _setSupabaseClientFactory(() => supabase);

    const ws = createMockWs();
    registerClients(ROOM_CODE, 6, [
      { userId: HOST_ID,    displayName: 'Host',    isGuest: false, isHost: true,  teamId: 1, ws: createMockWs() },
      { userId: PLAYER1_ID, displayName: 'Player1', isGuest: false, isHost: false, teamId: 2, ws },
    ]);
    const clients = roomClients.get(ROOM_CODE);

    await handleStartGame({ ws, userId: PLAYER1_ID, isHost: false, roomCode: ROOM_CODE, clients });

    const errMsg = msgOfType(ws, 'error');
    expect(errMsg).not.toBeNull();
    expect(errMsg.message).toMatch(/only the host/i);
  });

  it('does NOT call Supabase when requester is not the host', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom());
    _setSupabaseClientFactory(() => supabase);

    const ws = createMockWs();
    registerClients(ROOM_CODE, 6, [
      { userId: PLAYER1_ID, displayName: 'P1', isGuest: false, isHost: false, teamId: 1, ws },
    ]);
    const clients = roomClients.get(ROOM_CODE);

    await handleStartGame({ ws, userId: PLAYER1_ID, isHost: false, roomCode: ROOM_CODE, clients });

    expect(supabase.from).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// B. Status guard
// ---------------------------------------------------------------------------

describe('B. Status guard', () => {
  it('rejects when room status is "in_progress"', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom({ status: 'in_progress' }));
    _setSupabaseClientFactory(() => supabase);

    const ws = createMockWs();
    registerClients(ROOM_CODE, 6, [
      { userId: HOST_ID, displayName: 'Host', isGuest: false, isHost: true, teamId: 1, ws },
    ]);
    const clients = roomClients.get(ROOM_CODE);

    await handleStartGame({ ws, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    const errMsg = msgOfType(ws, 'error');
    expect(errMsg).not.toBeNull();
    expect(errMsg.code).toBe('ROOM_NOT_WAITING');
  });

  it('rejects when room status is "starting"', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom({ status: 'starting' }));
    _setSupabaseClientFactory(() => supabase);

    const ws = createMockWs();
    registerClients(ROOM_CODE, 6, [
      { userId: HOST_ID, displayName: 'Host', isGuest: false, isHost: true, teamId: 1, ws },
    ]);
    const clients = roomClients.get(ROOM_CODE);

    await handleStartGame({ ws, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    const errMsg = msgOfType(ws, 'error');
    expect(errMsg).not.toBeNull();
    expect(errMsg.code).toBe('ROOM_NOT_WAITING');
  });

  it('rejects when room is not found in DB', async () => {
    const supabase = buildMockSupabase(null);
    _setSupabaseClientFactory(() => supabase);

    const ws = createMockWs();
    registerClients(ROOM_CODE, 6, [
      { userId: HOST_ID, displayName: 'Host', isGuest: false, isHost: true, teamId: 1, ws },
    ]);
    const clients = roomClients.get(ROOM_CODE);

    await handleStartGame({ ws, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    const errMsg = msgOfType(ws, 'error');
    expect(errMsg).not.toBeNull();
    expect(errMsg.message).toMatch(/room not found/i);
  });
});

// ---------------------------------------------------------------------------
// C. Bot filling
// ---------------------------------------------------------------------------

describe('C. Bot filling', () => {
  it('fills all 5 empty seats with bots when only host is present', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom());
    _setSupabaseClientFactory(() => supabase);

    const hostWs = createMockWs();
    registerClients(ROOM_CODE, 6, [
      { userId: HOST_ID, displayName: 'Host', isGuest: false, isHost: true, teamId: 1, ws: hostWs },
    ]);
    const clients = roomClients.get(ROOM_CODE);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    const startMsg = msgOfType(hostWs, 'lobby-starting');
    expect(startMsg).not.toBeNull();
    expect(startMsg.botsAdded).toHaveLength(5);
    expect(startMsg.seats).toHaveLength(6);
  });

  it('fills 0 bots when the room is already at full capacity', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom());
    _setSupabaseClientFactory(() => supabase);

    const wss = Array.from({ length: 6 }, () => createMockWs());
    const entries = [
      { userId: HOST_ID,          displayName: 'Host', isGuest: false, isHost: true,  teamId: 1, ws: wss[0] },
      { userId: 'p1', displayName: 'P1', isGuest: false, isHost: false, teamId: 2, ws: wss[1] },
      { userId: 'p2', displayName: 'P2', isGuest: false, isHost: false, teamId: 1, ws: wss[2] },
      { userId: 'p3', displayName: 'P3', isGuest: false, isHost: false, teamId: 2, ws: wss[3] },
      { userId: 'p4', displayName: 'P4', isGuest: false, isHost: false, teamId: 1, ws: wss[4] },
      { userId: 'p5', displayName: 'P5', isGuest: false, isHost: false, teamId: 2, ws: wss[5] },
    ];
    registerClients(ROOM_CODE, 6, entries);
    const clients = roomClients.get(ROOM_CODE);

    await handleStartGame({ ws: wss[0], userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    const startMsg = msgOfType(wss[0], 'lobby-starting');
    expect(startMsg).not.toBeNull();
    expect(startMsg.botsAdded).toHaveLength(0);
    expect(startMsg.seats).toHaveLength(6);
  });

  it('fills exactly 3 empty seats in an 8-player room with 5 humans', async () => {
    const room8 = makeWaitingRoom({ player_count: 8 });
    const supabase = buildMockSupabase(room8);
    _setSupabaseClientFactory(() => supabase);

    const hostWs = createMockWs();
    const entries = [
      { userId: HOST_ID, displayName: 'Host', isGuest: false, isHost: true,  teamId: 1, ws: hostWs },
      { userId: 'p1',    displayName: 'P1',   isGuest: false, isHost: false, teamId: 2, ws: createMockWs() },
      { userId: 'p2',    displayName: 'P2',   isGuest: false, isHost: false, teamId: 1, ws: createMockWs() },
      { userId: 'p3',    displayName: 'P3',   isGuest: false, isHost: false, teamId: 2, ws: createMockWs() },
      { userId: 'p4',    displayName: 'P4',   isGuest: false, isHost: false, teamId: 1, ws: createMockWs() },
    ];
    registerClients(ROOM_CODE, 8, entries);
    const clients = roomClients.get(ROOM_CODE);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    const startMsg = msgOfType(hostWs, 'lobby-starting');
    expect(startMsg).not.toBeNull();
    expect(startMsg.botsAdded).toHaveLength(3);
    expect(startMsg.seats).toHaveLength(8);
  });

  it('all bot playerIds start with "bot_"', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom());
    _setSupabaseClientFactory(() => supabase);

    const hostWs = createMockWs();
    registerClients(ROOM_CODE, 6, [
      { userId: HOST_ID, displayName: 'Host', isGuest: false, isHost: true, teamId: 1, ws: hostWs },
    ]);
    const clients = roomClients.get(ROOM_CODE);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    const startMsg = msgOfType(hostWs, 'lobby-starting');
    for (const botId of startMsg.botsAdded) {
      expect(botId).toMatch(/^bot_/);
    }
  });

  it('seats array is sorted by seatIndex', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom());
    _setSupabaseClientFactory(() => supabase);

    const hostWs = createMockWs();
    registerClients(ROOM_CODE, 6, [
      { userId: HOST_ID, displayName: 'Host', isGuest: false, isHost: true, teamId: 1, ws: hostWs },
    ]);
    const clients = roomClients.get(ROOM_CODE);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    const startMsg = msgOfType(hostWs, 'lobby-starting');
    const indices = startMsg.seats.map((s) => s.seatIndex);
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]);
    }
  });

  it('all 6 seat indices (0-5) are present', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom());
    _setSupabaseClientFactory(() => supabase);

    const hostWs = createMockWs();
    registerClients(ROOM_CODE, 6, [
      { userId: HOST_ID, displayName: 'Host', isGuest: false, isHost: true, teamId: 1, ws: hostWs },
    ]);
    const clients = roomClients.get(ROOM_CODE);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    const startMsg = msgOfType(hostWs, 'lobby-starting');
    const seatIndices = new Set(startMsg.seats.map((s) => s.seatIndex));
    for (let i = 0; i < 6; i++) {
      expect(seatIndices.has(i)).toBe(true);
    }
  });

  it('human player is placed at seat 0 when on team 1', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom());
    _setSupabaseClientFactory(() => supabase);

    const hostWs = createMockWs();
    registerClients(ROOM_CODE, 6, [
      { userId: HOST_ID, displayName: 'Host', isGuest: false, isHost: true, teamId: 1, ws: hostWs },
    ]);
    const clients = roomClients.get(ROOM_CODE);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    const startMsg = msgOfType(hostWs, 'lobby-starting');
    const seat0 = startMsg.seats.find((s) => s.seatIndex === 0);
    expect(seat0).toBeDefined();
    expect(seat0.playerId).toBe(HOST_ID);
    expect(seat0.isBot).toBe(false);
  });

  it('human player on team 2 is placed at seat 1', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom());
    _setSupabaseClientFactory(() => supabase);

    const hostWs = createMockWs();
    registerClients(ROOM_CODE, 6, [
      { userId: HOST_ID,    displayName: 'Host', isGuest: false, isHost: true,  teamId: 1, ws: hostWs },
      { userId: PLAYER1_ID, displayName: 'P1',   isGuest: false, isHost: false, teamId: 2, ws: createMockWs() },
    ]);
    const clients = roomClients.get(ROOM_CODE);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    const startMsg = msgOfType(hostWs, 'lobby-starting');
    const seat1 = startMsg.seats.find((s) => s.seatIndex === 1);
    expect(seat1).toBeDefined();
    expect(seat1.playerId).toBe(PLAYER1_ID);
    expect(seat1.isBot).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D. Broadcast
// ---------------------------------------------------------------------------

describe('D. Broadcast', () => {
  it('broadcasts lobby-starting to ALL connected clients', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom());
    _setSupabaseClientFactory(() => supabase);

    const hostWs = createMockWs();
    const p1Ws   = createMockWs();

    registerClients(ROOM_CODE, 6, [
      { userId: HOST_ID,    displayName: 'Host', isGuest: false, isHost: true,  teamId: 1, ws: hostWs },
      { userId: PLAYER1_ID, displayName: 'P1',   isGuest: false, isHost: false, teamId: 2, ws: p1Ws   },
    ]);
    const clients = roomClients.get(ROOM_CODE);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    expect(msgOfType(hostWs, 'lobby-starting')).not.toBeNull();
    expect(msgOfType(p1Ws,   'lobby-starting')).not.toBeNull();
  });

  it('lobby-starting payload includes roomCode', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom());
    _setSupabaseClientFactory(() => supabase);

    const hostWs = createMockWs();
    registerClients(ROOM_CODE, 6, [
      { userId: HOST_ID, displayName: 'Host', isGuest: false, isHost: true, teamId: 1, ws: hostWs },
    ]);
    const clients = roomClients.get(ROOM_CODE);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    const msg = msgOfType(hostWs, 'lobby-starting');
    expect(msg.roomCode).toBe(ROOM_CODE);
  });

  it('non-host does NOT receive lobby-starting on error', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom());
    _setSupabaseClientFactory(() => supabase);

    const nonHostWs = createMockWs();
    registerClients(ROOM_CODE, 6, [
      { userId: PLAYER1_ID, displayName: 'P1', isGuest: false, isHost: false, teamId: 2, ws: nonHostWs },
    ]);
    const clients = roomClients.get(ROOM_CODE);

    await handleStartGame({ ws: nonHostWs, userId: PLAYER1_ID, isHost: false, roomCode: ROOM_CODE, clients });

    // Should get error but NOT lobby-starting
    expect(msgOfType(nonHostWs, 'error')).not.toBeNull();
    expect(msgOfType(nonHostWs, 'lobby-starting')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// E. Supabase
// ---------------------------------------------------------------------------

describe('E. Supabase status update', () => {
  it('updates room status to "starting"', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom());
    _setSupabaseClientFactory(() => supabase);

    const hostWs = createMockWs();
    registerClients(ROOM_CODE, 6, [
      { userId: HOST_ID, displayName: 'Host', isGuest: false, isHost: true, teamId: 1, ws: hostWs },
    ]);
    const clients = roomClients.get(ROOM_CODE);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    expect(supabase.from).toHaveBeenCalledWith('rooms');
    expect(supabase.update).toHaveBeenCalledWith({ status: 'starting' });
  });

  it('still broadcasts lobby-starting even when Supabase update fails', async () => {
    // First call (maybeSingle): return room data.
    // Subsequent calls (update): throw.
    const supabase = buildMockSupabase(makeWaitingRoom());
    supabase.update.mockReturnValue({
      eq: jest.fn().mockRejectedValue(new Error('DB write error')),
    });
    _setSupabaseClientFactory(() => supabase);

    const hostWs = createMockWs();
    registerClients(ROOM_CODE, 6, [
      { userId: HOST_ID, displayName: 'Host', isGuest: false, isHost: true, teamId: 1, ws: hostWs },
    ]);
    const clients = roomClients.get(ROOM_CODE);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    // Should still broadcast even though update threw
    expect(msgOfType(hostWs, 'lobby-starting')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F. Idempotency
// ---------------------------------------------------------------------------

describe('F. Idempotency guard', () => {
  it('rejects a second concurrent start_game call with ALREADY_STARTING', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom());
    _setSupabaseClientFactory(() => supabase);

    const hostWs = createMockWs();
    registerClients(ROOM_CODE, 6, [
      { userId: HOST_ID, displayName: 'Host', isGuest: false, isHost: true, teamId: 1, ws: hostWs },
    ]);
    const clients = roomClients.get(ROOM_CODE);

    // Manually inject the idempotency lock
    _startingRooms.add(ROOM_CODE);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    const errMsg = msgOfType(hostWs, 'error');
    expect(errMsg).not.toBeNull();
    expect(errMsg.code).toBe('ALREADY_STARTING');
  });

  it('clears the idempotency lock after completion', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom());
    _setSupabaseClientFactory(() => supabase);

    const hostWs = createMockWs();
    registerClients(ROOM_CODE, 6, [
      { userId: HOST_ID, displayName: 'Host', isGuest: false, isHost: true, teamId: 1, ws: hostWs },
    ]);
    const clients = roomClients.get(ROOM_CODE);

    expect(_startingRooms.has(ROOM_CODE)).toBe(false);
    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });
    expect(_startingRooms.has(ROOM_CODE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G. Edge cases
// ---------------------------------------------------------------------------

describe('G. Edge cases', () => {
  it('handles DB error in maybeSingle gracefully', async () => {
    const throwingSupabase = {
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            maybeSingle: jest.fn().mockRejectedValue(new Error('DB down')),
          }),
        }),
      }),
      auth: { getUser: jest.fn() },
      update: jest.fn(),
    };
    _setSupabaseClientFactory(() => throwingSupabase);

    const hostWs = createMockWs();
    registerClients(ROOM_CODE, 6, [
      { userId: HOST_ID, displayName: 'Host', isGuest: false, isHost: true, teamId: 1, ws: hostWs },
    ]);
    const clients = roomClients.get(ROOM_CODE);

    await expect(
      handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients })
    ).resolves.not.toThrow();

    // Should send an error to the host
    expect(msgOfType(hostWs, 'error')).not.toBeNull();
  });

  it('correctly assigns T1 humans to even seats and T2 to odd seats', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom());
    _setSupabaseClientFactory(() => supabase);

    const hostWs = createMockWs();
    const p1Ws   = createMockWs();
    const p2Ws   = createMockWs();

    registerClients(ROOM_CODE, 6, [
      { userId: HOST_ID,    displayName: 'Host', isGuest: false, isHost: true,  teamId: 1, ws: hostWs },
      { userId: PLAYER1_ID, displayName: 'P1',   isGuest: false, isHost: false, teamId: 2, ws: p1Ws   },
      { userId: 'p2',       displayName: 'P2',   isGuest: false, isHost: false, teamId: 1, ws: p2Ws   },
    ]);
    const clients = roomClients.get(ROOM_CODE);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    const startMsg = msgOfType(hostWs, 'lobby-starting');
    const humanSeats = startMsg.seats.filter((s) => !s.isBot);

    for (const seat of humanSeats) {
      if (seat.teamId === 1) {
        expect(seat.seatIndex % 2).toBe(0); // even
      } else {
        expect(seat.seatIndex % 2).toBe(1); // odd
      }
    }
  });

  it('works correctly with an 8-player room', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom({ player_count: 8 }));
    _setSupabaseClientFactory(() => supabase);

    const hostWs = createMockWs();
    registerClients(ROOM_CODE, 8, [
      { userId: HOST_ID, displayName: 'Host', isGuest: false, isHost: true, teamId: 1, ws: hostWs },
    ]);
    const clients = roomClients.get(ROOM_CODE);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    const startMsg = msgOfType(hostWs, 'lobby-starting');
    expect(startMsg).not.toBeNull();
    expect(startMsg.seats).toHaveLength(8);
    expect(startMsg.botsAdded).toHaveLength(7); // 8 - 1 host = 7 bots
  });
});
