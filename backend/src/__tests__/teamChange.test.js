'use strict';

/**
 * Unit tests for the handleChangeTeam WebSocket handler in roomSocketServer.js.
 *
 * Strategy:
 *   - Supabase is stubbed via _setSupabaseClientFactory so no live DB is needed.
 *   - The in-memory roomClients and roomMeta stores are reset via _resetRoomState()
 *     between tests.
 *   - WebSocket objects are minimal mocks (send + close + readyState).
 *   - handleChangeTeam and broadcast helpers are imported directly and called with
 *     fabricated ctx arguments, so no network port is ever bound.
 */

const {
  handleChangeTeam,
  autoAssignTeam,
  broadcast,
  getRoomPlayers,
  roomClients,
  roomMeta,
  _resetRoomState,
  _setSupabaseClientFactory,
} = require('../ws/roomSocketServer');

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockWs(readyState = 1 /* OPEN */) {
  return {
    readyState,
    send: jest.fn(),
    close: jest.fn(),
  };
}

function lastSent(mockWs) {
  const calls = mockWs.send.mock.calls;
  if (calls.length === 0) return null;
  return JSON.parse(calls[calls.length - 1][0]);
}

function allSent(mockWs) {
  return mockWs.send.mock.calls.map((c) => JSON.parse(c[0]));
}

// Seed a room with clients and metadata.
function seedRoom(roomCode, playerCount, entries) {
  if (!roomClients.has(roomCode)) {
    roomClients.set(roomCode, new Map());
  }
  if (!roomMeta.has(roomCode)) {
    roomMeta.set(roomCode, { playerCount });
  }
  const clients = roomClients.get(roomCode);
  for (const e of entries) {
    clients.set(e.userId, { ...e });
  }
  return clients;
}

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ROOM = 'TESTAB';
const PLAYER1 = 'player-1';
const PLAYER2 = 'player-2';
const PLAYER3 = 'player-3';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetRoomState();
  jest.clearAllMocks();
  // Null out the Supabase factory — roomSocketServer's fetchRoomMeta is only
  // called during connection setup, not in handleChangeTeam itself.
  _setSupabaseClientFactory(null);
});

// ── autoAssignTeam ──────────────────────────────────────────────────────────

describe('autoAssignTeam', () => {
  it('assigns Team 1 when room is empty', () => {
    const clients = new Map();
    expect(autoAssignTeam(clients, 6)).toBe(1);
  });

  it('assigns Team 2 when T1 already has a player and T2 is empty', () => {
    const clients = new Map([
      ['p1', { teamId: 1 }],
    ]);
    expect(autoAssignTeam(clients, 6)).toBe(2);
  });

  it('assigns Team 1 when T2 has more players', () => {
    const clients = new Map([
      ['p1', { teamId: 2 }],
      ['p2', { teamId: 2 }],
    ]);
    expect(autoAssignTeam(clients, 6)).toBe(1);
  });

  it('assigns Team 1 on a tie (T1 == T2 count)', () => {
    const clients = new Map([
      ['p1', { teamId: 1 }],
      ['p2', { teamId: 2 }],
    ]);
    expect(autoAssignTeam(clients, 6)).toBe(1);
  });

  it('returns Team 2 when T1 is at max capacity', () => {
    // 6-player game: max 3 per team.
    const clients = new Map([
      ['p1', { teamId: 1 }],
      ['p2', { teamId: 1 }],
      ['p3', { teamId: 1 }],
    ]);
    expect(autoAssignTeam(clients, 6)).toBe(2);
  });

  it('returns Team 1 when T2 is at max capacity', () => {
    const clients = new Map([
      ['p1', { teamId: 2 }],
      ['p2', { teamId: 2 }],
      ['p3', { teamId: 2 }],
    ]);
    expect(autoAssignTeam(clients, 6)).toBe(1);
  });
});

// ── handleChangeTeam — happy path ───────────────────────────────────────────

