'use strict';

/**
 * Tests for the kick-player WebSocket handler (handleKickPlayer).
 *
 * Strategy:
 *   - All Supabase calls are mocked via _setSupabaseClient.
 *   - WebSocket objects are plain mock objects with a `send` spy and `close`
 *     spy plus a fixed `readyState`.
 *   - The in-memory lobby store is reset via _clearAll() between tests.
 *   - handleKickPlayer is imported directly and called with fabricated args,
 *     bypassing the actual WebSocket server so no port is ever bound.
 */

const { WebSocket } = require('ws');
const { _setSupabaseClient } = require('../db/supabase');
const {
  _clearAll,
  getOrCreateLobby,
  addPlayerToLobby,
  getLobby,
  getLobbyPlayers,
} = require('../lobby/lobbyStore');
const { handleKickPlayer, sendJson, broadcastToRoom } = require('../ws/wsServer');

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock WebSocket that tracks sent messages and close calls.
 */
function createMockWs(readyState = WebSocket.OPEN) {
  return {
    readyState,
    send: jest.fn(),
    close: jest.fn(),
  };
}

/**
 * Parse the JSON payload from the most-recent ws.send() call.
 */
function lastSentPayload(mockWs) {
  const calls = mockWs.send.mock.calls;
  if (calls.length === 0) return null;
  return JSON.parse(calls[calls.length - 1][0]);
}

/**
 * Collect all payloads sent to a mockWs.
 */
function allSentPayloads(mockWs) {
  return mockWs.send.mock.calls.map((c) => JSON.parse(c[0]));
}

/**
 * Build a chainable Supabase mock (mirrors the factory in rooms.test.js).
 */
