'use strict';

/**
 * Tests for Sub-AC 5.2: Backend game-start validation and processing.
 *
 * Covers:
 *   1. validateStartGame() — pure validation function
 *   2. buildSeatsFromClients() — seat-descriptor builder
 *   3. handleStartGame() WebSocket handler — via direct invocation
 *   4. POST /api/rooms/:code/start REST endpoint — via supertest
 *
 * All Supabase calls are mocked.  No real DB or network connections are made.
 *
 * NOTE on mock design:
 *   The Supabase chain mock is built so that:
 *     select → eq → maybeSingle  (terminal call)
 *     update → eq                 (eq itself is awaited; default returns chain,
 *                                  `await chain` resolves to chain with no .error,
 *                                  so the `if (error)` check passes cleanly)
 *   We never call `eq.mockResolvedValue()` because that overrides eq to return a
 *   Promise instead of the chain, breaking the SELECT.eq.maybeSingle pipeline.
 */

const request = require('supertest');

// ── Supabase mock factory ─────────────────────────────────────────────────────

function buildMockSupabase() {
  const maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
  const single      = jest.fn().mockResolvedValue({ data: null, error: null });
  const select      = jest.fn();
  const eq          = jest.fn();
  const insert      = jest.fn();
  const update      = jest.fn();
  const inFn        = jest.fn();
  const order       = jest.fn();
  const limit       = jest.fn();

  // Build the fluent chain — eq returns the chain by default so callers can
  // either keep chaining (select + eq + maybeSingle) or await directly (update + eq).
  const chain = { select, eq, maybeSingle, single, in: inFn, insert, update, order, limit };
  select.mockReturnValue(chain);
  eq.mockReturnValue(chain);
  inFn.mockReturnValue(chain);
  insert.mockReturnValue(chain);
  update.mockReturnValue(chain);
  order.mockReturnValue(chain);
  limit.mockReturnValue(chain);

  const from = jest.fn().mockReturnValue(chain);

  return {
    from,
    auth: { getUser: jest.fn() },
    rpc:  jest.fn().mockResolvedValue({ data: null, error: null }),
    _chain: chain,
  };
}

// ── WS mock helpers ──────────────────────────────────────────────────────────

function createMockWs(readyState = 1 /* OPEN */) {
  return { readyState, send: jest.fn(), close: jest.fn() };
}

function lastSent(mockWs) {
  const calls = mockWs.send.mock.calls;
  if (!calls.length) return null;
  return JSON.parse(calls[calls.length - 1][0]);
}

function allSent(mockWs) {
  return mockWs.send.mock.calls.map((c) => JSON.parse(c[0]));
}

// ── Fake room DB record ───────────────────────────────────────────────────────

function makeFakeRoom(overrides = {}) {
  return {
    id:                   'room-id-001',
    status:               'waiting',
    player_count:         6,
    card_removal_variant: 'remove_7s',
    host_user_id:         'host-user-id',
    ...overrides,
  };
}

// ── Fake game state returned by createGame mock ───────────────────────────────

function makeFakeGameState(overrides = {}) {
  return {
    roomCode:            'ABCDEF',
    status:              'active',
    currentTurnPlayerId: 'player-1',
    players: [
      { playerId: 'player-1', teamId: 1, isBot: false },
    ],
    ...overrides,
  };
}

// =============================================================================
// 1. validateStartGame() — pure validation
// =============================================================================

