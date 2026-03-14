'use strict';

/**
 * Tests for the handleStartGame WebSocket handler (Sub-AC 5.4).
 *
 * Covers:
 *   - Authorization: only the host may start the game
 *   - Room validation: room must exist and be in 'waiting' status
 *   - Seat building: T1 → even indices, T2 → odd indices
 *   - Bot filling: empty seats get bot players
 *   - Game creation: gameSocketServer.createGame() is called with correct args
 *   - Supabase update: room status transitions to 'starting'
 *   - Broadcast: 'lobby-starting' sent to ALL connected clients (players + spectators)
 *   - buildOccupiedSeats: unit tests for the seat-building helper
 *
 * Strategy:
 *   - Supabase is mocked via _setSupabaseClientFactory.
 *   - gameSocketServer is mocked via _setGameServer.
 *   - WebSocket objects are plain mock objects with send/close spies.
 *   - In-memory room state is reset between tests via _resetRoomState.
 */

const { WebSocket } = require('ws');

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock WebSocket that tracks sent messages and close calls.
 * @param {number} [readyState=WebSocket.OPEN]
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
 * @param {{ send: jest.Mock }} mockWs
 */
function lastSent(mockWs) {
  const calls = mockWs.send.mock.calls;
  if (calls.length === 0) return null;
  return JSON.parse(calls[calls.length - 1][0]);
}

/**
 * Collect all parsed payloads sent to a mock WS.
 * @param {{ send: jest.Mock }} mockWs
 */
function allSent(mockWs) {
  return mockWs.send.mock.calls.map((c) => JSON.parse(c[0]));
}

/**
 * Build a chainable Supabase mock.
 * Supports .from().select().eq().maybeSingle() and .from().update().eq()
 * @param {{ room?: Object|null, updateError?: Object|null }} options
 */
function buildMockSupabase({ room = null, updateError = null } = {}) {
  const maybeSingle = jest.fn().mockResolvedValue({ data: room, error: null });
  const selectChain = { eq: null, maybeSingle };
  const updateResult = jest.fn().mockResolvedValue({ error: updateError });
  const updateChain  = { eq: updateResult };
  const updateFn     = jest.fn().mockReturnValue(updateChain);
  const selectFn     = jest.fn().mockReturnValue(selectChain);
  selectChain.eq     = jest.fn().mockReturnValue(selectChain);

  const from = jest.fn((table) => {
    if (table === 'rooms') {
      return { select: selectFn, update: updateFn };
    }
    return { select: selectFn, update: updateFn };
  });

  return {
    from,
    auth: { getUser: jest.fn() },
    _maybeSingle:  maybeSingle,
    _updateResult: updateResult,
    _updateFn:     updateFn,
  };
}

/**
 * Build a mock game socket server with a createGame spy.
 * @param {Object} [gameStateOverride]
 */
function buildMockGameServer(gameStateOverride = {}) {
  const gameState = {
    roomCode:            'ABCDEF',
    status:              'active',
    currentTurnPlayerId: 'player-1',
    players: [
      { playerId: 'player-1', isBot: false, teamId: 1, seatIndex: 0 },
    ],
    ...gameStateOverride,
  };
  return {
    createGame: jest.fn().mockReturnValue(gameState),
    scheduleBotTurnIfNeeded: jest.fn(),
    _gameState: gameState,
  };
}

// ---------------------------------------------------------------------------
// Test-fixture constants
// ---------------------------------------------------------------------------

const ROOM_CODE   = 'ABCDEF';
const HOST_ID     = 'host-user-id';
const PLAYER_ID   = 'player-two-id';
const SPECTATOR_ID = 'spectator-user-id';