function buildMockSupabase({ room = null, dbError = null } = {}) {
  const maybeSingle = jest.fn().mockResolvedValue({ data: room, error: dbError });
  const single = jest.fn().mockResolvedValue({ data: room, error: dbError });
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
// Test-fixture constants
// ---------------------------------------------------------------------------

const HOST_ID = 'host-player-id';
const PLAYER_ID = 'guest-player-id';
const ROOM_CODE = 'ABCDEF';

const waitingRoom = {
  id: 'room-uuid',
  code: ROOM_CODE,
  host_user_id: HOST_ID,
  status: 'waiting',
};

const hostUser = { playerId: HOST_ID, displayName: 'Host User', avatarId: 'avatar-1', isGuest: false };
const guestUser = { playerId: PLAYER_ID, displayName: 'Guest Player', avatarId: 'avatar-2', isGuest: true };

// ---------------------------------------------------------------------------
// Helpers: set up a populated lobby for a test
// ---------------------------------------------------------------------------

function setupLobbyWithTwoPlayers(hostWs, guestWs) {
  getOrCreateLobby(ROOM_CODE, HOST_ID);
  addPlayerToLobby(ROOM_CODE, {
    connectionId: 'conn-host',
    playerId: HOST_ID,
    displayName: hostUser.displayName,
    avatarId: hostUser.avatarId,
    isGuest: false,
    ws: hostWs,
  });
  addPlayerToLobby(ROOM_CODE, {
    connectionId: 'conn-guest',
    playerId: PLAYER_ID,
    displayName: guestUser.displayName,
    avatarId: guestUser.avatarId,
    isGuest: true,
    ws: guestWs,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleKickPlayer', () => {
  beforeEach(() => {
    // Reset the in-memory lobby before every test.
    _clearAll();
    jest.clearAllMocks();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  describe('successful kick', () => {
    it('sends you-were-kicked to the target player', async () => {
      const mockSupabase = buildMockSupabase({ room: waitingRoom });
      _setSupabaseClient(mockSupabase);

      const hostWs = createMockWs();
      const guestWs = createMockWs();
      setupLobbyWithTwoPlayers(hostWs, guestWs);

      await handleKickPlayer(hostWs, 'conn-host', hostUser, {
        type: 'kick-player',
        roomCode: ROOM_CODE,
        targetPlayerId: PLAYER_ID,
      });

      const payloads = allSentPayloads(guestWs);
      expect(payloads.some((p) => p.type === 'you-were-kicked')).toBe(true);
      const kickPayload = payloads.find((p) => p.type === 'you-were-kicked');
      expect(kickPayload.roomCode).toBe(ROOM_CODE);
    });

    it('removes the kicked player from lobby state', async () => {
      const mockSupabase = buildMockSupabase({ room: waitingRoom });
      _setSupabaseClient(mockSupabase);

      const hostWs = createMockWs();
      const guestWs = createMockWs();
      setupLobbyWithTwoPlayers(hostWs, guestWs);

      await handleKickPlayer(hostWs, 'conn-host', hostUser, {
        type: 'kick-player',
        roomCode: ROOM_CODE,
        targetPlayerId: PLAYER_ID,
      });

      const lobby = getLobby(ROOM_CODE);
      // Host remains; guest was removed.
      expect(lobby).not.toBeNull();
      expect(lobby.players.has(HOST_ID)).toBe(true);
      expect(lobby.players.has(PLAYER_ID)).toBe(false);
    });

    it('broadcasts player-kicked to all remaining room participants', async () => {
      const mockSupabase = buildMockSupabase({ room: waitingRoom });
      _setSupabaseClient(mockSupabase);

      // Add a third player (spectator/other) to verify broadcast reaches them.
      const hostWs = createMockWs();
      const guestWs = createMockWs();
      const thirdWs = createMockWs();

      getOrCreateLobby(ROOM_CODE, HOST_ID);
      addPlayerToLobby(ROOM_CODE, {
        connectionId: 'conn-host',
        playerId: HOST_ID,
        displayName: hostUser.displayName,
        avatarId: hostUser.avatarId,
        isGuest: false,
        ws: hostWs,
      });
      addPlayerToLobby(ROOM_CODE, {
        connectionId: 'conn-guest',
        playerId: PLAYER_ID,
        displayName: guestUser.displayName,
        avatarId: guestUser.avatarId,
        isGuest: true,
        ws: guestWs,
      });
      addPlayerToLobby(ROOM_CODE, {
        connectionId: 'conn-third',
        playerId: 'third-player-id',
        displayName: 'Third Player',
        avatarId: 'avatar-3',
        isGuest: false,
        ws: thirdWs,
      });

      await handleKickPlayer(hostWs, 'conn-host', hostUser, {
        type: 'kick-player',
        roomCode: ROOM_CODE,
        targetPlayerId: PLAYER_ID,
      });

      // Third player should have received 'player-kicked'.
      const payloads = allSentPayloads(thirdWs);
      expect(payloads.some((p) => p.type === 'player-kicked')).toBe(true);

      const event = payloads.find((p) => p.type === 'player-kicked');
      expect(event.roomCode).toBe(ROOM_CODE);
      expect(event.playerId).toBe(PLAYER_ID);
      expect(event.displayName).toBe('Guest Player');
    });

    it('broadcasts player-kicked to the host as well', async () => {
      const mockSupabase = buildMockSupabase({ room: waitingRoom });
      _setSupabaseClient(mockSupabase);

      const hostWs = createMockWs();
      const guestWs = createMockWs();
      setupLobbyWithTwoPlayers(hostWs, guestWs);

      await handleKickPlayer(hostWs, 'conn-host', hostUser, {
        type: 'kick-player',
        roomCode: ROOM_CODE,
        targetPlayerId: PLAYER_ID,
      });

      // Host receives both 'player-kicked' broadcast and 'kick-confirmed'.
      const payloads = allSentPayloads(hostWs);
      expect(payloads.some((p) => p.type === 'player-kicked')).toBe(true);
      expect(payloads.some((p) => p.type === 'kick-confirmed')).toBe(true);
    });

    it('sends kick-confirmed to the host', async () => {
      const mockSupabase = buildMockSupabase({ room: waitingRoom });
      _setSupabaseClient(mockSupabase);

      const hostWs = createMockWs();
      const guestWs = createMockWs();
      setupLobbyWithTwoPlayers(hostWs, guestWs);

      await handleKickPlayer(hostWs, 'conn-host', hostUser, {
        type: 'kick-player',
        roomCode: ROOM_CODE,
        targetPlayerId: PLAYER_ID,
      });

      const payload = lastSentPayload(hostWs);
      expect(payload.type).toBe('kick-confirmed');
      expect(payload.playerId).toBe(PLAYER_ID);
      expect(payload.roomCode).toBe(ROOM_CODE);
    });

    it('closes the kicked player WebSocket with code 4002', async () => {
      const mockSupabase = buildMockSupabase({ room: waitingRoom });
      _setSupabaseClient(mockSupabase);

      const hostWs = createMockWs();
      const guestWs = createMockWs();
      setupLobbyWithTwoPlayers(hostWs, guestWs);

      await handleKickPlayer(hostWs, 'conn-host', hostUser, {
        type: 'kick-player',
        roomCode: ROOM_CODE,
        targetPlayerId: PLAYER_ID,
      });

      expect(guestWs.close).toHaveBeenCalledWith(4002, 'Kicked from room');
    });

    it('player-kicked event is NOT sent to the kicked player themselves', async () => {
      const mockSupabase = buildMockSupabase({ room: waitingRoom });
      _setSupabaseClient(mockSupabase);

      const hostWs = createMockWs();
      const guestWs = createMockWs();
      setupLobbyWithTwoPlayers(hostWs, guestWs);

      await handleKickPlayer(hostWs, 'conn-host', hostUser, {
        type: 'kick-player',
        roomCode: ROOM_CODE,
        targetPlayerId: PLAYER_ID,
      });

      // The kicked player's socket should only have received 'you-were-kicked',
      // NOT the 'player-kicked' broadcast (they were removed before broadcast).
      const payloads = allSentPayloads(guestWs);
      const types = payloads.map((p) => p.type);
      expect(types).toContain('you-were-kicked');
      expect(types).not.toContain('player-kicked');
    });

    it('roomCode is case-insensitive (lowercased input matches uppercase room)', async () => {
      const mockSupabase = buildMockSupabase({ room: waitingRoom });
      _setSupabaseClient(mockSupabase);

      const hostWs = createMockWs();
      const guestWs = createMockWs();
      setupLobbyWithTwoPlayers(hostWs, guestWs);

      await handleKickPlayer(hostWs, 'conn-host', hostUser, {
        type: 'kick-player',
        roomCode: 'abcdef', // lowercase
        targetPlayerId: PLAYER_ID,
      });

      const payload = lastSentPayload(hostWs);
      expect(payload.type).toBe('kick-confirmed');
      expect(payload.roomCode).toBe(ROOM_CODE); // returned as uppercase
    });
  });

  // ── Authorisation ──────────────────────────────────────────────────────────

  describe('authorisation', () => {
    it('returns FORBIDDEN error when a non-host tries to kick', async () => {
      const mockSupabase = buildMockSupabase({ room: waitingRoom });
      _setSupabaseClient(mockSupabase);

      const hostWs = createMockWs();
      const guestWs = createMockWs();
      setupLobbyWithTwoPlayers(hostWs, guestWs);

      // guestUser is NOT the host
      await handleKickPlayer(guestWs, 'conn-guest', guestUser, {
        type: 'kick-player',
        roomCode: ROOM_CODE,
        targetPlayerId: HOST_ID,
      });

      const payload = lastSentPayload(guestWs);
      expect(payload.type).toBe('error');
      expect(payload.code).toBe('FORBIDDEN');
      expect(payload.message).toMatch(/host/i);
    });

    it('does not modify lobby state when a non-host tries to kick', async () => {
      const mockSupabase = buildMockSupabase({ room: waitingRoom });
      _setSupabaseClient(mockSupabase);

      const hostWs = createMockWs();
      const guestWs = createMockWs();
      setupLobbyWithTwoPlayers(hostWs, guestWs);

      await handleKickPlayer(guestWs, 'conn-guest', guestUser, {
        type: 'kick-player',
        roomCode: ROOM_CODE,
        targetPlayerId: HOST_ID,
      });

      const players = getLobbyPlayers(ROOM_CODE);
      expect(players).toHaveLength(2);
    });

    it('returns error when host tries to kick themselves', async () => {
      const mockSupabase = buildMockSupabase({ room: waitingRoom });
      _setSupabaseClient(mockSupabase);

      const hostWs = createMockWs();
      const guestWs = createMockWs();
      setupLobbyWithTwoPlayers(hostWs, guestWs);

      await handleKickPlayer(hostWs, 'conn-host', hostUser, {
        type: 'kick-player',
        roomCode: ROOM_CODE,
        targetPlayerId: HOST_ID, // same as host
      });

      const payload = lastSentPayload(hostWs);
      expect(payload.type).toBe('error');
      expect(payload.message).toMatch(/cannot kick themselves/i);
    });
  });

  // ── Target-not-found ──────────────────────────────────────────────────────

  describe('target not in lobby', () => {
    it('returns PLAYER_NOT_FOUND error when target is not in lobby', async () => {
      const mockSupabase = buildMockSupabase({ room: waitingRoom });
      _setSupabaseClient(mockSupabase);

      const hostWs = createMockWs();
      const guestWs = createMockWs();
      setupLobbyWithTwoPlayers(hostWs, guestWs);

      await handleKickPlayer(hostWs, 'conn-host', hostUser, {
        type: 'kick-player',
        roomCode: ROOM_CODE,
        targetPlayerId: 'nonexistent-player-id',
      });

      const payload = lastSentPayload(hostWs);
      expect(payload.type).toBe('error');
      expect(payload.code).toBe('PLAYER_NOT_FOUND');
    });

    it('does not change lobby state when target is not found', async () => {
      const mockSupabase = buildMockSupabase({ room: waitingRoom });
      _setSupabaseClient(mockSupabase);

      const hostWs = createMockWs();
      const guestWs = createMockWs();
      setupLobbyWithTwoPlayers(hostWs, guestWs);

      await handleKickPlayer(hostWs, 'conn-host', hostUser, {
        type: 'kick-player',
        roomCode: ROOM_CODE,
        targetPlayerId: 'ghost-player',
      });

      expect(getLobbyPlayers(ROOM_CODE)).toHaveLength(2);
    });
  });

  // ── Room status ───────────────────────────────────────────────────────────

  describe('room status enforcement', () => {
    it('returns ROOM_NOT_WAITING error when game is in_progress', async () => {
      const inProgressRoom = { ...waitingRoom, status: 'in_progress' };
      const mockSupabase = buildMockSupabase({ room: inProgressRoom });
      _setSupabaseClient(mockSupabase);

      const hostWs = createMockWs();
      const guestWs = createMockWs();
      setupLobbyWithTwoPlayers(hostWs, guestWs);

      await handleKickPlayer(hostWs, 'conn-host', hostUser, {
        type: 'kick-player',
        roomCode: ROOM_CODE,
        targetPlayerId: PLAYER_ID,
      });

      const payload = lastSentPayload(hostWs);
      expect(payload.type).toBe('error');
      expect(payload.code).toBe('ROOM_NOT_WAITING');
    });

    it('returns error when room is in starting status', async () => {
      const startingRoom = { ...waitingRoom, status: 'starting' };
      const mockSupabase = buildMockSupabase({ room: startingRoom });
      _setSupabaseClient(mockSupabase);

      const hostWs = createMockWs();
      const guestWs = createMockWs();
      setupLobbyWithTwoPlayers(hostWs, guestWs);

      await handleKickPlayer(hostWs, 'conn-host', hostUser, {
        type: 'kick-player',
        roomCode: ROOM_CODE,
        targetPlayerId: PLAYER_ID,
      });

      const payload = lastSentPayload(hostWs);
      expect(payload.type).toBe('error');
    });
  });

  // ── Room not found ────────────────────────────────────────────────────────

  describe('room not found', () => {
    it('returns error when DB returns no room', async () => {
      const mockSupabase = buildMockSupabase({ room: null });
      _setSupabaseClient(mockSupabase);

      const hostWs = createMockWs();

      await handleKickPlayer(hostWs, 'conn-host', hostUser, {
        type: 'kick-player',
        roomCode: ROOM_CODE,
        targetPlayerId: PLAYER_ID,
      });

      const payload = lastSentPayload(hostWs);
      expect(payload.type).toBe('error');
      expect(payload.message).toMatch(/room not found/i);
    });

    it('returns error when DB throws', async () => {
      const mockSupabase = buildMockSupabase({ dbError: new Error('DB down') });
      _setSupabaseClient(mockSupabase);

      const hostWs = createMockWs();

      await handleKickPlayer(hostWs, 'conn-host', hostUser, {
        type: 'kick-player',
        roomCode: ROOM_CODE,
        targetPlayerId: PLAYER_ID,
      });

      const payload = lastSentPayload(hostWs);
      expect(payload.type).toBe('error');
    });
  });

  // ── Input validation ──────────────────────────────────────────────────────

  describe('input validation', () => {
    it('returns error for missing roomCode', async () => {
      const hostWs = createMockWs();

      await handleKickPlayer(hostWs, 'conn-host', hostUser, {
        type: 'kick-player',
        targetPlayerId: PLAYER_ID,
      });

      const payload = lastSentPayload(hostWs);
      expect(payload.type).toBe('error');
      expect(payload.message).toMatch(/roomCode/i);
    });

    it('returns error for roomCode that is not 6 chars', async () => {
      const hostWs = createMockWs();

      await handleKickPlayer(hostWs, 'conn-host', hostUser, {
        type: 'kick-player',
        roomCode: 'ABC', // too short
        targetPlayerId: PLAYER_ID,
      });

      const payload = lastSentPayload(hostWs);
      expect(payload.type).toBe('error');
    });

    it('returns error for missing targetPlayerId', async () => {
      const hostWs = createMockWs();

      await handleKickPlayer(hostWs, 'conn-host', hostUser, {
        type: 'kick-player',
        roomCode: ROOM_CODE,
      });

      const payload = lastSentPayload(hostWs);
      expect(payload.type).toBe('error');
      expect(payload.message).toMatch(/targetPlayerId/i);
    });

    it('returns error for empty string targetPlayerId', async () => {
      const hostWs = createMockWs();

      await handleKickPlayer(hostWs, 'conn-host', hostUser, {
        type: 'kick-player',
        roomCode: ROOM_CODE,
        targetPlayerId: '   ',
      });

      const payload = lastSentPayload(hostWs);
      expect(payload.type).toBe('error');
    });
  });

  // ── No lobby exists ───────────────────────────────────────────────────────

  describe('lobby not initialised', () => {
    it('returns error when no lobby exists for the room', async () => {
      const mockSupabase = buildMockSupabase({ room: waitingRoom });
      _setSupabaseClient(mockSupabase);

      const hostWs = createMockWs();
      // Deliberately do NOT call getOrCreateLobby — lobby is absent.

      await handleKickPlayer(hostWs, 'conn-host', hostUser, {
        type: 'kick-player',
        roomCode: ROOM_CODE,
        targetPlayerId: PLAYER_ID,
      });

      const payload = lastSentPayload(hostWs);
      expect(payload.type).toBe('error');
      expect(payload.message).toMatch(/lobby/i);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests for lobbyStore helpers used in kick flow
// ---------------------------------------------------------------------------

describe('lobbyStore (kick-related behaviour)', () => {
  beforeEach(() => {
    _clearAll();
  });

  it('removePlayerFromLobby deletes the connection index entry', () => {
    const { _getConnectionIndex } = require('../lobby/lobbyStore');
    const ws = createMockWs();

    getOrCreateLobby(ROOM_CODE, HOST_ID);
    addPlayerToLobby(ROOM_CODE, {
      connectionId: 'conn-p1',
      playerId: PLAYER_ID,
      displayName: 'Player 1',
      avatarId: null,
      isGuest: true,
      ws,
    });

    expect(_getConnectionIndex().has('conn-p1')).toBe(true);

    const { removePlayerFromLobby } = require('../lobby/lobbyStore');
    removePlayerFromLobby(ROOM_CODE, PLAYER_ID);

    expect(_getConnectionIndex().has('conn-p1')).toBe(false);
  });

  it('lobby is deleted when last player is removed', () => {
    const { removePlayerFromLobby } = require('../lobby/lobbyStore');
    const ws = createMockWs();

    getOrCreateLobby(ROOM_CODE, HOST_ID);
    addPlayerToLobby(ROOM_CODE, {
      connectionId: 'conn-only',
      playerId: HOST_ID,
      displayName: 'Host',
      avatarId: null,
      isGuest: false,
      ws,
    });

    removePlayerFromLobby(ROOM_CODE, HOST_ID);

    expect(getLobby(ROOM_CODE)).toBeNull();
  });

  it('removePlayerFromLobby returns null for unknown player', () => {
    const { removePlayerFromLobby } = require('../lobby/lobbyStore');
    getOrCreateLobby(ROOM_CODE, HOST_ID);

    const result = removePlayerFromLobby(ROOM_CODE, 'no-such-player');
    expect(result).toBeNull();
  });

  it('removePlayerFromLobby returns null for unknown room', () => {
    const { removePlayerFromLobby } = require('../lobby/lobbyStore');
    const result = removePlayerFromLobby('ZZZZZZ', PLAYER_ID);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests for sendJson and broadcastToRoom utilities
// ---------------------------------------------------------------------------

describe('sendJson', () => {
  it('sends serialised JSON to an OPEN socket', () => {
    const ws = createMockWs(WebSocket.OPEN);
    sendJson(ws, { type: 'test', value: 42 });
    expect(ws.send).toHaveBeenCalledWith('{"type":"test","value":42}');
  });

  it('does nothing when socket is CLOSING', () => {
    const ws = createMockWs(WebSocket.CLOSING);
    sendJson(ws, { type: 'test' });
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('does nothing when socket is CLOSED', () => {
    const ws = createMockWs(WebSocket.CLOSED);
    sendJson(ws, { type: 'test' });
    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe('broadcastToRoom', () => {
  beforeEach(() => {
    _clearAll();
  });

  it('sends to all players in a room', () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();

    getOrCreateLobby(ROOM_CODE, HOST_ID);
    addPlayerToLobby(ROOM_CODE, {
      connectionId: 'c1',
      playerId: 'p1',
      displayName: 'P1',
      avatarId: null,
      isGuest: false,
      ws: ws1,
    });
    addPlayerToLobby(ROOM_CODE, {
      connectionId: 'c2',
      playerId: 'p2',
      displayName: 'P2',
      avatarId: null,
      isGuest: false,
      ws: ws2,
    });

    broadcastToRoom(ROOM_CODE, { type: 'ping' });

    expect(ws1.send).toHaveBeenCalledTimes(1);
    expect(ws2.send).toHaveBeenCalledTimes(1);
  });

  it('excludes the specified connectionId', () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();

    getOrCreateLobby(ROOM_CODE, HOST_ID);
    addPlayerToLobby(ROOM_CODE, {
      connectionId: 'c1',
      playerId: 'p1',
      displayName: 'P1',
      avatarId: null,
      isGuest: false,
      ws: ws1,
    });
    addPlayerToLobby(ROOM_CODE, {
      connectionId: 'c2',
      playerId: 'p2',
      displayName: 'P2',
      avatarId: null,
      isGuest: false,
      ws: ws2,
    });

    broadcastToRoom(ROOM_CODE, { type: 'ping' }, 'c1');

    expect(ws1.send).not.toHaveBeenCalled();
    expect(ws2.send).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a room with no players', () => {
    // Should not throw
    expect(() => broadcastToRoom('ZZZZZZ', { type: 'ping' })).not.toThrow();
  });
});