describe('validateStartGame()', () => {
  let validateStartGame;

  beforeEach(() => {
    jest.resetModules();
    ({ validateStartGame } = require('../ws/roomSocketServer'));
  });

  it('returns valid: true when teams are balanced and player count is within limits', () => {
    const clients = new Map([
      ['u1', { teamId: 1 }],
      ['u2', { teamId: 2 }],
      ['u3', { teamId: 1 }],
      ['u4', { teamId: 2 }],
    ]);
    expect(validateStartGame(clients, 6).valid).toBe(true);
  });

  it('returns valid: true for a single player (host alone) in a 6-player room', () => {
    const clients = new Map([
      ['u1', { teamId: 1 }],
    ]);
    expect(validateStartGame(clients, 6).valid).toBe(true);
  });

  it('returns NO_PLAYERS error when clients is empty', () => {
    const result = validateStartGame(new Map(), 6);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('NO_PLAYERS');
    expect(result.error).toMatch(/at least one player/i);
  });

  it('returns TOO_MANY_PLAYERS when humanCount > playerCount', () => {
    const clients = new Map();
    for (let i = 0; i < 7; i++) {
      clients.set(`u${i}`, { teamId: i % 2 === 0 ? 1 : 2 });
    }
    const result = validateStartGame(clients, 6);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('TOO_MANY_PLAYERS');
    expect(result.error).toMatch(/7.*6/);
  });

  it('returns TEAM_IMBALANCED when team 1 has more than playerCount/2 players (6-player game)', () => {
    const clients = new Map([
      ['u1', { teamId: 1 }],
      ['u2', { teamId: 1 }],
      ['u3', { teamId: 1 }],
      ['u4', { teamId: 1 }],
    ]);
    const result = validateStartGame(clients, 6);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('TEAM_IMBALANCED');
    expect(result.error).toMatch(/team 1/i);
  });

  it('returns TEAM_IMBALANCED when team 2 has more than playerCount/2 players', () => {
    const clients = new Map([
      ['u1', { teamId: 2 }],
      ['u2', { teamId: 2 }],
      ['u3', { teamId: 2 }],
      ['u4', { teamId: 2 }],
    ]);
    const result = validateStartGame(clients, 6);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('TEAM_IMBALANCED');
    expect(result.error).toMatch(/team 2/i);
  });

  it('allows exactly playerCount/2 players on each team (6-player, 3+3)', () => {
    const clients = new Map([
      ['u1', { teamId: 1 }],
      ['u2', { teamId: 2 }],
      ['u3', { teamId: 1 }],
      ['u4', { teamId: 2 }],
      ['u5', { teamId: 1 }],
      ['u6', { teamId: 2 }],
    ]);
    expect(validateStartGame(clients, 6).valid).toBe(true);
  });

  it('allows exactly playerCount/2 players on each team (8-player, 4+4)', () => {
    const clients = new Map();
    for (let i = 0; i < 8; i++) {
      clients.set(`u${i}`, { teamId: i < 4 ? 1 : 2 });
    }
    expect(validateStartGame(clients, 8).valid).toBe(true);
  });

  it('returns TEAM_IMBALANCED when team 1 exceeds max in 8-player room (5 on team 1)', () => {
    const clients = new Map();
    for (let i = 0; i < 5; i++) clients.set(`u${i}`, { teamId: 1 });
    const result = validateStartGame(clients, 8);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('TEAM_IMBALANCED');
  });

  it('error message contains playerCount for context', () => {
    const clients = new Map([
      ['u1', { teamId: 1 }],
      ['u2', { teamId: 1 }],
      ['u3', { teamId: 1 }],
      ['u4', { teamId: 1 }],
    ]);
    const result = validateStartGame(clients, 6);
    expect(result.error).toContain('6-player');
  });

  it('handles equal teams at 1+1 in a 6-player room (valid)', () => {
    const clients = new Map([
      ['u1', { teamId: 1 }],
      ['u2', { teamId: 2 }],
    ]);
    expect(validateStartGame(clients, 6).valid).toBe(true);
  });
});

// =============================================================================
// 2. buildSeatsFromClients()
// =============================================================================