/** A valid waiting room returned by Supabase. */
const waitingRoom = {
  id:                   'room-uuid-abc',
  code:                 ROOM_CODE,
  host_user_id:         HOST_ID,
  status:               'waiting',
  player_count:         6,
  card_removal_variant: 'remove_7s',
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a client Map with one host and one other player on opposite teams. */
function buildClientsMap(hostWs, playerWs) {
  const clients = new Map();
  clients.set(HOST_ID,   { ws: hostWs,   userId: HOST_ID,   displayName: 'Host',   isGuest: false, isHost: true,  teamId: 1 });
  clients.set(PLAYER_ID, { ws: playerWs, userId: PLAYER_ID, displayName: 'Player', isGuest: true,  isHost: false, teamId: 2 });
  return clients;
}

// ---------------------------------------------------------------------------
// Module under test (reset between suites via jest.resetModules)
// ---------------------------------------------------------------------------

let handleStartGame;
let buildOccupiedSeats;
let roomClients;
let roomMeta;
let _setSupabaseClientFactory;
let _setGameServer;
let _resetRoomState;
let broadcast;

beforeEach(() => {
  jest.resetModules();

  // Re-require after reset so each test gets fresh module state.
  ({
    handleStartGame,
    buildOccupiedSeats,
    roomClients,
    roomMeta,
    _setSupabaseClientFactory,
    _setGameServer,
    _resetRoomState,
    broadcast,
  } = require('../ws/roomSocketServer'));
});

afterEach(() => {
  _resetRoomState();
});

// ===========================================================================
// buildOccupiedSeats — pure helper, no async
// ===========================================================================

describe('buildOccupiedSeats', () => {
  it('assigns T1 players to even seat indices (0, 2, 4)', () => {
    const clients = new Map([
      ['p1', { userId: 'p1', displayName: 'P1', isGuest: false, isHost: true,  teamId: 1 }],
      ['p2', { userId: 'p2', displayName: 'P2', isGuest: false, isHost: false, teamId: 1 }],
      ['p3', { userId: 'p3', displayName: 'P3', isGuest: false, isHost: false, teamId: 1 }],
    ]);

    const seats = buildOccupiedSeats(clients, 6);

    expect(seats.has(0)).toBe(true);
    expect(seats.has(2)).toBe(true);
    expect(seats.has(4)).toBe(true);
    expect(seats.get(0).playerId).toBe('p1');
    expect(seats.get(2).playerId).toBe('p2');
    expect(seats.get(4).playerId).toBe('p3');
  });

  it('assigns T2 players to odd seat indices (1, 3, 5)', () => {
    const clients = new Map([
      ['p1', { userId: 'p1', displayName: 'P1', isGuest: false, isHost: false, teamId: 2 }],
      ['p2', { userId: 'p2', displayName: 'P2', isGuest: false, isHost: false, teamId: 2 }],
      ['p3', { userId: 'p3', displayName: 'P3', isGuest: false, isHost: false, teamId: 2 }],
    ]);

    const seats = buildOccupiedSeats(clients, 6);

    expect(seats.has(1)).toBe(true);
    expect(seats.has(3)).toBe(true);
    expect(seats.has(5)).toBe(true);
    expect(seats.get(1).playerId).toBe('p1');
    expect(seats.get(3).playerId).toBe('p2');
    expect(seats.get(5).playerId).toBe('p3');
  });

  it('seats have correct teamId values (1 or 2)', () => {
    const clients = new Map([
      ['h', { userId: 'h', displayName: 'Host', isGuest: false, isHost: true,  teamId: 1 }],
      ['p', { userId: 'p', displayName: 'P',    isGuest: true,  isHost: false, teamId: 2 }],
    ]);

    const seats = buildOccupiedSeats(clients, 6);

    expect(seats.get(0).teamId).toBe(1);
    expect(seats.get(1).teamId).toBe(2);
  });

  it('caps team membership at playerCount/2 per team', () => {
    // 4 T1 players but max is 3 (6/2)
    const clients = new Map([
      ['p1', { userId: 'p1', displayName: 'P1', isGuest: false, isHost: false, teamId: 1 }],
      ['p2', { userId: 'p2', displayName: 'P2', isGuest: false, isHost: false, teamId: 1 }],
      ['p3', { userId: 'p3', displayName: 'P3', isGuest: false, isHost: false, teamId: 1 }],
      ['p4', { userId: 'p4', displayName: 'P4', isGuest: false, isHost: false, teamId: 1 }], // overflow
    ]);

    const seats = buildOccupiedSeats(clients, 6);

    // Only first 3 T1 players assigned seats
    expect(seats.size).toBe(3);
    expect(seats.has(0)).toBe(true);
    expect(seats.has(2)).toBe(true);
    expect(seats.has(4)).toBe(true);
    expect(seats.has(6)).toBe(false);  // would be 4th T1 seat — out of range
  });

  it('returns empty Map when clients Map is empty', () => {
    const seats = buildOccupiedSeats(new Map(), 6);
    expect(seats.size).toBe(0);
  });

  it('sets isBot: false for all entries', () => {
    const clients = new Map([
      ['p1', { userId: 'p1', displayName: 'P1', isGuest: false, isHost: true,  teamId: 1 }],
      ['p2', { userId: 'p2', displayName: 'P2', isGuest: true,  isHost: false, teamId: 2 }],
    ]);
    const seats = buildOccupiedSeats(clients, 6);
    for (const seat of seats.values()) {
      expect(seat.isBot).toBe(false);
    }
  });
});

// ===========================================================================
// handleStartGame — authorization
// ===========================================================================

describe('handleStartGame — authorization', () => {
  it('rejects non-host with an error message', async () => {
    const ws      = createMockWs();
    const clients = new Map([
      ['not-host', { ws, userId: 'not-host', displayName: 'P', isGuest: true, isHost: false, teamId: 1 }],
    ]);

    await handleStartGame({ ws, userId: 'not-host', isHost: false, roomCode: ROOM_CODE, clients });

    const msg = lastSent(ws);
    expect(msg.type).toBe('error');
    expect(msg.message).toMatch(/only the host/i);
  });

  it('does not call Supabase when requester is not host', async () => {
    const ws      = createMockWs();
    const mockDb  = buildMockSupabase({ room: waitingRoom });
    _setSupabaseClientFactory(() => mockDb);

    await handleStartGame({ ws, userId: 'not-host', isHost: false, roomCode: ROOM_CODE, clients: new Map() });

    // fetchRoomMetaFull should never be called
    expect(mockDb.from).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// handleStartGame — room validation
// ===========================================================================

describe('handleStartGame — room validation', () => {
  it('returns an error when the room is not found in Supabase', async () => {
    const ws     = createMockWs();
    const mockDb = buildMockSupabase({ room: null });
    _setSupabaseClientFactory(() => mockDb);

    await handleStartGame({ ws, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients: new Map() });

    const msg = lastSent(ws);
    expect(msg.type).toBe('error');
    expect(msg.message).toMatch(/not found/i);
  });

  it('returns an error when the room status is not "waiting"', async () => {
    const ws     = createMockWs();
    const mockDb = buildMockSupabase({
      room: { ...waitingRoom, status: 'in_progress' },
    });
    _setSupabaseClientFactory(() => mockDb);

    await handleStartGame({ ws, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients: new Map() });

    const msg = lastSent(ws);
    expect(msg.type).toBe('error');
    expect(msg.message).toMatch(/already started|no longer active|waiting/i);
  });

  it('returns an error when the room status is "starting"', async () => {
    const ws     = createMockWs();
    const mockDb = buildMockSupabase({
      room: { ...waitingRoom, status: 'starting' },
    });
    _setSupabaseClientFactory(() => mockDb);

    await handleStartGame({ ws, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients: new Map() });

    const msg = lastSent(ws);
    expect(msg.type).toBe('error');
    expect(msg.message).toMatch(/already started|no longer active|waiting/i);
  });
});

// ===========================================================================
// handleStartGame — game creation and broadcast
// ===========================================================================

describe('handleStartGame — game creation and broadcast', () => {
  it('calls gameServer.createGame with correct roomCode, roomId, variant, and playerCount', async () => {
    const hostWs   = createMockWs();
    const playerWs = createMockWs();
    const clients  = buildClientsMap(hostWs, playerWs);

    const mockDb     = buildMockSupabase({ room: waitingRoom });
    const mockGame   = buildMockGameServer({ currentTurnPlayerId: HOST_ID });
    _setSupabaseClientFactory(() => mockDb);
    _setGameServer(mockGame);

    // Seed roomClients so broadcast works
    roomClients.set(ROOM_CODE, clients);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    expect(mockGame.createGame).toHaveBeenCalledTimes(1);
    const args = mockGame.createGame.mock.calls[0][0];
    expect(args.roomCode).toBe(ROOM_CODE);
    expect(args.roomId).toBe(waitingRoom.id);
    expect(args.variant).toBe(waitingRoom.card_removal_variant);
    expect(args.playerCount).toBe(waitingRoom.player_count);
  });

  it('passes the correct seat array to createGame (human + bots fill all seats)', async () => {
    const hostWs   = createMockWs();
    const playerWs = createMockWs();
    const clients  = buildClientsMap(hostWs, playerWs);  // 1 T1, 1 T2 → 4 bot seats

    const mockDb   = buildMockSupabase({ room: waitingRoom });
    const mockGame = buildMockGameServer();
    _setSupabaseClientFactory(() => mockDb);
    _setGameServer(mockGame);

    roomClients.set(ROOM_CODE, clients);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    const { seats } = mockGame.createGame.mock.calls[0][0];
    // 6-player room must have exactly 6 seats
    expect(seats).toHaveLength(6);
    // All seat indices 0-5 must be present
    const idxSet = new Set(seats.map((s) => s.seatIndex));
    for (let i = 0; i < 6; i++) expect(idxSet.has(i)).toBe(true);
  });

  it('updates Supabase room status to "starting"', async () => {
    const hostWs  = createMockWs();
    const clients = new Map([
      [HOST_ID, { ws: hostWs, userId: HOST_ID, displayName: 'Host', isGuest: false, isHost: true, teamId: 1 }],
    ]);

    const mockDb   = buildMockSupabase({ room: waitingRoom });
    const mockGame = buildMockGameServer();
    _setSupabaseClientFactory(() => mockDb);
    _setGameServer(mockGame);

    roomClients.set(ROOM_CODE, clients);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    expect(mockDb._updateFn).toHaveBeenCalledWith({ status: 'starting' });
  });

  it('broadcasts "lobby-starting" to ALL connected clients including spectators', async () => {
    const hostWs      = createMockWs();
    const playerWs    = createMockWs();
    const spectatorWs = createMockWs();

    const clients = new Map([
      [HOST_ID,      { ws: hostWs,      userId: HOST_ID,      displayName: 'Host',      isGuest: false, isHost: true,  teamId: 1 }],
      [PLAYER_ID,    { ws: playerWs,    userId: PLAYER_ID,    displayName: 'Player',    isGuest: true,  isHost: false, teamId: 2 }],
      [SPECTATOR_ID, { ws: spectatorWs, userId: SPECTATOR_ID, displayName: 'Spectator', isGuest: true,  isHost: false, teamId: 1 }],
    ]);

    const mockDb   = buildMockSupabase({ room: { ...waitingRoom, player_count: 6 } });
    const mockGame = buildMockGameServer();
    _setSupabaseClientFactory(() => mockDb);
    _setGameServer(mockGame);

    roomClients.set(ROOM_CODE, clients);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    // All three clients must receive the lobby-starting message
    const hostMsg      = allSent(hostWs).find((m) => m.type === 'lobby-starting');
    const playerMsg    = allSent(playerWs).find((m) => m.type === 'lobby-starting');
    const spectatorMsg = allSent(spectatorWs).find((m) => m.type === 'lobby-starting');

    expect(hostMsg).toBeDefined();
    expect(playerMsg).toBeDefined();
    expect(spectatorMsg).toBeDefined();
  });

  it('"lobby-starting" broadcast includes seats and botsAdded arrays', async () => {
    const hostWs  = createMockWs();
    const clients = new Map([
      [HOST_ID, { ws: hostWs, userId: HOST_ID, displayName: 'Host', isGuest: false, isHost: true, teamId: 1 }],
    ]);

    const mockDb   = buildMockSupabase({ room: waitingRoom });
    const mockGame = buildMockGameServer();
    _setSupabaseClientFactory(() => mockDb);
    _setGameServer(mockGame);

    roomClients.set(ROOM_CODE, clients);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    const msg = allSent(hostWs).find((m) => m.type === 'lobby-starting');
    expect(Array.isArray(msg.seats)).toBe(true);
    expect(Array.isArray(msg.botsAdded)).toBe(true);
    expect(msg.roomCode).toBe(ROOM_CODE);
  });

  it('"lobby-starting" broadcast includes botsAdded for each empty seat', async () => {
    const hostWs  = createMockWs();
    // Only 1 human player for a 6-seat room → 5 bots expected
    const clients = new Map([
      [HOST_ID, { ws: hostWs, userId: HOST_ID, displayName: 'Host', isGuest: false, isHost: true, teamId: 1 }],
    ]);

    const mockDb   = buildMockSupabase({ room: waitingRoom });
    const mockGame = buildMockGameServer();
    _setSupabaseClientFactory(() => mockDb);
    _setGameServer(mockGame);

    roomClients.set(ROOM_CODE, clients);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    const msg = allSent(hostWs).find((m) => m.type === 'lobby-starting');
    // 1 human + 5 bots = 6 total seats; botsAdded should list 5 player IDs
    expect(msg.botsAdded).toHaveLength(5);
    expect(msg.seats).toHaveLength(6);
  });

  it('returns an error (no broadcast) when createGame throws', async () => {
    const hostWs  = createMockWs();
    const clients = new Map([
      [HOST_ID, { ws: hostWs, userId: HOST_ID, displayName: 'Host', isGuest: false, isHost: true, teamId: 1 }],
    ]);

    const mockDb   = buildMockSupabase({ room: waitingRoom });
    const mockGame = { createGame: jest.fn().mockImplementation(() => { throw new Error('deck error'); }) };
    _setSupabaseClientFactory(() => mockDb);
    _setGameServer(mockGame);

    roomClients.set(ROOM_CODE, clients);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    const msgs = allSent(hostWs);
    const errMsg   = msgs.find((m) => m.type === 'error');
    const startMsg = msgs.find((m) => m.type === 'lobby-starting');

    expect(errMsg).toBeDefined();
    expect(startMsg).toBeUndefined();
  });

  it('returns an error (no broadcast) when Supabase update fails', async () => {
    const hostWs  = createMockWs();
    const clients = new Map([
      [HOST_ID, { ws: hostWs, userId: HOST_ID, displayName: 'Host', isGuest: false, isHost: true, teamId: 1 }],
    ]);

    const mockDb   = buildMockSupabase({ room: waitingRoom, updateError: { message: 'DB write failed' } });
    const mockGame = buildMockGameServer();
    _setSupabaseClientFactory(() => mockDb);
    _setGameServer(mockGame);

    roomClients.set(ROOM_CODE, clients);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    const msgs      = allSent(hostWs);
    const errMsg    = msgs.find((m) => m.type === 'error');
    const startMsg  = msgs.find((m) => m.type === 'lobby-starting');

    expect(errMsg).toBeDefined();
    expect(startMsg).toBeUndefined();
  });
});

// ===========================================================================
// handleStartGame — 8-player room
// ===========================================================================

describe('handleStartGame — 8-player room', () => {
  const eightPlayerRoom = {
    ...waitingRoom,
    player_count:         8,
    card_removal_variant: 'remove_2s',
  };

  it('creates a game with 8 seats when player_count is 8', async () => {
    const hostWs  = createMockWs();
    const clients = new Map([
      [HOST_ID, { ws: hostWs, userId: HOST_ID, displayName: 'Host', isGuest: false, isHost: true, teamId: 1 }],
    ]);

    const mockDb   = buildMockSupabase({ room: eightPlayerRoom });
    const mockGame = buildMockGameServer();
    _setSupabaseClientFactory(() => mockDb);
    _setGameServer(mockGame);

    roomClients.set(ROOM_CODE, clients);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    const { seats, playerCount } = mockGame.createGame.mock.calls[0][0];
    expect(playerCount).toBe(8);
    expect(seats).toHaveLength(8);
  });

  it('passes the correct variant to createGame', async () => {
    const hostWs  = createMockWs();
    const clients = new Map([
      [HOST_ID, { ws: hostWs, userId: HOST_ID, displayName: 'Host', isGuest: false, isHost: true, teamId: 1 }],
    ]);

    const mockDb   = buildMockSupabase({ room: eightPlayerRoom });
    const mockGame = buildMockGameServer();
    _setSupabaseClientFactory(() => mockDb);
    _setGameServer(mockGame);

    roomClients.set(ROOM_CODE, clients);

    await handleStartGame({ ws: hostWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    expect(mockGame.createGame.mock.calls[0][0].variant).toBe('remove_2s');
  });
});

// ===========================================================================
// handleStartGame — full lobby (no bots needed)
// ===========================================================================

describe('handleStartGame — fully occupied 6-player lobby', () => {
  function buildFullLobby() {
    const wsList = Array.from({ length: 6 }, () => createMockWs());
    const clients = new Map([
      ['u0', { ws: wsList[0], userId: 'u0', displayName: 'P0', isGuest: false, isHost: true,  teamId: 1 }],
      ['u1', { ws: wsList[1], userId: 'u1', displayName: 'P1', isGuest: true,  isHost: false, teamId: 2 }],
      ['u2', { ws: wsList[2], userId: 'u2', displayName: 'P2', isGuest: true,  isHost: false, teamId: 1 }],
      ['u3', { ws: wsList[3], userId: 'u3', displayName: 'P3', isGuest: true,  isHost: false, teamId: 2 }],
      ['u4', { ws: wsList[4], userId: 'u4', displayName: 'P4', isGuest: true,  isHost: false, teamId: 1 }],
      ['u5', { ws: wsList[5], userId: 'u5', displayName: 'P5', isGuest: true,  isHost: false, teamId: 2 }],
    ]);
    return { clients, wsList };
  }

  it('botsAdded is empty when lobby is full', async () => {
    const { clients, wsList } = buildFullLobby();

    const mockDb   = buildMockSupabase({ room: waitingRoom });
    const mockGame = buildMockGameServer({ currentTurnPlayerId: 'u0' });
    _setSupabaseClientFactory(() => mockDb);
    _setGameServer(mockGame);

    roomClients.set(ROOM_CODE, clients);

    await handleStartGame({ ws: wsList[0], userId: 'u0', isHost: true, roomCode: ROOM_CODE, clients });

    const msg = allSent(wsList[0]).find((m) => m.type === 'lobby-starting');
    expect(msg.botsAdded).toHaveLength(0);
    expect(msg.seats).toHaveLength(6);
  });

  it('all 6 clients receive "lobby-starting" when the lobby is full', async () => {
    const { clients, wsList } = buildFullLobby();

    const mockDb   = buildMockSupabase({ room: waitingRoom });
    const mockGame = buildMockGameServer({ currentTurnPlayerId: 'u0' });
    _setSupabaseClientFactory(() => mockDb);
    _setGameServer(mockGame);

    roomClients.set(ROOM_CODE, clients);

    await handleStartGame({ ws: wsList[0], userId: 'u0', isHost: true, roomCode: ROOM_CODE, clients });

    for (const ws of wsList) {
      const msg = allSent(ws).find((m) => m.type === 'lobby-starting');
      expect(msg).toBeDefined();
    }
  });
});

// ===========================================================================
// handleStartGame — closed / non-OPEN socket filtering
// ===========================================================================

describe('handleStartGame — skips closed WebSocket connections', () => {
  it('does not call send() on a CLOSED WebSocket', async () => {
    const openWs   = createMockWs(WebSocket.OPEN);
    const closedWs = createMockWs(WebSocket.CLOSED);

    const clients = new Map([
      [HOST_ID,   { ws: openWs,   userId: HOST_ID,   displayName: 'Host',   isGuest: false, isHost: true,  teamId: 1 }],
      [PLAYER_ID, { ws: closedWs, userId: PLAYER_ID, displayName: 'Player', isGuest: true,  isHost: false, teamId: 2 }],
    ]);

    const mockDb   = buildMockSupabase({ room: waitingRoom });
    const mockGame = buildMockGameServer();
    _setSupabaseClientFactory(() => mockDb);
    _setGameServer(mockGame);

    roomClients.set(ROOM_CODE, clients);

    await handleStartGame({ ws: openWs, userId: HOST_ID, isHost: true, roomCode: ROOM_CODE, clients });

    // Open client gets lobby-starting
    const openMsg = allSent(openWs).find((m) => m.type === 'lobby-starting');
    expect(openMsg).toBeDefined();

    // Closed client must NOT get send() called after game start
    const closedStartMsg = allSent(closedWs).find((m) => m.type === 'lobby-starting');
    expect(closedStartMsg).toBeUndefined();
  });
});
