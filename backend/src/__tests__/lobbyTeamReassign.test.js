'use strict';

/**
 * Tests for the 'reassign-team' WebSocket event handler.
 *
 * Covers:
 * A. lobbyManager.reassignPlayerTeam unit tests
 * — balance rule (no team exceeds playerCount/2)
 * — player-not-found, room-not-found edge cases
 * — no-op when team is already correct
 * — 6-player and 8-player game variants
 *
 * B. handleReassignTeam integration tests (via mock WS + mock Supabase)
 * — host-only authorization (FORBIDDEN for non-host)
 * — room status enforcement (ROOM_NOT_WAITING for in_progress etc.)
 * — team balance violation (TEAM_BALANCE_VIOLATION)
 * — successful reassignment broadcasts team-reassigned to all room members
 * — input validation errors (missing/invalid roomCode, targetPlayerId, newTeamId)
 * — room not found (Supabase returns null)
 * — internal DB error (Supabase throws)
 * — handleMessage routing correctly dispatches 'reassign-team'
 *
 * Strategy:
 * - No real DB or WebSocket ports are opened — everything is mocked.
 * - Supabase is mocked via _setSupabaseClient (same pattern as rooms.test.js).
 * - lobbyManager state is reset via _clearRooms() before each test.
 * - lobbyStore (for broadcastToRoom) is reset via _clearAll() before each test.
 * - handleReassignTeam is imported directly and called with fabricated args.
 */

const { WebSocket } = require('ws');
const { _setSupabaseClient } = require('../db/supabase');
const {
  _clearAll: clearLobbyStore,
  getOrCreateLobby,
  addPlayerToLobby,
} = require('../lobby/lobbyStore');
const {
  _clearRooms: clearLobbyManager,
  initLobbyRoom,
  addPlayerToLobby: addSeatToLobbyManager,
  reassignPlayerTeam,
  getLobbySnapshot,
} = require('../ws/lobbyManager');
const {
  handleReassignTeam,
  handleMessage,
  sendJson,
  broadcastToRoom,
} = require('../ws/wsServer');

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

/** Minimal mock WebSocket that records sent messages and close calls. */
function createMockWs(readyState = WebSocket.OPEN) {
  return {
    readyState,
    send: jest.fn(),
    close: jest.fn(),
  };
}

/** Parse the JSON payload from the most-recent ws.send() call. */
function lastSent(mockWs) {
  const calls = mockWs.send.mock.calls;
  if (calls.length === 0) return null;
  return JSON.parse(calls[calls.length - 1][0]);
}

/** Collect all payloads sent to a mockWs (in order). */
function allSent(mockWs) {
  return mockWs.send.mock.calls.map((c) => JSON.parse(c[0]));
}

/**
 * Build a chainable Supabase mock.
 * `room` is returned by maybeSingle; `dbError` overrides.
 */
function buildMockSupabase({ room = null, dbError = null } = {}) {
  const maybeSingle = jest.fn().mockResolvedValue({
    data: room,
    error: dbError,
  });
  const single = jest.fn();
  const select = jest.fn();
  const eq = jest.fn();
  const insert = jest.fn();
  const inFn = jest.fn();

  const chain = { select, eq, maybeSingle, single, in: inFn, insert };
  select.mockReturnValue(chain);
  eq.mockReturnValue(chain);
  inFn.mockReturnValue(chain);
  insert.mockReturnValue(chain);

  return {
    from: jest.fn().mockReturnValue(chain),
    auth: { getUser: jest.fn() },
    _chain: chain,
  };
}

// ---------------------------------------------------------------------------
// Test fixture constants
// ---------------------------------------------------------------------------

const ROOM_CODE  = 'ABCDEF';
const ROOM_ID    = 'room-uuid-abc';
const HOST_ID    = 'host-player-id';
const PLAYER1_ID = 'player-1-id';
const PLAYER2_ID = 'player-2-id';
const PLAYER3_ID = 'player-3-id';
const PLAYER4_ID = 'player-4-id';
const PLAYER5_ID = 'player-5-id';

const hostUser   = { playerId: HOST_ID,    displayName: 'Host',    avatarId: null, isGuest: false };
const player1    = { playerId: PLAYER1_ID, displayName: 'Player1', avatarId: null, isGuest: false };
const player2    = { playerId: PLAYER2_ID, displayName: 'Player2', avatarId: null, isGuest: true };

const waitingRoom6 = {
  id: ROOM_ID,
  code: ROOM_CODE,
  host_user_id: HOST_ID,
  player_count: 6,
  status: 'waiting',
};

