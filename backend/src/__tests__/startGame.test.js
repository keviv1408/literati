'use strict';

/**
 * Tests for the 'start_game' WebSocket handler (handleStartGame, ).
 *
 * Covers:
 * 1. Authorization — only the host can start the game.
 * 2. Room not found — error sent when Supabase returns null.
 * 3. Room not waiting — error when room status is not 'waiting'.
 * 4. Bot fill — empty seats are filled with bots.
 * 5. Full room — no bots added when all seats are occupied.
 * 6. Broadcast to all — 'lobby-starting' sent to all connected clients.
 * 7. Seat ordering — T1 even, T2 odd indices; sorted ascending.
 * 8. Supabase update — room status set to 'starting'.
 * 9. Supabase update error — non-fatal; broadcast still fires.
 * 10. 8-player game — correct seat count and team distribution.
 * 11. Closed WS clients — no crash when broadcasting to disconnected clients.
 * 12. Idempotency — concurrent calls blocked by _startingRooms guard.
 *
 * Strategy:
 * - No real DB or WebSocket ports are opened — everything is mocked.
 * - Supabase is injected via _setSupabaseClientFactory.
 * - cancelLobbyTimer is mocked via jest.mock.
 * - gameSocketServer is injected via _setGameServer.
 * - roomClients and roomMeta are populated directly.
 * - _startingRooms is cleared manually between tests.
 * - _resetRoomState() resets roomClients + roomMeta between tests.
 */

// Mock cancelLobbyTimer before requiring the module under test.
jest.mock('../matchmaking/lobbyTimer', () => ({
  cancelLobbyTimer: jest.fn(),
  startLobbyTimer:  jest.fn(),
}));

const { WebSocket } = require('ws');
const { cancelLobbyTimer } = require('../matchmaking/lobbyTimer');
const {
  handleStartGame,
  roomClients,
  roomMeta,
  broadcast,
  _setSupabaseClientFactory,
  _setGameServer,
  _startingRooms,
  _resetRoomState,
} = require('../ws/roomSocketServer');

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Minimal mock WebSocket that records sent messages. */
function createMockWs(readyState = WebSocket.OPEN) {
  return {
    readyState,
    send: jest.fn(),
    close: jest.fn(),
  };
}

/** Parse the JSON from the most-recent ws.send() call. */
function lastSent(mockWs) {
  const calls = mockWs.send.mock.calls;
  if (calls.length === 0) return null;
  return JSON.parse(calls[calls.length - 1][0]);
}

/**
 * Build a chainable Supabase mock that supports both read and write paths:
 *
 * Read (fetchRoomMetaFull):
 * supabase.from('rooms').select(...).eq('code', roomCode).maybeSingle()
 * → resolves to { data: roomData, error: null }
 *
 * Write (status update):
 * supabase.from('rooms').update({ status }).eq('code', roomCode)
 * → resolves to { data: null, error: updateError }
 *
 * @param {{ roomData?: Object|null, updateError?: Object|null }} opts
 */
function buildMockSupabase({ roomData = null, updateError = null } = {}) {
  // Shared.eq() for both chains — we differentiate by which parent called it
  const eqForRead   = jest.fn().mockReturnValue({
    maybeSingle: jest.fn().mockResolvedValue({ data: roomData, error: null }),
  });
  const eqForWrite  = jest.fn().mockResolvedValue({ data: null, error: updateError });

  const select = jest.fn().mockReturnValue({ eq: eqForRead });
  const update = jest.fn().mockReturnValue({ eq: eqForWrite });

  const from   = jest.fn().mockReturnValue({ select, update });

  return {
    from,
    auth: { getUser: jest.fn() },
    // Refs for assertions
    _select: select,
    _update: update,
    _eqRead:  eqForRead,
    _eqWrite: eqForWrite,
  };
}

/** Build a minimal mock game server (injectable via _setGameServer). */
function buildMockGameServer() {
  return {
    createGame:               jest.fn().mockReturnValue({ players: [], currentTurnPlayerId: null }),
    scheduleBotTurnIfNeeded:  jest.fn(),
  };
}

/** Standard fake room data returned by fetchRoomMetaFull. */
function makeFakeRoomData(overrides = {}) {
  return {
    id:                   'room-uuid-test',
    host_user_id:         'h1',
    status:               'waiting',
    player_count:         6,
    card_removal_variant: 'remove_7s',
    ...overrides,
  };
}