describe('buildSeatsFromClients()', () => {
  let buildSeatsFromClients;

  beforeEach(() => {
    jest.resetModules();
    ({ buildSeatsFromClients } = require('../ws/roomSocketServer'));
  });

  it('assigns even seat indices to team 1 players', () => {
    const clients = new Map([
      ['u1', { userId: 'u1', displayName: 'Alice', isGuest: false, teamId: 1 }],
      ['u2', { userId: 'u2', displayName: 'Bob',   isGuest: false, teamId: 2 }],
    ]);
    const seats = buildSeatsFromClients(clients, 6);
    const aliceSeat = seats.find((s) => s.playerId === 'u1');
    const bobSeat   = seats.find((s) => s.playerId === 'u2');
    expect(aliceSeat.seatIndex % 2).toBe(0); // even → team 1
    expect(bobSeat.seatIndex % 2).toBe(1);   // odd  → team 2
  });

  it('returns seats sorted by seatIndex ascending', () => {
    const clients = new Map([
      ['u1', { userId: 'u1', displayName: 'A', isGuest: false, teamId: 1 }],
      ['u2', { userId: 'u2', displayName: 'B', isGuest: false, teamId: 2 }],
      ['u3', { userId: 'u3', displayName: 'C', isGuest: false, teamId: 1 }],
      ['u4', { userId: 'u4', displayName: 'D', isGuest: false, teamId: 2 }],
    ]);
    const seats = buildSeatsFromClients(clients, 6);
    for (let i = 1; i < seats.length; i++) {
      expect(seats[i].seatIndex).toBeGreaterThan(seats[i - 1].seatIndex);
    }
  });

  it('each seat has isBot=false', () => {
    const clients = new Map([
      ['u1', { userId: 'u1', displayName: 'A', isGuest: false, teamId: 1 }],
    ]);
    const seats = buildSeatsFromClients(clients, 6);
    expect(seats.every((s) => s.isBot === false)).toBe(true);
  });

  it('preserves teamId and isGuest on each seat', () => {
    const clients = new Map([
      ['u1', { userId: 'u1', displayName: 'A', isGuest: true,  teamId: 1 }],
      ['u2', { userId: 'u2', displayName: 'B', isGuest: false, teamId: 2 }],
    ]);
    const seats = buildSeatsFromClients(clients, 6);
    const s1 = seats.find((s) => s.playerId === 'u1');
    const s2 = seats.find((s) => s.playerId === 'u2');
    expect(s1.teamId).toBe(1);
    expect(s1.isGuest).toBe(true);
    expect(s2.teamId).toBe(2);
    expect(s2.isGuest).toBe(false);
  });

  it('returns empty array when clients is empty', () => {
    expect(buildSeatsFromClients(new Map(), 6)).toEqual([]);
  });
});

// =============================================================================
// 3. handleStartGame() WebSocket handler
// =============================================================================