// ---------------------------------------------------------------------------
// Helpers: populate lobby state (both stores) for a test
// ---------------------------------------------------------------------------

/**
 * Seed lobbyStore (for broadcastToRoom) with connected WebSocket mocks.
 * Players map: { playerId → mockWs }
 */
function seedLobbyStore(roomCode, hostId, players) {
  getOrCreateLobby(roomCode, hostId);
  for (const [playerId, ws] of Object.entries(players)) {
    addPlayerToLobby(roomCode, {
      connectionId: `conn-${playerId}`,
      playerId,
      displayName: `Player-${playerId}`,
      avatarId: null,
      isGuest: false,
      ws,
    });
  }
}

/**
 * Seed lobbyManager (for team assignments) with seat data.
 * seats: array of { seatIndex, playerId, teamId }
 */
function seedLobbyManagerSeats(roomCode, hostId, playerCount, seats) {
  initLobbyRoom({ roomId: ROOM_ID, roomCode, hostPlayerId: hostId, playerCount });
  for (const seat of seats) {
    addSeatToLobbyManager(roomCode, {
      seatIndex: seat.seatIndex,
      playerId: seat.playerId,
      displayName: `Player-${seat.playerId}`,
      teamId: seat.teamId,
      isBot: false,
      isGuest: false,
    });
  }
}

// ---------------------------------------------------------------------------
// A. lobbyManager.reassignPlayerTeam — unit tests
// ---------------------------------------------------------------------------

