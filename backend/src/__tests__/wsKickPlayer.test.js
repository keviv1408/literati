'use strict';

/**
 * Unit tests for the kick-player handler in wsServer.js
 *
 * Tests are scoped to `handleKickPlayer` — the pure message handler.
 * WebSocket connections and Supabase calls are fully mocked so no external
 * services are required.
 *
 * Coverage:
 *   1. Host can kick a non-host player (happy path)
 *   2. Non-host request is rejected with FORBIDDEN error
 *   3. Host cannot kick themselves
 *   4. Missing targetPlayerId is rejected
 *   5. Invalid roomCode format is rejected
 *   6. Target not in lobby → PLAYER_NOT_FOUND error
 *   7. Room not found in DB → error
 *   8. Room not in 'waiting' status → ROOM_NOT_WAITING error
 *   9. Kicked player receives 'you-were-kicked' before being removed
 *  10. Remaining players receive 'player-kicked' broadcast
 *  11. Host receives 'kick-confirmed' after successful kick
 *  12. Target is removed from the lobby after kick
 *  13. Kicked player's WebSocket is closed with code 4002
 */

jest.mock('../rooms/roomBlocklist', () => ({
  blockPlayer: jest.fn(),
}));

const {
  handleKickPlayer,
} = require('../ws/wsServer');

const {
  getOrCreateLobby,
  addPlayerToLobby,
  getLobbyPlayers,
  _clearAll,
} = require('../lobby/lobbyStore');

const { blockPlayer } = require('../rooms/roomBlocklist');
const { _setSupabaseClient } = require('../db/supabase');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock WebSocket object. */
function makeWs(open = true) {
  return {
    readyState: open ? 1 /* OPEN */ : 3 /* CLOSED */,
    send: jest.fn(),
    close: jest.fn(),
  };
}

/** Decode the last JSON message sent to a mock WebSocket. */
function lastSent(ws) {
  if (ws.send.mock.calls.length === 0) return null;
  const raw = ws.send.mock.calls[ws.send.mock.calls.length - 1][0];
  return JSON.parse(raw);
}

/** Decode all JSON messages sent to a mock WebSocket. */
function allSent(ws) {
  return ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
}

/**
 * Build a chainable fake Supabase client that returns the given room.
 *
 * Uses the same _setSupabaseClient() injection point used by rooms.test.js so
 * the already-loaded wsServer module picks up our mock rather than trying to
 * reach a real database.
 */
function setSupabaseMock(room, err = null) {
  const mockClient = {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: room, error: err }),
  };
  _setSupabaseClient(mockClient);
  return mockClient;
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const HOST_ID = 'host-player-id';
const GUEST_ID = 'guest-player-id';
const OTHER_ID = 'other-player-id';
const ROOM_CODE = 'KICK01';

/** Standard fake room record (status: waiting, host=HOST_ID). */
const FAKE_ROOM = {
  id: 'room-uuid',
  code: ROOM_CODE,
  host_user_id: HOST_ID,
  status: 'waiting',
};

// ---------------------------------------------------------------------------
// Shared setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _clearAll();
  jest.clearAllMocks();
  // Reset Supabase client to null so each test installs its own mock.
  _setSupabaseClient(null);
});

afterAll(() => {
  // Leave the module in a clean state.
  _setSupabaseClient(null);
});

// ---------------------------------------------------------------------------
// Helper: populate the lobby with a host and one other player.
// ---------------------------------------------------------------------------

function populateLobby(roomCode = ROOM_CODE) {
  getOrCreateLobby(roomCode, HOST_ID);

  const hostWs = makeWs();
  const guestWs = makeWs();

  addPlayerToLobby(roomCode, {
    connectionId: 'conn-host',
    playerId: HOST_ID,
    displayName: 'TheHost',
    avatarId: null,
    isGuest: false,
    ws: hostWs,
  });

  addPlayerToLobby(roomCode, {
    connectionId: 'conn-guest',
    playerId: GUEST_ID,
    displayName: 'GuestPlayer',
    avatarId: null,
    isGuest: true,
    ws: guestWs,
  });

  return { hostWs, guestWs };
}

// ---------------------------------------------------------------------------
// Test: Happy path — host kicks a non-host player
// ---------------------------------------------------------------------------