describe('handleChangeTeam — successful switch', () => {
  it('updates the player teamId in-memory', () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();

    const clients = seedRoom(ROOM, 6, [
      { userId: PLAYER1, ws: ws1, teamId: 1, displayName: 'Alice', isGuest: false, isHost: true },
      { userId: PLAYER2, ws: ws2, teamId: 2, displayName: 'Bob',   isGuest: true,  isHost: false },
    ]);

    handleChangeTeam(
      { ws: ws1, userId: PLAYER1, roomCode: ROOM, clients },
      { type: 'change_team', teamId: 2 },
    );

    expect(clients.get(PLAYER1).teamId).toBe(2);
  });

  it('broadcasts room_players to ALL clients (including sender)', () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();

    const clients = seedRoom(ROOM, 6, [
      { userId: PLAYER1, ws: ws1, teamId: 1, displayName: 'Alice', isGuest: false, isHost: true },
      { userId: PLAYER2, ws: ws2, teamId: 2, displayName: 'Bob',   isGuest: true,  isHost: false },
    ]);

    handleChangeTeam(
      { ws: ws1, userId: PLAYER1, roomCode: ROOM, clients },
      { type: 'change_team', teamId: 2 },
    );

    // Both sockets must have received room_players
    const msg1 = lastSent(ws1);
    const msg2 = lastSent(ws2);
    expect(msg1.type).toBe('room_players');
    expect(msg2.type).toBe('room_players');
    expect(Array.isArray(msg1.players)).toBe(true);
  });

  it('broadcast includes the updated teamId for the switching player', () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();

    const clients = seedRoom(ROOM, 6, [
      { userId: PLAYER1, ws: ws1, teamId: 1, displayName: 'Alice', isGuest: false, isHost: true },
      { userId: PLAYER2, ws: ws2, teamId: 2, displayName: 'Bob',   isGuest: true,  isHost: false },
    ]);

    handleChangeTeam(
      { ws: ws1, userId: PLAYER1, roomCode: ROOM, clients },
      { type: 'change_team', teamId: 2 },
    );

    const msg = lastSent(ws2);
    const p1 = msg.players.find((p) => p.userId === PLAYER1);
    expect(p1.teamId).toBe(2);
  });

  it('accepts teamId in a nested payload wrapper { payload: { teamId } }', () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();

    const clients = seedRoom(ROOM, 6, [
      { userId: PLAYER1, ws: ws1, teamId: 1, displayName: 'Alice', isGuest: false, isHost: true },
      { userId: PLAYER2, ws: ws2, teamId: 2, displayName: 'Bob',   isGuest: true,  isHost: false },
    ]);

    handleChangeTeam(
      { ws: ws1, userId: PLAYER1, roomCode: ROOM, clients },
      { type: 'change_team', payload: { teamId: 2 } },
    );

    expect(clients.get(PLAYER1).teamId).toBe(2);
  });
});

// ── handleChangeTeam — no-op when already on requested team ─────────────────

describe('handleChangeTeam — no-op same-team switch', () => {
  it('does not broadcast when player requests their current team', () => {
    const ws1 = createMockWs();

    const clients = seedRoom(ROOM, 6, [
      { userId: PLAYER1, ws: ws1, teamId: 1, displayName: 'Alice', isGuest: false, isHost: true },
    ]);

    handleChangeTeam(
      { ws: ws1, userId: PLAYER1, roomCode: ROOM, clients },
      { type: 'change_team', teamId: 1 }, // already on Team 1
    );

    // No broadcast and no error sent
    expect(ws1.send).not.toHaveBeenCalled();
  });
});

// ── handleChangeTeam — capacity enforcement ──────────────────────────────────