describe('handleStartGame() WS handler', () => {
  let handleStartGame;
  let roomClients;
  let roomMeta;
  let _resetRoomState;
  let _setSupabaseClientFactory;
  let _setGameServer;
  let mockSupabase;
  let mockGameServer;

  /**
   * Seed the module-level roomClients with players.
   * broadcast() reads from roomClients directly, so the map must be
   * populated at the module level for broadcasts to reach test WS mocks.
   *
   * @param {string} roomCode
   * @param {number} playerCount
   * @param {Array}  entries
   * @returns {Map}
   */
  function seedRoomInStore(roomCode, playerCount, entries) {
    if (!roomClients.has(roomCode)) roomClients.set(roomCode, new Map());
    if (!roomMeta.has(roomCode))    roomMeta.set(roomCode, { playerCount });
    const clients = roomClients.get(roomCode);
    for (const e of entries) {
      clients.set(e.userId, { ...e, ws: e.ws || createMockWs() });
    }
    return clients;
  }

  beforeEach(() => {
    jest.resetModules();
    mockSupabase = buildMockSupabase();

    ({
      handleStartGame,
      roomClients,
      roomMeta,
      _resetRoomState,
      _setSupabaseClientFactory,
      _setGameServer,
    } = require('../ws/roomSocketServer'));

    _resetRoomState();
    _setSupabaseClientFactory(() => mockSupabase);

    mockGameServer = {
      createGame:              jest.fn().mockReturnValue(makeFakeGameState()),
      scheduleBotTurnIfNeeded: jest.fn(),
    };
    _setGameServer(mockGameServer);
  });

  afterEach(() => {
    jest.clearAllMocks();
    _setSupabaseClientFactory(null);
    _setGameServer(null);
  });

  // ── Authorization ─────────────────────────────────────────────────────────

  it('sends error when requester is not the host', async () => {
    const ws   = createMockWs();
    const code = 'ROOM01';
    const clients = new Map([
      ['user-1', { userId: 'user-1', displayName: 'Alice', isGuest: false, isHost: false, teamId: 1, ws: createMockWs() }],
    ]);

    await handleStartGame({ ws, userId: 'user-1', isHost: false, roomCode: code, clients });

    const msg = lastSent(ws);
    expect(msg.type).toBe('error');
    expect(msg.message).toMatch(/host/i);
  });

  // ── Room status guard ──────────────────────────────────────────────────────

  it('sends ROOM_NOT_WAITING error when room is not in waiting status', async () => {
    const ws   = createMockWs();
    const code = 'ROOM02';

    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeFakeRoom({ status: 'in_progress', host_user_id: 'host-id' }),
      error: null,
    });

    const clients = new Map([
      ['host-id', { userId: 'host-id', displayName: 'Host', isGuest: false, isHost: true, teamId: 1, ws: createMockWs() }],
    ]);

    await handleStartGame({ ws, userId: 'host-id', isHost: true, roomCode: code, clients });

    const msg = lastSent(ws);
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('ROOM_NOT_WAITING');
  });

  it('sends error when room is not found in DB', async () => {
    const ws   = createMockWs();
    const code = 'ROOM03';

    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const clients = new Map([
      ['host-id', { userId: 'host-id', displayName: 'Host', isGuest: false, isHost: true, teamId: 1, ws: createMockWs() }],
    ]);

    await handleStartGame({ ws, userId: 'host-id', isHost: true, roomCode: code, clients });

    expect(lastSent(ws).type).toBe('error');
  });

  // ── Validation ────────────────────────────────────────────────────────────

  it('sends NO_PLAYERS error when clients map is empty', async () => {
    const ws   = createMockWs();
    const code = 'ROOM04';

    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeFakeRoom({ host_user_id: 'host-id' }),
      error: null,
    });

    await handleStartGame({ ws, userId: 'host-id', isHost: true, roomCode: code, clients: new Map() });

    const msg = lastSent(ws);
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('NO_PLAYERS');
  });

  it('sends TEAM_IMBALANCED error when team 1 exceeds playerCount/2', async () => {
    const ws   = createMockWs();
    const code = 'ROOM05';

    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeFakeRoom({ host_user_id: 'h1', player_count: 6 }),
      error: null,
    });

    // 4 players on team 1, 0 on team 2 — max is 3 per team
    const clients = new Map([
      ['h1', { userId: 'h1', teamId: 1, isHost: true }],
      ['u2', { userId: 'u2', teamId: 1, isHost: false }],
      ['u3', { userId: 'u3', teamId: 1, isHost: false }],
      ['u4', { userId: 'u4', teamId: 1, isHost: false }],
    ]);

    await handleStartGame({ ws, userId: 'h1', isHost: true, roomCode: code, clients });

    const msg = lastSent(ws);
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('TEAM_IMBALANCED');
    expect(msg.message).toMatch(/team 1/i);
  });

  it('sends TEAM_IMBALANCED error when team 2 exceeds playerCount/2', async () => {
    const ws   = createMockWs();
    const code = 'ROOM06';

    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeFakeRoom({ host_user_id: 'h1', player_count: 6 }),
      error: null,
    });

    const clients = new Map([
      ['h1', { userId: 'h1', teamId: 1 }],
      ['u2', { userId: 'u2', teamId: 2 }],
      ['u3', { userId: 'u3', teamId: 2 }],
      ['u4', { userId: 'u4', teamId: 2 }],
      ['u5', { userId: 'u5', teamId: 2 }],
    ]);

    await handleStartGame({ ws, userId: 'h1', isHost: true, roomCode: code, clients });

    const msg = lastSent(ws);
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('TEAM_IMBALANCED');
    expect(msg.message).toMatch(/team 2/i);
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it('broadcasts game_starting on valid start (1 human, 5 bots in 6-player room)', async () => {
    const code    = 'ROOM07';
    const hostWs  = createMockWs();

    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeFakeRoom({ host_user_id: 'host-id', player_count: 6 }),
      error: null,
    });

    // Populate module-level roomClients so broadcast() can reach the host ws
    const clients = seedRoomInStore(code, 6, [
      { userId: 'host-id', displayName: 'Host', isGuest: false, isHost: true, teamId: 1, ws: hostWs },
    ]);

    await handleStartGame({ ws: hostWs, userId: 'host-id', isHost: true, roomCode: code, clients });

    const sentMsgs = allSent(hostWs);
    const startMsg = sentMsgs.find((m) => m.type === 'lobby-starting');
    expect(startMsg).toBeDefined();
    expect(startMsg.roomCode).toBe(code);
    expect(Array.isArray(startMsg.seats)).toBe(true);
    expect(startMsg.seats).toHaveLength(6);
    expect(startMsg.botsAdded).toHaveLength(5); // 1 human + 5 bots
  });

  it('broadcasts game_starting with correct seat count for 8-player room', async () => {
    const code   = 'ROOM08';
    const hostWs = createMockWs();
    const p2Ws   = createMockWs();

    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeFakeRoom({ host_user_id: 'host-id', player_count: 8 }),
      error: null,
    });

    const clients = seedRoomInStore(code, 8, [
      { userId: 'host-id', displayName: 'Host', isGuest: false, isHost: true,  teamId: 1, ws: hostWs },
      { userId: 'u2',      displayName: 'P2',   isGuest: false, isHost: false, teamId: 2, ws: p2Ws  },
    ]);

    await handleStartGame({ ws: hostWs, userId: 'host-id', isHost: true, roomCode: code, clients });

    const startMsg = allSent(hostWs).find((m) => m.type === 'lobby-starting');
    expect(startMsg).toBeDefined();
    expect(startMsg.seats).toHaveLength(8);
    expect(startMsg.botsAdded).toHaveLength(6); // 2 humans + 6 bots
  });

  it('calls createGame with correct roomId and variant from DB', async () => {
    const code   = 'ROOM09';
    const hostWs = createMockWs();
    const fakeRoom = makeFakeRoom({
      host_user_id:         'host-id',
      id:                   'room-uuid-123',
      card_removal_variant: 'remove_2s',
      player_count:         6,
    });

    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({ data: fakeRoom, error: null });

    const clients = seedRoomInStore(code, 6, [
      { userId: 'host-id', displayName: 'Host', isGuest: false, isHost: true, teamId: 1, ws: hostWs },
    ]);

    await handleStartGame({ ws: hostWs, userId: 'host-id', isHost: true, roomCode: code, clients });

    expect(mockGameServer.createGame).toHaveBeenCalledWith(
      expect.objectContaining({
        roomCode:    code,
        roomId:      'room-uuid-123',
        variant:     'remove_2s',
        playerCount: 6,
      }),
    );
  });

  it('game_starting seats include both human and bot entries', async () => {
    const code   = 'ROOM10';
    const hostWs = createMockWs();
    const p2Ws   = createMockWs();

    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeFakeRoom({ host_user_id: 'h1', player_count: 6 }),
      error: null,
    });

    const clients = seedRoomInStore(code, 6, [
      { userId: 'h1', displayName: 'Host', isGuest: false, isHost: true,  teamId: 1, ws: hostWs },
      { userId: 'u2', displayName: 'P2',   isGuest: false, isHost: false, teamId: 2, ws: p2Ws  },
    ]);

    await handleStartGame({ ws: hostWs, userId: 'h1', isHost: true, roomCode: code, clients });

    const startMsg = allSent(hostWs).find((m) => m.type === 'lobby-starting');
    expect(startMsg.seats.some((s) => s.isBot === false)).toBe(true);
    expect(startMsg.seats.some((s) => s.isBot === true)).toBe(true);
  });

  it('team 1 seats are even-indexed, team 2 seats are odd-indexed', async () => {
    const code   = 'ROOM11';
    const hostWs = createMockWs();
    const p2Ws   = createMockWs();

    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeFakeRoom({ host_user_id: 'h1', player_count: 6 }),
      error: null,
    });

    const clients = seedRoomInStore(code, 6, [
      { userId: 'h1', displayName: 'Host', isGuest: false, isHost: true,  teamId: 1, ws: hostWs },
      { userId: 'u2', displayName: 'P2',   isGuest: false, isHost: false, teamId: 2, ws: p2Ws  },
    ]);

    await handleStartGame({ ws: hostWs, userId: 'h1', isHost: true, roomCode: code, clients });

    const startMsg = allSent(hostWs).find((m) => m.type === 'lobby-starting');
    expect(startMsg).toBeDefined();
    for (const seat of startMsg.seats) {
      if (seat.teamId === 1) expect(seat.seatIndex % 2).toBe(0);
      if (seat.teamId === 2) expect(seat.seatIndex % 2).toBe(1);
    }
  });

  it('broadcasts game_starting to all connected clients (not just the host)', async () => {
    const code   = 'ROOM12';
    const hostWs = createMockWs();
    const p2Ws   = createMockWs();
    const p3Ws   = createMockWs();

    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeFakeRoom({ host_user_id: 'h1', player_count: 6 }),
      error: null,
    });

    const clients = seedRoomInStore(code, 6, [
      { userId: 'h1', displayName: 'Host', isGuest: false, isHost: true,  teamId: 1, ws: hostWs },
      { userId: 'u2', displayName: 'P2',   isGuest: false, isHost: false, teamId: 2, ws: p2Ws  },
      { userId: 'u3', displayName: 'P3',   isGuest: false, isHost: false, teamId: 1, ws: p3Ws  },
    ]);

    await handleStartGame({ ws: hostWs, userId: 'h1', isHost: true, roomCode: code, clients });

    // All three clients should receive lobby-starting
    for (const clientWs of [hostWs, p2Ws, p3Ws]) {
      const msgs = allSent(clientWs);
      expect(msgs.some((m) => m.type === 'lobby-starting')).toBe(true);
    }
  });
});