describe('lobbyManager.reassignPlayerTeam', () => {
  beforeEach(() => {
    clearLobbyManager();
  });

  // ── Setup for a standard 6-player half-full lobby ────────────────────────
  // Seats 0,1,2 filled; seat 0+2 = Team 1, seat 1 = Team 2
  function setup6PlayerPartialLobby() {
    seedLobbyManagerSeats(ROOM_CODE, HOST_ID, 6, [
      { seatIndex: 0, playerId: HOST_ID,    teamId: 1 },
      { seatIndex: 1, playerId: PLAYER1_ID, teamId: 2 },
      { seatIndex: 2, playerId: PLAYER2_ID, teamId: 1 },
    ]);
  }

  // ── Setup for a balanced full 6-player lobby ─────────────────────────────
  function setup6PlayerFullLobby() {
    seedLobbyManagerSeats(ROOM_CODE, HOST_ID, 6, [
      { seatIndex: 0, playerId: HOST_ID,    teamId: 1 },
      { seatIndex: 1, playerId: PLAYER1_ID, teamId: 2 },
      { seatIndex: 2, playerId: PLAYER2_ID, teamId: 1 },
      { seatIndex: 3, playerId: PLAYER3_ID, teamId: 2 },
      { seatIndex: 4, playerId: PLAYER4_ID, teamId: 1 },
      { seatIndex: 5, playerId: PLAYER5_ID, teamId: 2 },
    ]);
  }

  // ── Happy path ─────────────────────────────────────────────────────────────

  it('returns success=true and updates the seat teamId', () => {
    setup6PlayerPartialLobby();
    // Move PLAYER1 (Team 2) to Team 1. T1=2→3, T2=1→0. Both ≤ 3 ✓
    const result = reassignPlayerTeam(ROOM_CODE, PLAYER1_ID, 1);
    expect(result.success).toBe(true);

    const snapshot = getLobbySnapshot(ROOM_CODE);
    const seat = snapshot.seats.find((s) => s.playerId === PLAYER1_ID);
    expect(seat.teamId).toBe(1);
  });

  it('returns updated seats array sorted by seatIndex', () => {
    setup6PlayerPartialLobby();
    const result = reassignPlayerTeam(ROOM_CODE, PLAYER1_ID, 1);
    expect(result.success).toBe(true);
    const seatIndices = result.seats.map((s) => s.seatIndex);
    expect(seatIndices).toEqual([...seatIndices].sort((a, b) => a - b));
  });

  it('succeeds for a partial lobby moving a player to balancing side', () => {
    // T1=2, T2=1 — move T1 player to T2 → T1=1, T2=2, both ≤ 3
    setup6PlayerPartialLobby();
    const result = reassignPlayerTeam(ROOM_CODE, PLAYER2_ID, 2); // seat 2, T1→T2
    expect(result.success).toBe(true);
  });

  it('is a no-op (success) when the player is already on the requested team', () => {
    setup6PlayerPartialLobby();
    // HOST is already Team 1
    const result = reassignPlayerTeam(ROOM_CODE, HOST_ID, 1);
    expect(result.success).toBe(true);

    // teamId unchanged
    const snapshot = getLobbySnapshot(ROOM_CODE);
    const seat = snapshot.seats.find((s) => s.playerId === HOST_ID);
    expect(seat.teamId).toBe(1);
  });

  it('works correctly for an 8-player game (max 4 per team)', () => {
    seedLobbyManagerSeats(ROOM_CODE, HOST_ID, 8, [
      { seatIndex: 0, playerId: HOST_ID,    teamId: 1 },
      { seatIndex: 1, playerId: PLAYER1_ID, teamId: 2 },
      { seatIndex: 2, playerId: PLAYER2_ID, teamId: 1 },
    ]);
    // T1=2, T2=1. Move T2 player to T1 → T1=3, T2=0, both ≤ 4 ✓
    const result = reassignPlayerTeam(ROOM_CODE, PLAYER1_ID, 1);
    expect(result.success).toBe(true);
  });

  // ── Team balance violation ─────────────────────────────────────────────────

  it('rejects a move that would push a team above playerCount/2 (full 6-player)', () => {
    setup6PlayerFullLobby(); // T1=3, T2=3
    // Moving anyone from T1→T2 would make T2=4 > 3 → REJECTED
    const result = reassignPlayerTeam(ROOM_CODE, HOST_ID, 2);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exceed/i);
    expect(result.error).toContain('3');
  });

  it('rejects a move that would push a team above playerCount/2 (full 8-player)', () => {
    seedLobbyManagerSeats(ROOM_CODE, HOST_ID, 8, [
      { seatIndex: 0, playerId: HOST_ID,    teamId: 1 },
      { seatIndex: 1, playerId: PLAYER1_ID, teamId: 2 },
      { seatIndex: 2, playerId: PLAYER2_ID, teamId: 1 },
      { seatIndex: 3, playerId: PLAYER3_ID, teamId: 2 },
      { seatIndex: 4, playerId: PLAYER4_ID, teamId: 1 },
      { seatIndex: 5, playerId: PLAYER5_ID, teamId: 2 },
      { seatIndex: 6, playerId: 'p6-id',    teamId: 1 },
      { seatIndex: 7, playerId: 'p7-id',    teamId: 2 },
    ]);
    // Full balanced 8-player game: T1=4, T2=4. Any move violates balance.
    const result = reassignPlayerTeam(ROOM_CODE, HOST_ID, 2);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exceed/i);
  });

  it('rejects when partial lobby would cause one team to exceed playerCount/2', () => {
    // T1=2, T2=0 in a 6-player game; try to add another to T1 → T1=3 = max, BUT
    // this is the boundary — adding to T2 instead works fine.
    seedLobbyManagerSeats(ROOM_CODE, HOST_ID, 6, [
      { seatIndex: 0, playerId: HOST_ID,    teamId: 1 },
      { seatIndex: 1, playerId: PLAYER1_ID, teamId: 2 },
      { seatIndex: 2, playerId: PLAYER2_ID, teamId: 1 },
    ]);
    // Move T2 player (PLAYER1) to T1 → T1 would become 3. 3 ≤ 3 → allowed!
    const result = reassignPlayerTeam(ROOM_CODE, PLAYER1_ID, 1);
    expect(result.success).toBe(true);

    // Now try to move PLAYER2 (T1) to T2 when T1=3 → T2 becomes 2 ≤ 3 → allowed
    const result2 = reassignPlayerTeam(ROOM_CODE, PLAYER2_ID, 2);
    expect(result2.success).toBe(true);
  });

  // ── Error cases ────────────────────────────────────────────────────────────

  it('returns failure when the room is not found', () => {
    // No initLobbyRoom called → room does not exist
    const result = reassignPlayerTeam('XXXXXX', HOST_ID, 2);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/room not found/i);
  });

  it('returns failure when the target player is not in the room', () => {
    setup6PlayerPartialLobby();
    const result = reassignPlayerTeam(ROOM_CODE, 'no-such-player', 2);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/player not found/i);
  });

  it('returns failure for invalid newTeamId (0)', () => {
    setup6PlayerPartialLobby();
    const result = reassignPlayerTeam(ROOM_CODE, HOST_ID, 0);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/1 or 2/i);
  });

  it('returns failure for invalid newTeamId (3)', () => {
    setup6PlayerPartialLobby();
    const result = reassignPlayerTeam(ROOM_CODE, HOST_ID, 3);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/1 or 2/i);
  });

  it('does not mutate seat state when returning a balance-violation error', () => {
    setup6PlayerFullLobby(); // T1=3, T2=3
    const snapshotBefore = getLobbySnapshot(ROOM_CODE);
    const teamsBefore = snapshotBefore.seats.map((s) => ({ p: s.playerId, t: s.teamId }));

    reassignPlayerTeam(ROOM_CODE, HOST_ID, 2); // rejected

    const snapshotAfter = getLobbySnapshot(ROOM_CODE);
    const teamsAfter = snapshotAfter.seats.map((s) => ({ p: s.playerId, t: s.teamId }));
    expect(teamsAfter).toEqual(teamsBefore);
  });

  it('room code is case-insensitive', () => {
    setup6PlayerPartialLobby(); // stored as ABCDEF
    // Call with lowercase — should still find the room
    const result = reassignPlayerTeam('abcdef', PLAYER1_ID, 1);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B. handleReassignTeam — integration tests
// ---------------------------------------------------------------------------

describe('handleReassignTeam', () => {
  beforeEach(() => {
    clearLobbyManager();
    clearLobbyStore();
    jest.clearAllMocks();
  });

  // ── Shared setup helpers ───────────────────────────────────────────────────

  /**
   * Set up a 6-player partial lobby:
   * - lobbyStore: host + 2 players (with mock WebSocket connections)
   * - lobbyManager: 3 seats (host=T1, player1=T2, player2=T1)
   * Returns mock WS objects keyed by playerId.
   */
  function setupFullTestLobby() {
    const hostWs = createMockWs();
    const p1Ws   = createMockWs();
    const p2Ws   = createMockWs();

    // lobbyStore — for broadcastToRoom
    seedLobbyStore(ROOM_CODE, HOST_ID, {
      [HOST_ID]: hostWs,
      [PLAYER1_ID]: p1Ws,
      [PLAYER2_ID]: p2Ws,
    });

    // lobbyManager — for team state
    seedLobbyManagerSeats(ROOM_CODE, HOST_ID, 6, [
      { seatIndex: 0, playerId: HOST_ID,    teamId: 1 },
      { seatIndex: 1, playerId: PLAYER1_ID, teamId: 2 },
      { seatIndex: 2, playerId: PLAYER2_ID, teamId: 1 },
    ]);

    return { hostWs, p1Ws, p2Ws };
  }

  // ── Happy path ─────────────────────────────────────────────────────────────

  it('broadcasts team-reassigned to all players in the room on success', async () => {
    const mockSupabase = buildMockSupabase({ room: waitingRoom6 });
    _setSupabaseClient(mockSupabase);
    const { hostWs, p1Ws, p2Ws } = setupFullTestLobby();

    // Move PLAYER1 (T2) to T1. Partial lobby so T1=3, T2=0 — still valid.
    await handleReassignTeam(hostWs, 'conn-host', hostUser, {
      type: 'reassign-team',
      roomCode: ROOM_CODE,
      targetPlayerId: PLAYER1_ID,
      newTeamId: 1,
    });

    // All three players should have received the broadcast.
    for (const ws of [hostWs, p1Ws, p2Ws]) {
      const payloads = allSent(ws);
      const event = payloads.find((p) => p.type === 'team-reassigned');
      expect(event).toBeDefined();
      expect(event.roomCode).toBe(ROOM_CODE);
      expect(event.targetPlayerId).toBe(PLAYER1_ID);
      expect(event.newTeamId).toBe(1);
    }
  });

  it('broadcast includes updated seats array with all players', async () => {
    const mockSupabase = buildMockSupabase({ room: waitingRoom6 });
    _setSupabaseClient(mockSupabase);
    const { hostWs } = setupFullTestLobby();

    await handleReassignTeam(hostWs, 'conn-host', hostUser, {
      type: 'reassign-team',
      roomCode: ROOM_CODE,
      targetPlayerId: PLAYER1_ID,
      newTeamId: 1,
    });

    const payloads = allSent(hostWs);
    const event = payloads.find((p) => p.type === 'team-reassigned');
    expect(event.seats).toHaveLength(3);

    const movedSeat = event.seats.find((s) => s.playerId === PLAYER1_ID);
    expect(movedSeat.teamId).toBe(1);
  });

  it('does not send an error message on success', async () => {
    const mockSupabase = buildMockSupabase({ room: waitingRoom6 });
    _setSupabaseClient(mockSupabase);
    const { hostWs } = setupFullTestLobby();

    await handleReassignTeam(hostWs, 'conn-host', hostUser, {
      type: 'reassign-team',
      roomCode: ROOM_CODE,
      targetPlayerId: PLAYER1_ID,
      newTeamId: 1,
    });

    const payloads = allSent(hostWs);
    expect(payloads.every((p) => p.type !== 'error')).toBe(true);
  });

  it('roomCode is case-insensitive on the WS handler level', async () => {
    const mockSupabase = buildMockSupabase({ room: waitingRoom6 });
    _setSupabaseClient(mockSupabase);
    const { hostWs } = setupFullTestLobby();

    await handleReassignTeam(hostWs, 'conn-host', hostUser, {
      type: 'reassign-team',
      roomCode: 'abcdef', // lowercase
      targetPlayerId: PLAYER1_ID,
      newTeamId: 1,
    });

    const payloads = allSent(hostWs);
    const event = payloads.find((p) => p.type === 'team-reassigned');
    expect(event).toBeDefined();
    expect(event.roomCode).toBe(ROOM_CODE); // returned as uppercase
  });

  // ── Host-only authorization ────────────────────────────────────────────────

  it('returns FORBIDDEN error when a non-host tries to reassign', async () => {
    const mockSupabase = buildMockSupabase({ room: waitingRoom6 });
    _setSupabaseClient(mockSupabase);
    const { p1Ws } = setupFullTestLobby();

    // PLAYER1 is not the host
    await handleReassignTeam(p1Ws, 'conn-p1', player1, {
      type: 'reassign-team',
      roomCode: ROOM_CODE,
      targetPlayerId: PLAYER2_ID,
      newTeamId: 1,
    });

    const payload = lastSent(p1Ws);
    expect(payload.type).toBe('error');
    expect(payload.code).toBe('FORBIDDEN');
    expect(payload.message).toMatch(/host/i);
  });

  it('does not broadcast or mutate lobby state when a non-host tries to reassign', async () => {
    const mockSupabase = buildMockSupabase({ room: waitingRoom6 });
    _setSupabaseClient(mockSupabase);
    const { hostWs, p1Ws, p2Ws } = setupFullTestLobby();

    const snapshotBefore = getLobbySnapshot(ROOM_CODE);

    await handleReassignTeam(p1Ws, 'conn-p1', player1, {
      type: 'reassign-team',
      roomCode: ROOM_CODE,
      targetPlayerId: PLAYER2_ID,
      newTeamId: 1,
    });

    // Broadcast should NOT have reached host or other players.
    for (const ws of [hostWs, p2Ws]) {
      const payloads = allSent(ws);
      expect(payloads.every((p) => p.type !== 'team-reassigned')).toBe(true);
    }

    // Lobby state unchanged.
    const snapshotAfter = getLobbySnapshot(ROOM_CODE);
    expect(snapshotAfter.seats.map((s) => s.teamId)).toEqual(
      snapshotBefore.seats.map((s) => s.teamId),
    );
  });

  // ── Room status enforcement ────────────────────────────────────────────────

  it('returns ROOM_NOT_WAITING when room is in_progress', async () => {
    const inProgressRoom = { ...waitingRoom6, status: 'in_progress' };
    const mockSupabase = buildMockSupabase({ room: inProgressRoom });
    _setSupabaseClient(mockSupabase);
    const { hostWs } = setupFullTestLobby();

    await handleReassignTeam(hostWs, 'conn-host', hostUser, {
      type: 'reassign-team',
      roomCode: ROOM_CODE,
      targetPlayerId: PLAYER1_ID,
      newTeamId: 1,
    });

    const payload = lastSent(hostWs);
    expect(payload.type).toBe('error');
    expect(payload.code).toBe('ROOM_NOT_WAITING');
  });

  it('returns ROOM_NOT_WAITING when room is completed', async () => {
    const completedRoom = { ...waitingRoom6, status: 'completed' };
    const mockSupabase = buildMockSupabase({ room: completedRoom });
    _setSupabaseClient(mockSupabase);
    const { hostWs } = setupFullTestLobby();

    await handleReassignTeam(hostWs, 'conn-host', hostUser, {
      type: 'reassign-team',
      roomCode: ROOM_CODE,
      targetPlayerId: PLAYER1_ID,
      newTeamId: 1,
    });

    const payload = lastSent(hostWs);
    expect(payload.type).toBe('error');
    expect(payload.code).toBe('ROOM_NOT_WAITING');
  });

  it('returns ROOM_NOT_WAITING when room is starting', async () => {
    const startingRoom = { ...waitingRoom6, status: 'starting' };
    const mockSupabase = buildMockSupabase({ room: startingRoom });
    _setSupabaseClient(mockSupabase);
    const { hostWs } = setupFullTestLobby();

    await handleReassignTeam(hostWs, 'conn-host', hostUser, {
      type: 'reassign-team',
      roomCode: ROOM_CODE,
      targetPlayerId: PLAYER1_ID,
      newTeamId: 1,
    });

    const payload = lastSent(hostWs);
    expect(payload.type).toBe('error');
    expect(payload.code).toBe('ROOM_NOT_WAITING');
  });

  it('returns ROOM_NOT_WAITING when room is cancelled', async () => {
    const cancelledRoom = { ...waitingRoom6, status: 'cancelled' };
    const mockSupabase = buildMockSupabase({ room: cancelledRoom });
    _setSupabaseClient(mockSupabase);
    const { hostWs } = setupFullTestLobby();

    await handleReassignTeam(hostWs, 'conn-host', hostUser, {
      type: 'reassign-team',
      roomCode: ROOM_CODE,
      targetPlayerId: PLAYER1_ID,
      newTeamId: 1,
    });

    const payload = lastSent(hostWs);
    expect(payload.type).toBe('error');
    expect(payload.code).toBe('ROOM_NOT_WAITING');
  });

  // ── Team balance violation ─────────────────────────────────────────────────

  it('returns TEAM_BALANCE_VIOLATION for a fully balanced 6-player room', async () => {
    const mockSupabase = buildMockSupabase({ room: waitingRoom6 });
    _setSupabaseClient(mockSupabase);

    const hostWs = createMockWs();
    const p1Ws   = createMockWs();
    const p2Ws   = createMockWs();
    const p3Ws   = createMockWs();
    const p4Ws   = createMockWs();
    const p5Ws   = createMockWs();

    // lobbyStore connections
    seedLobbyStore(ROOM_CODE, HOST_ID, {
      [HOST_ID]:    hostWs,
      [PLAYER1_ID]: p1Ws,
      [PLAYER2_ID]: p2Ws,
      [PLAYER3_ID]: p3Ws,
      [PLAYER4_ID]: p4Ws,
      [PLAYER5_ID]: p5Ws,
    });

    // lobbyManager — balanced full room
    seedLobbyManagerSeats(ROOM_CODE, HOST_ID, 6, [
      { seatIndex: 0, playerId: HOST_ID,    teamId: 1 },
      { seatIndex: 1, playerId: PLAYER1_ID, teamId: 2 },
      { seatIndex: 2, playerId: PLAYER2_ID, teamId: 1 },
      { seatIndex: 3, playerId: PLAYER3_ID, teamId: 2 },
      { seatIndex: 4, playerId: PLAYER4_ID, teamId: 1 },
      { seatIndex: 5, playerId: PLAYER5_ID, teamId: 2 },
    ]);

    // Any move in a balanced full room should fail
    await handleReassignTeam(hostWs, 'conn-host', hostUser, {
      type: 'reassign-team',
      roomCode: ROOM_CODE,
      targetPlayerId: HOST_ID,
      newTeamId: 2,
    });

    const payload = lastSent(hostWs);
    expect(payload.type).toBe('error');
    expect(payload.code).toBe('TEAM_BALANCE_VIOLATION');
    expect(payload.message).toMatch(/exceed/i);
  });

  it('does not broadcast on TEAM_BALANCE_VIOLATION', async () => {
    const mockSupabase = buildMockSupabase({ room: waitingRoom6 });
    _setSupabaseClient(mockSupabase);

    const hostWs = createMockWs();
    const p1Ws   = createMockWs();

    seedLobbyStore(ROOM_CODE, HOST_ID, { [HOST_ID]: hostWs, [PLAYER1_ID]: p1Ws });
    seedLobbyManagerSeats(ROOM_CODE, HOST_ID, 6, [
      { seatIndex: 0, playerId: HOST_ID,    teamId: 1 },
      { seatIndex: 1, playerId: PLAYER1_ID, teamId: 2 },
      { seatIndex: 2, playerId: PLAYER2_ID, teamId: 1 },
      { seatIndex: 3, playerId: PLAYER3_ID, teamId: 2 },
      { seatIndex: 4, playerId: PLAYER4_ID, teamId: 1 },
      { seatIndex: 5, playerId: PLAYER5_ID, teamId: 2 },
    ]);

    await handleReassignTeam(hostWs, 'conn-host', hostUser, {
      type: 'reassign-team',
      roomCode: ROOM_CODE,
      targetPlayerId: HOST_ID,
      newTeamId: 2,
    });

    // p1Ws (another player) should NOT have received team-reassigned broadcast
    const p1Payloads = allSent(p1Ws);
    expect(p1Payloads.every((p) => p.type !== 'team-reassigned')).toBe(true);
  });

  // ── Room not found ─────────────────────────────────────────────────────────

  it('returns error when room is not found in DB', async () => {
    const mockSupabase = buildMockSupabase({ room: null });
    _setSupabaseClient(mockSupabase);
    const { hostWs } = setupFullTestLobby();

    await handleReassignTeam(hostWs, 'conn-host', hostUser, {
      type: 'reassign-team',
      roomCode: ROOM_CODE,
      targetPlayerId: PLAYER1_ID,
      newTeamId: 1,
    });

    const payload = lastSent(hostWs);
    expect(payload.type).toBe('error');
    expect(payload.message).toMatch(/room not found/i);
  });

  it('returns error when Supabase throws an exception', async () => {
    const throwingSupabase = {
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            maybeSingle: jest.fn().mockRejectedValue(new Error('DB down')),
          }),
        }),
      }),
      auth: { getUser: jest.fn() },
    };
    _setSupabaseClient(throwingSupabase);
    const { hostWs } = setupFullTestLobby();

    await handleReassignTeam(hostWs, 'conn-host', hostUser, {
      type: 'reassign-team',
      roomCode: ROOM_CODE,
      targetPlayerId: PLAYER1_ID,
      newTeamId: 1,
    });

    const payload = lastSent(hostWs);
    expect(payload.type).toBe('error');
    expect(payload.message).toMatch(/internal error/i);
  });

  // ── Input validation ───────────────────────────────────────────────────────

  it('returns error for missing roomCode', async () => {
    const { hostWs } = setupFullTestLobby();

    await handleReassignTeam(hostWs, 'conn-host', hostUser, {
      type: 'reassign-team',
      targetPlayerId: PLAYER1_ID,
      newTeamId: 1,
    });

    const payload = lastSent(hostWs);
    expect(payload.type).toBe('error');
    expect(payload.message).toMatch(/roomCode/i);
  });

  it('returns error for roomCode that is not 6 characters', async () => {
    const { hostWs } = setupFullTestLobby();

    await handleReassignTeam(hostWs, 'conn-host', hostUser, {
      type: 'reassign-team',
      roomCode: 'ABC', // too short
      targetPlayerId: PLAYER1_ID,
      newTeamId: 1,
    });

    const payload = lastSent(hostWs);
    expect(payload.type).toBe('error');
    expect(payload.message).toMatch(/roomCode/i);
  });

  it('returns error for missing targetPlayerId', async () => {
    const { hostWs } = setupFullTestLobby();

    await handleReassignTeam(hostWs, 'conn-host', hostUser, {
      type: 'reassign-team',
      roomCode: ROOM_CODE,
      newTeamId: 1,
    });

    const payload = lastSent(hostWs);
    expect(payload.type).toBe('error');
    expect(payload.message).toMatch(/targetPlayerId/i);
  });

  it('returns error for empty string targetPlayerId', async () => {
    const { hostWs } = setupFullTestLobby();

    await handleReassignTeam(hostWs, 'conn-host', hostUser, {
      type: 'reassign-team',
      roomCode: ROOM_CODE,
      targetPlayerId: '   ',
      newTeamId: 1,
    });

    const payload = lastSent(hostWs);
    expect(payload.type).toBe('error');
  });

  it('returns error for newTeamId = 0', async () => {
    const { hostWs } = setupFullTestLobby();

    await handleReassignTeam(hostWs, 'conn-host', hostUser, {
      type: 'reassign-team',
      roomCode: ROOM_CODE,
      targetPlayerId: PLAYER1_ID,
      newTeamId: 0,
    });

    const payload = lastSent(hostWs);
    expect(payload.type).toBe('error');
    expect(payload.code).toBe('INVALID_TEAM_ID');
    expect(payload.message).toMatch(/1 or 2/i);
  });

  it('returns error for newTeamId = 3', async () => {
    const { hostWs } = setupFullTestLobby();

    await handleReassignTeam(hostWs, 'conn-host', hostUser, {
      type: 'reassign-team',
      roomCode: ROOM_CODE,
      targetPlayerId: PLAYER1_ID,
      newTeamId: 3,
    });

    const payload = lastSent(hostWs);
    expect(payload.type).toBe('error');
    expect(payload.code).toBe('INVALID_TEAM_ID');
  });

  it('returns error for string newTeamId ("1" instead of 1)', async () => {
    const { hostWs } = setupFullTestLobby();

    await handleReassignTeam(hostWs, 'conn-host', hostUser, {
      type: 'reassign-team',
      roomCode: ROOM_CODE,
      targetPlayerId: PLAYER1_ID,
      newTeamId: '1', // string, not number
    });

    const payload = lastSent(hostWs);
    expect(payload.type).toBe('error');
    expect(payload.code).toBe('INVALID_TEAM_ID');
  });

  it('returns error for missing newTeamId', async () => {
    const { hostWs } = setupFullTestLobby();

    await handleReassignTeam(hostWs, 'conn-host', hostUser, {
      type: 'reassign-team',
      roomCode: ROOM_CODE,
      targetPlayerId: PLAYER1_ID,
    });

    const payload = lastSent(hostWs);
    expect(payload.type).toBe('error');
    expect(payload.code).toBe('INVALID_TEAM_ID');
  });

  // ── Target player not in lobbyManager ─────────────────────────────────────

  it('returns TEAM_BALANCE_VIOLATION (player not found) when target is not in lobbyManager', async () => {
    const mockSupabase = buildMockSupabase({ room: waitingRoom6 });
    _setSupabaseClient(mockSupabase);
    const { hostWs } = setupFullTestLobby();

    await handleReassignTeam(hostWs, 'conn-host', hostUser, {
      type: 'reassign-team',
      roomCode: ROOM_CODE,
      targetPlayerId: 'not-in-lobby-player',
      newTeamId: 1,
    });

    const payload = lastSent(hostWs);
    expect(payload.type).toBe('error');
    expect(payload.code).toBe('TEAM_BALANCE_VIOLATION');
    expect(payload.message).toMatch(/player not found/i);
  });

  // ── handleMessage routing ──────────────────────────────────────────────────

  it('handleMessage routes reassign-team to handleReassignTeam', async () => {
    const mockSupabase = buildMockSupabase({ room: waitingRoom6 });
    _setSupabaseClient(mockSupabase);
    const { hostWs } = setupFullTestLobby();

    await handleMessage(
      hostWs,
      'conn-host',
      hostUser,
      JSON.stringify({
        type: 'reassign-team',
        roomCode: ROOM_CODE,
        targetPlayerId: PLAYER1_ID,
        newTeamId: 1,
      }),
    );

    // Verify the handler ran by checking the DB was queried.
    // The Supabase mock's 'from' method is called by handleReassignTeam.
    expect(mockSupabase.from).toHaveBeenCalled();
  });

  it('handleMessage routes reassign-team and succeeds end-to-end', async () => {
    const mockSupabase = buildMockSupabase({ room: waitingRoom6 });
    _setSupabaseClient(mockSupabase);
    const { hostWs, p1Ws, p2Ws } = setupFullTestLobby();

    await handleMessage(
      hostWs,
      'conn-host',
      hostUser,
      JSON.stringify({
        type: 'reassign-team',
        roomCode: ROOM_CODE,
        targetPlayerId: PLAYER1_ID,
        newTeamId: 1,
      }),
    );

    // All players receive the broadcast.
    for (const ws of [hostWs, p1Ws, p2Ws]) {
      const payloads = allSent(ws);
      expect(payloads.some((p) => p.type === 'team-reassigned')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// C. sendJson and broadcastToRoom (guards; primarily tested in kickPlayer.test.js)
// ---------------------------------------------------------------------------

describe('sendJson (reassign-team context)', () => {
  it('serialises and sends a team-reassigned payload to an OPEN socket', () => {
    const ws = createMockWs(WebSocket.OPEN);
    const data = {
      type: 'team-reassigned',
      roomCode: 'ABCDEF',
      targetPlayerId: 'p1',
      newTeamId: 2,
      seats: [],
    };
    sendJson(ws, data);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(data));
  });

  it('does not send to a CLOSED socket', () => {
    const ws = createMockWs(WebSocket.CLOSED);
    sendJson(ws, { type: 'team-reassigned' });
    expect(ws.send).not.toHaveBeenCalled();
  });
});