describe('handleChangeTeam — team full', () => {
  it('returns an error when the target team is already at max capacity', () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    const ws3 = createMockWs();
    const ws4 = createMockWs();

    // 6-player room: max 3 per team.
    // P1 is on T1 and wants to switch to T2, but T2 already has 3 players.
    const clients = seedRoom(ROOM, 6, [
      { userId: PLAYER1, ws: ws1, teamId: 1, displayName: 'A', isGuest: false, isHost: true },
      { userId: PLAYER2, ws: ws2, teamId: 2, displayName: 'B', isGuest: true,  isHost: false },
      { userId: PLAYER3, ws: ws3, teamId: 2, displayName: 'C', isGuest: true,  isHost: false },
      { userId: 'p4',   ws: ws4, teamId: 2, displayName: 'D', isGuest: true,  isHost: false },
    ]);

    handleChangeTeam(
      { ws: ws1, userId: PLAYER1, roomCode: ROOM, clients },
      { type: 'change_team', teamId: 2 },
    );

    const msg = lastSent(ws1);
    expect(msg.type).toBe('error');
    expect(msg.message).toMatch(/full/i);
  });

  it('does not change the teamId when the target team is full', () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    const ws3 = createMockWs();
    const ws4 = createMockWs();

    const clients = seedRoom(ROOM, 6, [
      { userId: PLAYER1, ws: ws1, teamId: 1, displayName: 'A', isGuest: false, isHost: true },
      { userId: PLAYER2, ws: ws2, teamId: 2, displayName: 'B', isGuest: true,  isHost: false },
      { userId: PLAYER3, ws: ws3, teamId: 2, displayName: 'C', isGuest: true,  isHost: false },
      { userId: 'p4',   ws: ws4, teamId: 2, displayName: 'D', isGuest: true,  isHost: false },
    ]);

    handleChangeTeam(
      { ws: ws1, userId: PLAYER1, roomCode: ROOM, clients },
      { type: 'change_team', teamId: 2 },
    );

    // Player stays on T1
    expect(clients.get(PLAYER1).teamId).toBe(1);
  });

  it('does not broadcast to other clients when rejected', () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    const ws3 = createMockWs();
    const ws4 = createMockWs();

    const clients = seedRoom(ROOM, 6, [
      { userId: PLAYER1, ws: ws1, teamId: 1, displayName: 'A', isGuest: false, isHost: true },
      { userId: PLAYER2, ws: ws2, teamId: 2, displayName: 'B', isGuest: true,  isHost: false },
      { userId: PLAYER3, ws: ws3, teamId: 2, displayName: 'C', isGuest: true,  isHost: false },
      { userId: 'p4',   ws: ws4, teamId: 2, displayName: 'D', isGuest: true,  isHost: false },
    ]);

    handleChangeTeam(
      { ws: ws1, userId: PLAYER1, roomCode: ROOM, clients },
      { type: 'change_team', teamId: 2 },
    );

    // Other players should NOT have received room_players
    expect(ws2.send).not.toHaveBeenCalled();
    expect(ws3.send).not.toHaveBeenCalled();
    expect(ws4.send).not.toHaveBeenCalled();
  });
});

// ── handleChangeTeam — input validation ─────────────────────────────────────

describe('handleChangeTeam — input validation', () => {
  it('returns an error for teamId = 0', () => {
    const ws = createMockWs();
    const clients = seedRoom(ROOM, 6, [
      { userId: PLAYER1, ws, teamId: 1, displayName: 'A', isGuest: false, isHost: true },
    ]);

    handleChangeTeam(
      { ws, userId: PLAYER1, roomCode: ROOM, clients },
      { type: 'change_team', teamId: 0 },
    );

    const msg = lastSent(ws);
    expect(msg.type).toBe('error');
    expect(msg.message).toMatch(/teamId must be 1 or 2/i);
  });

  it('returns an error for teamId = 3', () => {
    const ws = createMockWs();
    const clients = seedRoom(ROOM, 6, [
      { userId: PLAYER1, ws, teamId: 1, displayName: 'A', isGuest: false, isHost: true },
    ]);

    handleChangeTeam(
      { ws, userId: PLAYER1, roomCode: ROOM, clients },
      { type: 'change_team', teamId: 3 },
    );

    const msg = lastSent(ws);
    expect(msg.type).toBe('error');
  });

  it('returns an error when teamId is missing entirely', () => {
    const ws = createMockWs();
    const clients = seedRoom(ROOM, 6, [
      { userId: PLAYER1, ws, teamId: 1, displayName: 'A', isGuest: false, isHost: true },
    ]);

    handleChangeTeam(
      { ws, userId: PLAYER1, roomCode: ROOM, clients },
      { type: 'change_team' },
    );

    const msg = lastSent(ws);
    expect(msg.type).toBe('error');
  });
});