// =============================================================================
// 4. POST /api/rooms/:code/start REST endpoint
// =============================================================================

describe('POST /api/rooms/:code/start', () => {
  let app;
  let mockSupabase;
  let mockGameServer;

  beforeEach(() => {
    jest.resetModules();
    mockSupabase = buildMockSupabase();

    // Inject mock BEFORE any module that calls getSupabaseClient()
    const { _setSupabaseClient } = require('../db/supabase');
    _setSupabaseClient(mockSupabase);

    // Load roomSocketServer and inject mocks
    const rss = require('../ws/roomSocketServer');
    rss._setSupabaseClientFactory(() => mockSupabase);
    rss._resetRoomState();

    mockGameServer = {
      createGame:              jest.fn().mockReturnValue(makeFakeGameState()),
      scheduleBotTurnIfNeeded: jest.fn(),
    };
    rss._setGameServer(mockGameServer);

    app = require('../index');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── Auth / host guards ─────────────────────────────────────────────────────

  it('returns 401 when no auth token is provided', async () => {
    const res = await request(app).post('/api/rooms/ABCDEF/start');
    expect(res.status).toBe(401);
  });

  it('returns 404 when room does not exist', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'host-id', email: 'host@test.com', user_metadata: {} } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValue({ data: null, error: null });

    const res = await request(app)
      .post('/api/rooms/NOTFND/start')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/room not found/i);
  });

  it('returns 403 when requester is not the host', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'not-the-host', email: 'other@test.com', user_metadata: {} } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValue({
      data: makeFakeRoom({ host_user_id: 'actual-host-id' }),
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms/ABCDEF/start')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/host/i);
  });

  it('returns 409 when room is not in waiting status', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'host-id', email: 'host@test.com', user_metadata: {} } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValue({
      data: makeFakeRoom({ host_user_id: 'host-id', status: 'in_progress' }),
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms/ABCDEF/start')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ROOM_NOT_WAITING');
  });

  // ── Validation errors ──────────────────────────────────────────────────────

  it('returns 400 NO_PLAYERS when no clients are connected to the room', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'host-id', email: 'host@test.com', user_metadata: {} } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValue({
      data: makeFakeRoom({ host_user_id: 'host-id' }),
      error: null,
    });

    // Ensure no clients are connected for room ABCDEF
    const rss = require('../ws/roomSocketServer');
    rss._resetRoomState();

    const res = await request(app)
      .post('/api/rooms/ABCDEF/start')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_PLAYERS');
  });

  it('returns 400 TEAM_IMBALANCED when team 1 exceeds capacity', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'host-id', email: 'host@test.com', user_metadata: {} } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValue({
      data: makeFakeRoom({ host_user_id: 'host-id', player_count: 6 }),
      error: null,
    });

    // Seed: 4 players on team 1 (max is 3 for 6-player game)
    const rss = require('../ws/roomSocketServer');
    rss._resetRoomState();
    rss.roomClients.set('ABCDEF', new Map([
      ['host-id', { userId: 'host-id', teamId: 1, ws: createMockWs() }],
      ['u2',      { userId: 'u2',      teamId: 1, ws: createMockWs() }],
      ['u3',      { userId: 'u3',      teamId: 1, ws: createMockWs() }],
      ['u4',      { userId: 'u4',      teamId: 1, ws: createMockWs() }],
    ]));

    const res = await request(app)
      .post('/api/rooms/ABCDEF/start')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEAM_IMBALANCED');
  });

  it('returns 400 TEAM_IMBALANCED when team 2 exceeds capacity', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'host-id', email: 'host@test.com', user_metadata: {} } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValue({
      data: makeFakeRoom({ host_user_id: 'host-id', player_count: 6 }),
      error: null,
    });

    // 4 players on team 2 for 6-player room (max 3)
    const rss = require('../ws/roomSocketServer');
    rss._resetRoomState();
    rss.roomClients.set('ABCDEF', new Map([
      ['host-id', { userId: 'host-id', teamId: 1, ws: createMockWs() }],
      ['u2',      { userId: 'u2',      teamId: 2, ws: createMockWs() }],
      ['u3',      { userId: 'u3',      teamId: 2, ws: createMockWs() }],
      ['u4',      { userId: 'u4',      teamId: 2, ws: createMockWs() }],
      ['u5',      { userId: 'u5',      teamId: 2, ws: createMockWs() }],
    ]));

    const res = await request(app)
      .post('/api/rooms/ABCDEF/start')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEAM_IMBALANCED');
  });

  it('returns 400 for invalid room code format (> 6 chars)', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'host-id', email: 'host@test.com', user_metadata: {} } },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms/TOOLONG/start')
      .set('Authorization', 'Bearer valid-token');

    // 'TOOLONG' is 7 characters — fails format check
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid room code format/i);
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it('returns 200 with started=true and full seat list when all conditions are met', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'host-id', email: 'host@test.com', user_metadata: {} } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValue({
      data: makeFakeRoom({ host_user_id: 'host-id', player_count: 6 }),
      error: null,
    });

    // Seed one connected human player
    const rss = require('../ws/roomSocketServer');
    rss._resetRoomState();
    rss.roomClients.set('ABCDEF', new Map([
      ['host-id', {
        userId: 'host-id', displayName: 'Host', isGuest: false,
        isHost: true, teamId: 1, ws: createMockWs(),
      }],
    ]));

    const res = await request(app)
      .post('/api/rooms/ABCDEF/start')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.started).toBe(true);
    expect(res.body.roomCode).toBe('ABCDEF');
    expect(Array.isArray(res.body.seats)).toBe(true);
    expect(res.body.seats).toHaveLength(6);
    expect(Array.isArray(res.body.botsAdded)).toBe(true);
    expect(res.body.botsAdded).toHaveLength(5); // 1 human + 5 bots
  });

  it('returns 200 and 8 seats for an 8-player room', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'host-id', email: 'host@test.com', user_metadata: {} } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValue({
      data: makeFakeRoom({ host_user_id: 'host-id', player_count: 8 }),
      error: null,
    });

    const rss = require('../ws/roomSocketServer');
    rss._resetRoomState();
    rss.roomClients.set('ABCDEF', new Map([
      ['host-id', { userId: 'host-id', displayName: 'Host', isGuest: false, isHost: true,  teamId: 1, ws: createMockWs() }],
      ['u2',      { userId: 'u2',      displayName: 'P2',   isGuest: false, isHost: false, teamId: 2, ws: createMockWs() }],
    ]));

    const res = await request(app)
      .post('/api/rooms/ABCDEF/start')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.seats).toHaveLength(8);
    expect(res.body.botsAdded).toHaveLength(6);
  });

  it('response seats follow alternating team layout (team1→even, team2→odd)', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'host-id', email: 'host@test.com', user_metadata: {} } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValue({
      data: makeFakeRoom({ host_user_id: 'host-id', player_count: 6 }),
      error: null,
    });

    const rss = require('../ws/roomSocketServer');
    rss._resetRoomState();
    rss.roomClients.set('ABCDEF', new Map([
      ['host-id', { userId: 'host-id', displayName: 'Host', isGuest: false, isHost: true, teamId: 1, ws: createMockWs() }],
    ]));

    const res = await request(app)
      .post('/api/rooms/ABCDEF/start')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    for (const seat of res.body.seats) {
      if (seat.teamId === 1) expect(seat.seatIndex % 2).toBe(0);
      if (seat.teamId === 2) expect(seat.seatIndex % 2).toBe(1);
    }
  });
});