/**
 * Populate roomClients and roomMeta for a room.
 * Returns the client Map for the room.
 *
 * @param {string} roomCode
 * @param {number} playerCount
 * @param {Object[]} players — { userId, displayName, isGuest?, isHost?, teamId, ws? }
 * @returns {Map<string, Object>}
 */
function setupRoom(roomCode, playerCount, players) {
  const clientMap = new Map();
  for (const p of players) {
    const ws = p.ws ?? createMockWs();
    clientMap.set(p.userId, {
      ws,
      userId:      p.userId,
      displayName: p.displayName,
      isGuest:     p.isGuest ?? false,
      isHost:      p.isHost ?? false,
      teamId:      p.teamId,
    });
  }
  roomClients.set(roomCode, clientMap);
  roomMeta.set(roomCode, { playerCount });
  return clientMap;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('handleStartGame ', () => {
  const ROOM = 'STRT01';

  beforeEach(() => {
    jest.clearAllMocks();
    _resetRoomState();
    _startingRooms.clear();
    _setGameServer(null);
    _setSupabaseClientFactory(null);
  });

  afterAll(() => {
    _resetRoomState();
    _startingRooms.clear();
    _setSupabaseClientFactory(null);
    _setGameServer(null);
  });

  // ── 1. Authorization ────────────────────────────────────────────────────────

  it('sends error and does not start when caller is not the host', async () => {
    const playerWs = createMockWs();
    const hostWs   = createMockWs();

    setupRoom(ROOM, 6, [
      { userId: 'h1', displayName: 'Host', isHost: true,  teamId: 1, ws: hostWs   },
      { userId: 'p2', displayName: 'Bob',  isHost: false, teamId: 2, ws: playerWs },
    ]);

    await handleStartGame({
      ws:       playerWs,
      userId:   'p2',
      isHost:   false,
      roomCode: ROOM,
      clients:  roomClients.get(ROOM),
    });

    expect(lastSent(playerWs)).toMatchObject({
      type:    'error',
      message: expect.stringMatching(/host/i),
    });
    // No broadcast to other clients
    expect(hostWs.send).not.toHaveBeenCalled();
  });

  // ── 2. Room not found ───────────────────────────────────────────────────────

  it('sends error when Supabase cannot find the room', async () => {
    const mockSupa = buildMockSupabase({ roomData: null });
    _setSupabaseClientFactory(() => mockSupa);

    const hostWs = createMockWs();
    setupRoom(ROOM, 6, [
      { userId: 'h1', displayName: 'Host', isHost: true, teamId: 1, ws: hostWs },
    ]);

    await handleStartGame({ ws: hostWs, userId: 'h1', isHost: true, roomCode: ROOM, clients: roomClients.get(ROOM) });

    expect(lastSent(hostWs)).toMatchObject({ type: 'error', message: expect.stringMatching(/not found/i) });
  });

  // ── 3. Room not in waiting status ───────────────────────────────────────────

  it('sends error when room is already in_progress', async () => {
    const mockSupa = buildMockSupabase({ roomData: makeFakeRoomData({ status: 'in_progress' }) });
    _setSupabaseClientFactory(() => mockSupa);

    const hostWs = createMockWs();
    setupRoom(ROOM, 6, [
      { userId: 'h1', displayName: 'Host', isHost: true, teamId: 1, ws: hostWs },
    ]);

    await handleStartGame({ ws: hostWs, userId: 'h1', isHost: true, roomCode: ROOM, clients: roomClients.get(ROOM) });

    expect(lastSent(hostWs)).toMatchObject({
      type: 'error',
      code: 'ROOM_NOT_WAITING',
    });
  });

  // ── 4. Bot fill — empty seats ───────────────────────────────────────────────

  it('fills empty seats with bots and broadcasts lobby-starting', async () => {
    const mockSupa = buildMockSupabase({ roomData: makeFakeRoomData() });
    _setSupabaseClientFactory(() => mockSupa);
    _setGameServer(buildMockGameServer());

    const hostWs = createMockWs();
    setupRoom(ROOM, 6, [
      { userId: 'h1', displayName: 'Alice', isHost: true, teamId: 1, ws: hostWs },
    ]);

    await handleStartGame({ ws: hostWs, userId: 'h1', isHost: true, roomCode: ROOM, clients: roomClients.get(ROOM) });

    const payload = lastSent(hostWs);
    expect(payload.type).toBe('lobby-starting');
    expect(payload.roomCode).toBe(ROOM);
    expect(Array.isArray(payload.seats)).toBe(true);
    expect(payload.seats).toHaveLength(6); // 1 human + 5 bots

    // Human host in seat 0 (T1)
    expect(payload.seats[0]).toMatchObject({
      seatIndex:   0,
      playerId:    'h1',
      displayName: 'Alice',
      isBot:       false,
      teamId:      1,
    });

    // 5 remaining seats are bots
    expect(payload.seats.filter((s) => s.isBot)).toHaveLength(5);

    // botsAdded array present
    expect(Array.isArray(payload.botsAdded)).toBe(true);
    expect(payload.botsAdded).toHaveLength(5);
  });

  // ── 5. Full room — no bots needed ───────────────────────────────────────────

  it('starts with no bots when all 6 seats are occupied by humans', async () => {
    const mockSupa = buildMockSupabase({ roomData: makeFakeRoomData() });
    _setSupabaseClientFactory(() => mockSupa);
    _setGameServer(buildMockGameServer());

    const ws = () => createMockWs();
    const wsList = [ws(), ws(), ws(), ws(), ws(), ws()];

    setupRoom(ROOM, 6, [
      { userId: 'h1', displayName: 'H1', isHost: true,  teamId: 1, ws: wsList[0] },
      { userId: 'p2', displayName: 'P2', isHost: false, teamId: 2, ws: wsList[1] },
      { userId: 'p3', displayName: 'P3', isHost: false, teamId: 1, ws: wsList[2] },
      { userId: 'p4', displayName: 'P4', isHost: false, teamId: 2, ws: wsList[3] },
      { userId: 'p5', displayName: 'P5', isHost: false, teamId: 1, ws: wsList[4] },
      { userId: 'p6', displayName: 'P6', isHost: false, teamId: 2, ws: wsList[5] },
    ]);

    await handleStartGame({ ws: wsList[0], userId: 'h1', isHost: true, roomCode: ROOM, clients: roomClients.get(ROOM) });

    const payload = lastSent(wsList[0]);
    expect(payload.type).toBe('lobby-starting');
    expect(payload.seats).toHaveLength(6);
    expect(payload.seats.every((s) => !s.isBot)).toBe(true);
    expect(payload.botsAdded).toHaveLength(0);
  });

  // ── 6. Broadcast reaches all connected clients ──────────────────────────────

  it('broadcasts lobby-starting to all connected clients', async () => {
    const mockSupa = buildMockSupabase({ roomData: makeFakeRoomData() });
    _setSupabaseClientFactory(() => mockSupa);
    _setGameServer(buildMockGameServer());

    const hostWs    = createMockWs();
    const player2Ws = createMockWs();
    const player3Ws = createMockWs();

    setupRoom(ROOM, 6, [
      { userId: 'h1', displayName: 'Host',  isHost: true,  teamId: 1, ws: hostWs    },
      { userId: 'p2', displayName: 'Alice', isHost: false, teamId: 2, ws: player2Ws },
      { userId: 'p3', displayName: 'Bob',   isHost: false, teamId: 1, ws: player3Ws },
    ]);

    await handleStartGame({ ws: hostWs, userId: 'h1', isHost: true, roomCode: ROOM, clients: roomClients.get(ROOM) });

    // All three connected clients receive lobby-starting
    [hostWs, player2Ws, player3Ws].forEach((ws) => {
      const payload = lastSent(ws);
      expect(payload.type).toBe('lobby-starting');
      expect(payload.seats).toHaveLength(6);
    });
  });

  // ── 7. Seat ordering — T1 even, T2 odd ─────────────────────────────────────

  it('assigns T1 players to even seats and T2 players to odd seats', async () => {
    const mockSupa = buildMockSupabase({ roomData: makeFakeRoomData() });
    _setSupabaseClientFactory(() => mockSupa);
    _setGameServer(buildMockGameServer());

    const hostWs = createMockWs();
    setupRoom(ROOM, 6, [
      { userId: 'h1', displayName: 'Host',  isHost: true,  teamId: 1, ws: hostWs       },
      { userId: 'p2', displayName: 'Alice', isHost: false, teamId: 2, ws: createMockWs() },
      { userId: 'p3', displayName: 'Bob',   isHost: false, teamId: 1, ws: createMockWs() },
    ]);

    await handleStartGame({ ws: hostWs, userId: 'h1', isHost: true, roomCode: ROOM, clients: roomClients.get(ROOM) });

    const { seats } = lastSent(hostWs);
    // Seats sorted by index 0..5
    expect(seats.map((s) => s.seatIndex)).toEqual([0, 1, 2, 3, 4, 5]);

    // Human T1 at seats 0 and 2
    expect(seats[0]).toMatchObject({ teamId: 1, isBot: false });
    expect(seats[2]).toMatchObject({ teamId: 1, isBot: false });

    // Human T2 at seat 1
    expect(seats[1]).toMatchObject({ teamId: 2, isBot: false });

    // Bots at seats 3, 4, 5 with correct team parity
    expect(seats[3]).toMatchObject({ seatIndex: 3, teamId: 2, isBot: true });
    expect(seats[4]).toMatchObject({ seatIndex: 4, teamId: 1, isBot: true });
    expect(seats[5]).toMatchObject({ seatIndex: 5, teamId: 2, isBot: true });
  });

  // ── 8. Supabase status update to 'starting' ─────────────────────────────────

  it('updates room status to starting in Supabase', async () => {
    const mockSupa = buildMockSupabase({ roomData: makeFakeRoomData() });
    _setSupabaseClientFactory(() => mockSupa);
    _setGameServer(buildMockGameServer());

    const hostWs = createMockWs();
    setupRoom(ROOM, 6, [
      { userId: 'h1', displayName: 'Host', isHost: true, teamId: 1, ws: hostWs },
    ]);

    await handleStartGame({ ws: hostWs, userId: 'h1', isHost: true, roomCode: ROOM, clients: roomClients.get(ROOM) });

    // Supabase.from('rooms').update({ status: 'starting' }).eq('code', ROOM) called
    expect(mockSupa.from).toHaveBeenCalledWith('rooms');
    expect(mockSupa._update).toHaveBeenCalledWith({ status: 'starting' });
    expect(mockSupa._eqWrite).toHaveBeenCalledWith('code', ROOM);
  });

  // ── 9a. Supabase update resolves with error object — fatal ─────────────────
  // When.eq() resolves with { error: object }, the implementation treats
  // it as a fatal error (sends error message and aborts before broadcast).

  it('sends error and does NOT broadcast when Supabase update resolves with error', async () => {
    const mockSupa = buildMockSupabase({
      roomData:    makeFakeRoomData(),
      updateError: { message: 'db constraint', code: '23505' },
    });
    _setSupabaseClientFactory(() => mockSupa);
    _setGameServer(buildMockGameServer());

    const hostWs = createMockWs();
    setupRoom(ROOM, 6, [
      { userId: 'h1', displayName: 'Host', isHost: true, teamId: 1, ws: hostWs },
    ]);

    await handleStartGame({ ws: hostWs, userId: 'h1', isHost: true, roomCode: ROOM, clients: roomClients.get(ROOM) });

    expect(lastSent(hostWs).type).toBe('error');
    // Confirm lobby-starting was NOT sent
    const allMsgs = hostWs.send.mock.calls.map((c) => JSON.parse(c[0]));
    expect(allMsgs.some((m) => m.type === 'lobby-starting')).toBe(false);
  });

  // ── 9b. Supabase update throws / rejects — non-fatal ────────────────────────
  // When.eq() throws (network error), the implementation logs and continues.

  it('still broadcasts lobby-starting when Supabase update throws (network error)', async () => {
    // Build a mock where fetchRoomMetaFull succeeds but update throws
    const eqForRead   = jest.fn().mockReturnValue({
      maybeSingle: jest.fn().mockResolvedValue({ data: makeFakeRoomData(), error: null }),
    });
    const eqForWrite  = jest.fn().mockRejectedValue(new Error('network timeout'));
    const select = jest.fn().mockReturnValue({ eq: eqForRead });
    const update = jest.fn().mockReturnValue({ eq: eqForWrite });
    const mockSupa = {
      from: jest.fn().mockReturnValue({ select, update }),
      auth: { getUser: jest.fn() },
    };
    _setSupabaseClientFactory(() => mockSupa);
    _setGameServer(buildMockGameServer());

    const hostWs = createMockWs();
    setupRoom(ROOM, 6, [
      { userId: 'h1', displayName: 'Host', isHost: true, teamId: 1, ws: hostWs },
    ]);

    await handleStartGame({ ws: hostWs, userId: 'h1', isHost: true, roomCode: ROOM, clients: roomClients.get(ROOM) });

    // Network error is non-fatal — broadcast should still happen
    expect(lastSent(hostWs).type).toBe('lobby-starting');
  });

  // ── 10. 8-player game ───────────────────────────────────────────────────────

  it('handles 8-player rooms — fills 7 bot seats when only host is present', async () => {
    const mockSupa = buildMockSupabase({ roomData: makeFakeRoomData({ player_count: 8 }) });
    _setSupabaseClientFactory(() => mockSupa);
    _setGameServer(buildMockGameServer());

    const hostWs = createMockWs();
    setupRoom(ROOM, 8, [
      { userId: 'h1', displayName: 'Host', isHost: true, teamId: 1, ws: hostWs },
    ]);

    await handleStartGame({ ws: hostWs, userId: 'h1', isHost: true, roomCode: ROOM, clients: roomClients.get(ROOM) });

    const { seats } = lastSent(hostWs);
    expect(seats).toHaveLength(8);
    expect(seats.filter((s) => s.isBot)).toHaveLength(7);
    expect(seats.map((s) => s.seatIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  // ── 11. Closed WS clients — no crash ───────────────────────────────────────

  it('does not throw when a client WebSocket is CLOSED', async () => {
    const mockSupa = buildMockSupabase({ roomData: makeFakeRoomData() });
    _setSupabaseClientFactory(() => mockSupa);
    _setGameServer(buildMockGameServer());

    const hostWs   = createMockWs(WebSocket.OPEN);
    const closedWs = createMockWs(WebSocket.CLOSED);

    setupRoom(ROOM, 6, [
      { userId: 'h1', displayName: 'Host',  isHost: true,  teamId: 1, ws: hostWs   },
      { userId: 'p2', displayName: 'Alice', isHost: false, teamId: 2, ws: closedWs },
    ]);

    await expect(
      handleStartGame({ ws: hostWs, userId: 'h1', isHost: true, roomCode: ROOM, clients: roomClients.get(ROOM) })
    ).resolves.not.toThrow();

    // OPEN client receives the broadcast; CLOSED does not
    expect(lastSent(hostWs).type).toBe('lobby-starting');
    expect(closedWs.send).not.toHaveBeenCalled();
  });

  // ── 12. Idempotency guard ───────────────────────────────────────────────────

  it('blocks a concurrent start_game call with ALREADY_STARTING', async () => {
    // Simulate a room that is already starting
    _startingRooms.add(ROOM);

    const hostWs = createMockWs();
    setupRoom(ROOM, 6, [
      { userId: 'h1', displayName: 'Host', isHost: true, teamId: 1, ws: hostWs },
    ]);

    await handleStartGame({ ws: hostWs, userId: 'h1', isHost: true, roomCode: ROOM, clients: roomClients.get(ROOM) });

    expect(lastSent(hostWs)).toMatchObject({
      type: 'error',
      code: 'ALREADY_STARTING',
    });
  });

  // ── 13. cancelLobbyTimer called ─────────────────────────────────────────────

  it('calls cancelLobbyTimer when starting the game', async () => {
    const mockSupa = buildMockSupabase({ roomData: makeFakeRoomData() });
    _setSupabaseClientFactory(() => mockSupa);
    _setGameServer(buildMockGameServer());

    const hostWs = createMockWs();
    setupRoom(ROOM, 6, [
      { userId: 'h1', displayName: 'Host', isHost: true, teamId: 1, ws: hostWs },
    ]);

    await handleStartGame({ ws: hostWs, userId: 'h1', isHost: true, roomCode: ROOM, clients: roomClients.get(ROOM) });

    expect(cancelLobbyTimer).toHaveBeenCalledWith(ROOM);
  });
});