describe('handleKickPlayer — happy path', () => {
  it('sends you-were-kicked to the target, removes them from lobby, broadcasts player-kicked, and confirms to host', async () => {
    const { hostWs, guestWs } = populateLobby();
    setSupabaseMock(FAKE_ROOM);

    await handleKickPlayer(
      hostWs,
      'conn-host',
      { playerId: HOST_ID, displayName: 'TheHost', isGuest: false },
      { type: 'kick-player', roomCode: ROOM_CODE, targetPlayerId: GUEST_ID }
    );

    // 1. Target receives 'you-were-kicked'
    const targetMessages = allSent(guestWs);
    expect(targetMessages.some((m) => m.type === 'you-were-kicked')).toBe(true);

    // 2. Target's socket is closed with code 4002
    expect(guestWs.close).toHaveBeenCalledWith(4002, 'Kicked from room');

    // 3. Target is removed from the lobby
    const remaining = getLobbyPlayers(ROOM_CODE);
    expect(remaining.find((p) => p.playerId === GUEST_ID)).toBeUndefined();
    expect(remaining.find((p) => p.playerId === HOST_ID)).toBeDefined();

    // 4. Host receives 'kick-confirmed'
    const hostMessages = allSent(hostWs);
    const confirmed = hostMessages.find((m) => m.type === 'kick-confirmed');
    expect(confirmed).toBeDefined();
    expect(confirmed.playerId).toBe(GUEST_ID);
  });

  it('adds the kicked player to the roomBlocklist', async () => {
    const { hostWs } = populateLobby();
    setSupabaseMock(FAKE_ROOM);

    await handleKickPlayer(
      hostWs,
      'conn-host',
      { playerId: HOST_ID, displayName: 'TheHost', isGuest: false },
      { type: 'kick-player', roomCode: ROOM_CODE, targetPlayerId: GUEST_ID }
    );

    expect(blockPlayer).toHaveBeenCalledWith(ROOM_CODE, GUEST_ID);
  });

  it('broadcasts player-kicked to remaining players (not the kicked player)', async () => {
    // Add a third player to the lobby so we can observe the broadcast.
    const { hostWs, guestWs } = populateLobby();

    const thirdWs = makeWs();
    addPlayerToLobby(ROOM_CODE, {
      connectionId: 'conn-third',
      playerId: OTHER_ID,
      displayName: 'ThirdPlayer',
      avatarId: null,
      isGuest: false,
      ws: thirdWs,
    });

    setSupabaseMock(FAKE_ROOM);

    await handleKickPlayer(
      hostWs,
      'conn-host',
      { playerId: HOST_ID, displayName: 'TheHost', isGuest: false },
      { type: 'kick-player', roomCode: ROOM_CODE, targetPlayerId: GUEST_ID }
    );

    // The remaining third player should receive 'player-kicked'.
    const thirdMessages = allSent(thirdWs);
    const broadcast = thirdMessages.find((m) => m.type === 'player-kicked');
    expect(broadcast).toBeDefined();
    expect(broadcast.playerId).toBe(GUEST_ID);

    // The kicked player should have received 'you-were-kicked' (NOT 'player-kicked').
    const guestMessages = allSent(guestWs);
    expect(guestMessages.some((m) => m.type === 'you-were-kicked')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test: Authorization
// ---------------------------------------------------------------------------

describe('handleKickPlayer — authorization', () => {
  it('rejects a kick attempt from a non-host player with FORBIDDEN error', async () => {
    populateLobby();
    setSupabaseMock(FAKE_ROOM);

    const nonHostWs = makeWs();

    await handleKickPlayer(
      nonHostWs,
      'conn-guest',
      // Non-host player (GUEST_ID) tries to kick HOST_ID
      { playerId: GUEST_ID, displayName: 'GuestPlayer', isGuest: true },
      { type: 'kick-player', roomCode: ROOM_CODE, targetPlayerId: HOST_ID }
    );

    const msg = lastSent(nonHostWs);
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('FORBIDDEN');

    // Host must still be in the lobby.
    const remaining = getLobbyPlayers(ROOM_CODE);
    expect(remaining.find((p) => p.playerId === HOST_ID)).toBeDefined();
  });

  it('rejects when the host tries to kick themselves', async () => {
    const { hostWs } = populateLobby();
    setSupabaseMock(FAKE_ROOM);

    await handleKickPlayer(
      hostWs,
      'conn-host',
      { playerId: HOST_ID, displayName: 'TheHost', isGuest: false },
      { type: 'kick-player', roomCode: ROOM_CODE, targetPlayerId: HOST_ID }
    );

    const msg = lastSent(hostWs);
    expect(msg.type).toBe('error');
    expect(msg.message).toMatch(/cannot kick themselves/i);
  });
});

// ---------------------------------------------------------------------------
// Test: Input validation
// ---------------------------------------------------------------------------

describe('handleKickPlayer — input validation', () => {
  it('rejects missing targetPlayerId', async () => {
    const { hostWs } = populateLobby();
    // Input validation happens before any DB call, so no Supabase mock needed.

    await handleKickPlayer(
      hostWs,
      'conn-host',
      { playerId: HOST_ID, displayName: 'TheHost', isGuest: false },
      { type: 'kick-player', roomCode: ROOM_CODE }
    );

    const msg = lastSent(hostWs);
    expect(msg.type).toBe('error');
    expect(msg.message).toMatch(/targetPlayerId/i);
  });

  it('rejects an empty targetPlayerId string', async () => {
    const { hostWs } = populateLobby();

    await handleKickPlayer(
      hostWs,
      'conn-host',
      { playerId: HOST_ID, displayName: 'TheHost', isGuest: false },
      { type: 'kick-player', roomCode: ROOM_CODE, targetPlayerId: '   ' }
    );

    const msg = lastSent(hostWs);
    expect(msg.type).toBe('error');
  });

  it('rejects an invalid roomCode (wrong length)', async () => {
    const { hostWs } = populateLobby();

    await handleKickPlayer(
      hostWs,
      'conn-host',
      { playerId: HOST_ID, displayName: 'TheHost', isGuest: false },
      { type: 'kick-player', roomCode: 'TOOLONG123', targetPlayerId: GUEST_ID }
    );

    const msg = lastSent(hostWs);
    expect(msg.type).toBe('error');
    expect(msg.message).toMatch(/roomCode/i);
  });
});

// ---------------------------------------------------------------------------
// Test: Room / lobby state checks
// ---------------------------------------------------------------------------

describe('handleKickPlayer — room and lobby checks', () => {
  it('returns an error when the room does not exist in DB', async () => {
    const { hostWs } = populateLobby();
    // Supabase returns no room (data: null).
    setSupabaseMock(null);

    await handleKickPlayer(
      hostWs,
      'conn-host',
      { playerId: HOST_ID, displayName: 'TheHost', isGuest: false },
      { type: 'kick-player', roomCode: ROOM_CODE, targetPlayerId: GUEST_ID }
    );

    const msg = lastSent(hostWs);
    expect(msg.type).toBe('error');
    expect(msg.message).toMatch(/not found/i);
  });

  it('returns ROOM_NOT_WAITING when the room status is not waiting', async () => {
    const { hostWs } = populateLobby();

    const nonWaitingRoom = { ...FAKE_ROOM, status: 'in_progress' };
    setSupabaseMock(nonWaitingRoom);

    await handleKickPlayer(
      hostWs,
      'conn-host',
      { playerId: HOST_ID, displayName: 'TheHost', isGuest: false },
      { type: 'kick-player', roomCode: ROOM_CODE, targetPlayerId: GUEST_ID }
    );

    const msg = lastSent(hostWs);
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('ROOM_NOT_WAITING');
  });

  it('returns PLAYER_NOT_FOUND when the target is not in the lobby', async () => {
    const { hostWs } = populateLobby();
    setSupabaseMock(FAKE_ROOM);

    await handleKickPlayer(
      hostWs,
      'conn-host',
      { playerId: HOST_ID, displayName: 'TheHost', isGuest: false },
      { type: 'kick-player', roomCode: ROOM_CODE, targetPlayerId: 'non-existent-player' }
    );

    const msg = lastSent(hostWs);
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('PLAYER_NOT_FOUND');
  });
});