// ── handleChangeTeam — player not in room ────────────────────────────────────

describe('handleChangeTeam — player not found', () => {
  it('returns an error when userId is not in the clients map', () => {
    const ws = createMockWs();
    const clients = seedRoom(ROOM, 6, [
      { userId: PLAYER2, ws: createMockWs(), teamId: 1, displayName: 'B', isGuest: false, isHost: true },
    ]);

    handleChangeTeam(
      { ws, userId: 'ghost-player', roomCode: ROOM, clients },
      { type: 'change_team', teamId: 2 },
    );

    const msg = lastSent(ws);
    expect(msg.type).toBe('error');
    expect(msg.message).toMatch(/not found/i);
  });
});

// ── broadcast helper ─────────────────────────────────────────────────────────

describe('broadcast', () => {
  it('sends JSON to all OPEN clients in the room', () => {
    const ws1 = createMockWs(1); // OPEN
    const ws2 = createMockWs(1);

    seedRoom(ROOM, 6, [
      { userId: PLAYER1, ws: ws1, teamId: 1, displayName: 'A', isGuest: false, isHost: true },
      { userId: PLAYER2, ws: ws2, teamId: 2, displayName: 'B', isGuest: true,  isHost: false },
    ]);

    broadcast(ROOM, { type: 'ping' });

    expect(ws1.send).toHaveBeenCalledTimes(1);
    expect(ws2.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ws1.send.mock.calls[0][0])).toEqual({ type: 'ping' });
  });

  it('skips CLOSED sockets', () => {
    const wsOpen   = createMockWs(1); // OPEN
    const wsClosed = createMockWs(3); // CLOSED

    seedRoom(ROOM, 6, [
      { userId: PLAYER1, ws: wsOpen,   teamId: 1, displayName: 'A', isGuest: false, isHost: true },
      { userId: PLAYER2, ws: wsClosed, teamId: 2, displayName: 'B', isGuest: true,  isHost: false },
    ]);

    broadcast(ROOM, { type: 'ping' });

    expect(wsOpen.send).toHaveBeenCalledTimes(1);
    expect(wsClosed.send).not.toHaveBeenCalled();
  });

  it('does nothing for an unknown room code', () => {
    expect(() => broadcast('XXXXXX', { type: 'ping' })).not.toThrow();
  });
});

// ── getRoomPlayers ───────────────────────────────────────────────────────────

describe('getRoomPlayers', () => {
  it('returns serialisable player objects with teamId', () => {
    seedRoom(ROOM, 6, [
      { userId: PLAYER1, ws: createMockWs(), teamId: 1, displayName: 'Alice', isGuest: false, isHost: true },
      { userId: PLAYER2, ws: createMockWs(), teamId: 2, displayName: 'Bob',   isGuest: true,  isHost: false },
    ]);

    const players = getRoomPlayers(ROOM);

    expect(players).toHaveLength(2);
    expect(players.every((p) => typeof p.teamId === 'number')).toBe(true);
    expect(players.every((p) => !('ws' in p))).toBe(true);
  });

  it('returns an empty array for an unknown room', () => {
    expect(getRoomPlayers('XXXXXX')).toEqual([]);
  });
});
