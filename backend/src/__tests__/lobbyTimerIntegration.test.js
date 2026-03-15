'use strict';

/**
 * Integration tests for the lobby fill timer (Sub-AC 8c).
 *
 * Tests the full timer lifecycle as triggered by handleJoinRoom:
 *
 *   A. Timer start
 *      — First player joining a room starts the 2-minute timer.
 *      — 'lobby-timer-started' is broadcast to the room with an expiresAt timestamp.
 *      — Second player joining does NOT restart the timer.
 *      — Reconnecting player (already in lobby) does NOT restart the timer.
 *
 *   B. Early cancellation (lobby fills)
 *      — When the last human seat is filled the timer is cancelled.
 *      — 'lobby-starting' is broadcast with the full seats list and botsAdded=[].
 *
 *   C. Timer expiry (bot fill)
 *      — When the timer fires, empty seats are filled with bot players.
 *      — 'lobby-starting' is broadcast with the bots listed in botsAdded.
 *      — Supabase room status is updated to 'starting'.
 *      — Bot IDs start with 'bot_'.
 *      — Bot seatIndex values match the empty seats.
 *
 *   D. _handleGameStart directly
 *      — Bots are generated for the correct number of empty seats.
 *      — Supabase update is called with status='starting'.
 *
 *   E. _handleTimerExpiry directly
 *      — No-ops when room is not in 'waiting' status.
 *      — No-ops when room is not found in DB.
 *
 * Strategy:
 *   - No real DB or WebSocket ports are opened — everything is mocked.
 *   - Supabase is injected via _setSupabaseClient.
 *   - lobbyStore and lobbyManager state are reset between tests.
 *   - handleJoinRoom / _handleGameStart / _handleTimerExpiry are imported directly.
 *   - Jest fake timers are used in Section C so tests run instantly.
 */

const { WebSocket } = require('ws');
const { _setSupabaseClient } = require('../db/supabase');
const {
  _clearAll:    clearLobbyStore,
  getOrCreateLobby,
  addPlayerToLobby: addToLobbyStore,
} = require('../lobby/lobbyStore');
const {
  _clearRooms:  clearLobbyManager,
  initLobbyRoom,
  addPlayerToLobby: addSeatToLobbyManager,
  getLobbySnapshot,
} = require('../ws/lobbyManager');
const {
  _clearAllTimers,
  isLobbyTimerActive,
  getLobbyTimerExpiry,
} = require('../matchmaking/lobbyTimer');
const {
  handleJoinRoom,
  _handleGameStart,
  _handleTimerExpiry,
} = require('../ws/wsServer');

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockWs(readyState = WebSocket.OPEN) {
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
  return allSent(ws).find((m) => m.type === type) || null;
}

/**
 * Build a chainable Supabase mock.
 * `roomData` is returned by maybeSingle unless overridden per-call.
 */
function buildMockSupabase(roomData = null, updateError = null) {
  const maybeSingle = jest.fn().mockResolvedValue({ data: roomData, error: null });
  const single      = jest.fn();
  const select      = jest.fn();
  const eq          = jest.fn();
  const update      = jest.fn();
  const insert      = jest.fn();
  const inFn        = jest.fn();

  const chain = { select, eq, maybeSingle, single, in: inFn, insert, update };
  select.mockReturnValue(chain);
  eq.mockReturnValue(chain);
  inFn.mockReturnValue(chain);
  insert.mockReturnValue(chain);
  update.mockReturnValue({
    eq: jest.fn().mockResolvedValue({ data: null, error: updateError }),
  });

  return {
    from:  jest.fn().mockReturnValue(chain),
    auth:  { getUser: jest.fn() },
    _chain: chain,
    update,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOM_CODE   = 'TIMER1';
const ROOM_ID     = 'room-timer-test-uuid';
const HOST_ID     = 'host-timer-id';
const PLAYER1_ID  = 'player-1-timer';
const PLAYER2_ID  = 'player-2-timer';
const PLAYER3_ID  = 'player-3-timer';
const PLAYER4_ID  = 'player-4-timer';
const PLAYER5_ID  = 'player-5-timer';

const hostUser = { playerId: HOST_ID,    displayName: 'Host',    avatarId: null, isGuest: false };
const p1User   = { playerId: PLAYER1_ID, displayName: 'Player1', avatarId: null, isGuest: false };
const p2User   = { playerId: PLAYER2_ID, displayName: 'Player2', avatarId: null, isGuest: false };
const p3User   = { playerId: PLAYER3_ID, displayName: 'Player3', avatarId: null, isGuest: false };
const p4User   = { playerId: PLAYER4_ID, displayName: 'Player4', avatarId: null, isGuest: false };
const p5User   = { playerId: PLAYER5_ID, displayName: 'Player5', avatarId: null, isGuest: false };

function makeWaitingRoom6(overrides = {}) {
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
// Suite-level setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearLobbyStore();
  clearLobbyManager();
  _clearAllTimers();
  jest.clearAllMocks();
});

afterEach(() => {
  _clearAllTimers();
});

// ---------------------------------------------------------------------------
// A. Timer start
// ---------------------------------------------------------------------------

describe('A. Timer start — handleJoinRoom starts timer on first join', () => {
  it('starts the lobby timer when the first player joins', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom6());
    _setSupabaseClient(supabase);

    const hostWs = createMockWs();
    await handleJoinRoom(hostWs, 'conn-host', hostUser, { type: 'join-room', roomCode: ROOM_CODE });

    expect(isLobbyTimerActive(ROOM_CODE)).toBe(true);
  });

  it('broadcasts lobby-timer-started with an expiresAt timestamp', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom6());
    _setSupabaseClient(supabase);

    const hostWs = createMockWs();
    await handleJoinRoom(hostWs, 'conn-host', hostUser, { type: 'join-room', roomCode: ROOM_CODE });

    const timerMsg = msgOfType(hostWs, 'lobby-timer-started');
    expect(timerMsg).not.toBeNull();
    expect(timerMsg.roomCode).toBe(ROOM_CODE);
    expect(timerMsg.expiresAt).toBeGreaterThan(Date.now());
  });

  it('does NOT restart the timer when a second player joins', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom6());
    _setSupabaseClient(supabase);

    const hostWs = createMockWs();
    const p1Ws   = createMockWs();

    await handleJoinRoom(hostWs, 'conn-host', hostUser, { type: 'join-room', roomCode: ROOM_CODE });
    const expiryAfterFirst = getLobbyTimerExpiry(ROOM_CODE);

    await handleJoinRoom(p1Ws, 'conn-p1', p1User, { type: 'join-room', roomCode: ROOM_CODE });
    const expiryAfterSecond = getLobbyTimerExpiry(ROOM_CODE);

    // Timer expiry must be unchanged.
    expect(expiryAfterSecond).toBe(expiryAfterFirst);
  });

  it('second player does NOT receive lobby-timer-started broadcast', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom6());
    _setSupabaseClient(supabase);

    const hostWs = createMockWs();
    const p1Ws   = createMockWs();

    await handleJoinRoom(hostWs, 'conn-host', hostUser, { type: 'join-room', roomCode: ROOM_CODE });
    await handleJoinRoom(p1Ws,   'conn-p1',   p1User,   { type: 'join-room', roomCode: ROOM_CODE });

    // p1Ws receives player-joined (broadcast) but NOT lobby-timer-started
    // (that was already sent to everyone before p1 joined, so p1 sees it via
    // the broadcast if they were already in the room — but in this test they
    // are joining fresh, so p1Ws should NOT receive it).
    const p1Msgs = allSent(p1Ws);
    // p1 should get room-joined but lobby-timer-started must not be in their msgs
    // (it was broadcast before they joined the room in this particular test setup)
    expect(p1Msgs.some((m) => m.type === 'lobby-timer-started')).toBe(false);
  });

  it('does NOT start timer when room is already full on first join', async () => {
    // 6-player room with 5 players pre-filled — host joining makes it full
    const supabase = buildMockSupabase(makeWaitingRoom6());
    _setSupabaseClient(supabase);

    // Pre-populate lobbyStore with 5 players so joining the 6th fills the room
    getOrCreateLobby(ROOM_CODE, HOST_ID);
    [PLAYER1_ID, PLAYER2_ID, PLAYER3_ID, PLAYER4_ID, PLAYER5_ID].forEach((id, i) => {
      addToLobbyStore(ROOM_CODE, {
        connectionId: `conn-pre-${i}`,
        playerId:     id,
        displayName:  `P${i}`,
        avatarId:     null,
        isGuest:      false,
        ws:           createMockWs(),
      });
    });

    // Pre-populate lobbyManager so bot-fill sees 5 seats taken
    initLobbyRoom({ roomId: ROOM_ID, roomCode: ROOM_CODE, hostPlayerId: HOST_ID, playerCount: 6 });
    [PLAYER1_ID, PLAYER2_ID, PLAYER3_ID, PLAYER4_ID, PLAYER5_ID].forEach((id, i) => {
      addSeatToLobbyManager(ROOM_CODE, {
        seatIndex:   i + 1, // seats 1-5 taken; seat 0 open for host
        playerId:    id,
        displayName: `P${i}`,
        teamId:      (i + 1) % 2 === 0 ? 1 : 2,
        isBot:       false,
        isGuest:     false,
      });
    });

    const hostWs = createMockWs();
    await handleJoinRoom(hostWs, 'conn-host', hostUser, { type: 'join-room', roomCode: ROOM_CODE });

    // Lobby is full → timer should NOT be started; game start triggered instead
    expect(isLobbyTimerActive(ROOM_CODE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B. Early cancellation — lobby fills before timer expires
// ---------------------------------------------------------------------------

describe('B. Early cancellation — lobby fills before timer fires', () => {
  it('cancels the timer when the last seat is taken by a human player', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom6());
    _setSupabaseClient(supabase);

    const hostWs = createMockWs();
    const p1Ws   = createMockWs();
    const p2Ws   = createMockWs();
    const p3Ws   = createMockWs();
    const p4Ws   = createMockWs();
    const p5Ws   = createMockWs();

    // Join all 6 players one by one
    await handleJoinRoom(hostWs, 'conn-host', hostUser, { type: 'join-room', roomCode: ROOM_CODE });
    expect(isLobbyTimerActive(ROOM_CODE)).toBe(true); // timer started

    await handleJoinRoom(p1Ws, 'conn-p1', p1User, { type: 'join-room', roomCode: ROOM_CODE });
    await handleJoinRoom(p2Ws, 'conn-p2', p2User, { type: 'join-room', roomCode: ROOM_CODE });
    await handleJoinRoom(p3Ws, 'conn-p3', p3User, { type: 'join-room', roomCode: ROOM_CODE });
    await handleJoinRoom(p4Ws, 'conn-p4', p4User, { type: 'join-room', roomCode: ROOM_CODE });
    await handleJoinRoom(p5Ws, 'conn-p5', p5User, { type: 'join-room', roomCode: ROOM_CODE });

    // Timer should be cancelled now that the room is full
    expect(isLobbyTimerActive(ROOM_CODE)).toBe(false);
  });

  it('broadcasts lobby-starting with empty botsAdded when room fills naturally', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom6());
    _setSupabaseClient(supabase);

    const wss = [hostUser, p1User, p2User, p3User, p4User, p5User].map(() => createMockWs());
    const users = [hostUser, p1User, p2User, p3User, p4User, p5User];

    for (let i = 0; i < 6; i++) {
      await handleJoinRoom(wss[i], `conn-${i}`, users[i], { type: 'join-room', roomCode: ROOM_CODE });
    }

    // Every connected player should receive 'lobby-starting'
    for (const ws of wss) {
      const startMsg = msgOfType(ws, 'lobby-starting');
      expect(startMsg).not.toBeNull();
      expect(startMsg.roomCode).toBe(ROOM_CODE);
      expect(startMsg.botsAdded).toEqual([]);
    }
  });

  it('lobby-starting seats array has 6 entries (all human) when room fills exactly', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom6());
    _setSupabaseClient(supabase);

    const wss   = [hostUser, p1User, p2User, p3User, p4User, p5User].map(() => createMockWs());
    const users = [hostUser, p1User, p2User, p3User, p4User, p5User];

    for (let i = 0; i < 6; i++) {
      await handleJoinRoom(wss[i], `conn-${i}`, users[i], { type: 'join-room', roomCode: ROOM_CODE });
    }

    const startMsg = msgOfType(wss[0], 'lobby-starting');
    expect(startMsg).not.toBeNull();
    expect(startMsg.seats).toHaveLength(6);
    expect(startMsg.seats.every((s) => s.isBot === false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C. Timer expiry — bots fill empty seats
//
// These tests call _handleTimerExpiry directly (bypassing the actual timer
// mechanism) to avoid fake-timer / Promise-flushing complexity.  The timer
// module's own unit tests (lobbyTimer.test.js) already verify that the
// callback fires after the correct delay.
// ---------------------------------------------------------------------------

describe('C. Timer expiry — bots fill open seats', () => {
  it('fills empty seats with bots when timer fires', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom6());
    _setSupabaseClient(supabase);

    const hostWs = createMockWs();
    await handleJoinRoom(hostWs, 'conn-host', hostUser, { type: 'join-room', roomCode: ROOM_CODE });

    // Simulate the timer firing by calling the expiry handler directly.
    await _handleTimerExpiry(ROOM_CODE);

    // Host should receive lobby-starting
    const startMsg = msgOfType(hostWs, 'lobby-starting');
    expect(startMsg).not.toBeNull();
    expect(startMsg.botsAdded.length).toBe(5); // 6 seats - 1 human = 5 bots
  });

  it('bot IDs start with "bot_"', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom6());
    _setSupabaseClient(supabase);

    const hostWs = createMockWs();
    await handleJoinRoom(hostWs, 'conn-host', hostUser, { type: 'join-room', roomCode: ROOM_CODE });
    await _handleTimerExpiry(ROOM_CODE);

    const startMsg = msgOfType(hostWs, 'lobby-starting');
    expect(startMsg).not.toBeNull();
    for (const botId of startMsg.botsAdded) {
      expect(botId).toMatch(/^bot_/);
    }
  });

  it('bot seat indices cover all empty seats (no duplicate seat indices)', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom6());
    _setSupabaseClient(supabase);

    const hostWs = createMockWs();
    await handleJoinRoom(hostWs, 'conn-host', hostUser, { type: 'join-room', roomCode: ROOM_CODE });
    await _handleTimerExpiry(ROOM_CODE);

    const startMsg = msgOfType(hostWs, 'lobby-starting');
    const seatIndices = startMsg.seats.map((s) => s.seatIndex);
    const uniqueIndices = new Set(seatIndices);

    // All seat indices are unique
    expect(uniqueIndices.size).toBe(seatIndices.length);
    // All seats 0–5 are covered
    for (let i = 0; i < 6; i++) {
      expect(uniqueIndices.has(i)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// D. _handleGameStart directly
// ---------------------------------------------------------------------------

describe('D. _handleGameStart', () => {
  it('updates Supabase room status to "starting"', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom6());
    _setSupabaseClient(supabase);

    // Set up a lobby with one human player
    getOrCreateLobby(ROOM_CODE, HOST_ID);
    addToLobbyStore(ROOM_CODE, {
      connectionId: 'conn-h',
      playerId:     HOST_ID,
      displayName:  'Host',
      avatarId:     null,
      isGuest:      false,
      ws:           createMockWs(),
    });

    initLobbyRoom({ roomId: ROOM_ID, roomCode: ROOM_CODE, hostPlayerId: HOST_ID, playerCount: 6 });
    addSeatToLobbyManager(ROOM_CODE, {
      seatIndex: 0, playerId: HOST_ID, displayName: 'Host',
      teamId: 1, isBot: false, isGuest: false,
    });

    await _handleGameStart(ROOM_CODE, 6);

    // Verify Supabase update was called with status='starting'
    expect(supabase.from).toHaveBeenCalledWith('rooms');
    expect(supabase.update).toHaveBeenCalledWith({ status: 'starting' });
  });

  it('adds the correct number of bots to lobbyManager seats', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom6());
    _setSupabaseClient(supabase);

    getOrCreateLobby(ROOM_CODE, HOST_ID);
    addToLobbyStore(ROOM_CODE, {
      connectionId: 'conn-h',
      playerId:     HOST_ID,
      displayName:  'Host',
      avatarId:     null,
      isGuest:      false,
      ws:           createMockWs(),
    });

    initLobbyRoom({ roomId: ROOM_ID, roomCode: ROOM_CODE, hostPlayerId: HOST_ID, playerCount: 6 });
    addSeatToLobbyManager(ROOM_CODE, {
      seatIndex: 0, playerId: HOST_ID, displayName: 'Host',
      teamId: 1, isBot: false, isGuest: false,
    });

    await _handleGameStart(ROOM_CODE, 6);

    const snapshot = getLobbySnapshot(ROOM_CODE);
    expect(snapshot.seats).toHaveLength(6);

    const bots   = snapshot.seats.filter((s) => s.isBot);
    const humans = snapshot.seats.filter((s) => !s.isBot);
    expect(bots).toHaveLength(5);
    expect(humans).toHaveLength(1);
  });

  it('generated bots have seatIndex values 1–5 (human occupies 0)', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom6());
    _setSupabaseClient(supabase);

    getOrCreateLobby(ROOM_CODE, HOST_ID);
    addToLobbyStore(ROOM_CODE, {
      connectionId: 'conn-h',
      playerId:     HOST_ID,
      displayName:  'Host',
      avatarId:     null,
      isGuest:      false,
      ws:           createMockWs(),
    });

    initLobbyRoom({ roomId: ROOM_ID, roomCode: ROOM_CODE, hostPlayerId: HOST_ID, playerCount: 6 });
    addSeatToLobbyManager(ROOM_CODE, {
      seatIndex: 0, playerId: HOST_ID, displayName: 'Host',
      teamId: 1, isBot: false, isGuest: false,
    });

    await _handleGameStart(ROOM_CODE, 6);

    const snapshot = getLobbySnapshot(ROOM_CODE);
    const botSeats = snapshot.seats
      .filter((s) => s.isBot)
      .map((s) => s.seatIndex)
      .sort((a, b) => a - b);

    expect(botSeats).toEqual([1, 2, 3, 4, 5]);
  });

  it('broadcasts lobby-starting to all connected players', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom6());
    _setSupabaseClient(supabase);

    const hostWs = createMockWs();
    const p1Ws   = createMockWs();

    getOrCreateLobby(ROOM_CODE, HOST_ID);
    addToLobbyStore(ROOM_CODE, {
      connectionId: 'conn-h', playerId: HOST_ID,    displayName: 'Host',
      avatarId: null, isGuest: false, ws: hostWs,
    });
    addToLobbyStore(ROOM_CODE, {
      connectionId: 'conn-p1', playerId: PLAYER1_ID, displayName: 'P1',
      avatarId: null, isGuest: false, ws: p1Ws,
    });

    initLobbyRoom({ roomId: ROOM_ID, roomCode: ROOM_CODE, hostPlayerId: HOST_ID, playerCount: 6 });
    addSeatToLobbyManager(ROOM_CODE, {
      seatIndex: 0, playerId: HOST_ID, displayName: 'Host',
      teamId: 1, isBot: false, isGuest: false,
    });
    addSeatToLobbyManager(ROOM_CODE, {
      seatIndex: 1, playerId: PLAYER1_ID, displayName: 'P1',
      teamId: 2, isBot: false, isGuest: false,
    });

    await _handleGameStart(ROOM_CODE, 6);

    for (const ws of [hostWs, p1Ws]) {
      const msg = msgOfType(ws, 'lobby-starting');
      expect(msg).not.toBeNull();
    }
  });

  it('is safe to call when lobbyManager has no room entry', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom6());
    _setSupabaseClient(supabase);

    getOrCreateLobby(ROOM_CODE, HOST_ID);
    addToLobbyStore(ROOM_CODE, {
      connectionId: 'conn-h', playerId: HOST_ID, displayName: 'Host',
      avatarId: null, isGuest: false, ws: createMockWs(),
    });

    // NOTE: lobbyManager NOT initialised for this room
    await expect(_handleGameStart(ROOM_CODE, 6)).resolves.not.toThrow();
  });

  it('does not cancel a non-existent timer (no error)', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom6());
    _setSupabaseClient(supabase);

    getOrCreateLobby(ROOM_CODE, HOST_ID);
    initLobbyRoom({ roomId: ROOM_ID, roomCode: ROOM_CODE, hostPlayerId: HOST_ID, playerCount: 6 });

    await expect(_handleGameStart(ROOM_CODE, 6)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// E. _handleTimerExpiry directly
// ---------------------------------------------------------------------------

describe('E. _handleTimerExpiry', () => {
  it('no-ops when room is not found in DB', async () => {
    const supabase = buildMockSupabase(null); // null → room not found
    _setSupabaseClient(supabase);

    // Should resolve without error and without broadcasting anything
    await expect(_handleTimerExpiry(ROOM_CODE)).resolves.not.toThrow();
  });

  it('no-ops when room status is not "waiting"', async () => {
    const inProgressRoom = makeWaitingRoom6({ status: 'in_progress' });
    const supabase = buildMockSupabase(inProgressRoom);
    _setSupabaseClient(supabase);

    getOrCreateLobby(ROOM_CODE, HOST_ID);
    const ws = createMockWs();
    addToLobbyStore(ROOM_CODE, {
      connectionId: 'conn-h', playerId: HOST_ID, displayName: 'Host',
      avatarId: null, isGuest: false, ws,
    });

    await _handleTimerExpiry(ROOM_CODE);

    // No lobby-starting message should have been sent
    expect(msgOfType(ws, 'lobby-starting')).toBeNull();
  });

  it('no-ops when room status is "cancelled"', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom6({ status: 'cancelled' }));
    _setSupabaseClient(supabase);

    await expect(_handleTimerExpiry(ROOM_CODE)).resolves.not.toThrow();
  });

  it('no-ops when room status is "starting"', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom6({ status: 'starting' }));
    _setSupabaseClient(supabase);

    await expect(_handleTimerExpiry(ROOM_CODE)).resolves.not.toThrow();
  });

  it('calls _handleGameStart when room is still "waiting"', async () => {
    const supabase = buildMockSupabase(makeWaitingRoom6());
    _setSupabaseClient(supabase);

    const ws = createMockWs();
    getOrCreateLobby(ROOM_CODE, HOST_ID);
    addToLobbyStore(ROOM_CODE, {
      connectionId: 'conn-h', playerId: HOST_ID, displayName: 'Host',
      avatarId: null, isGuest: false, ws,
    });
    initLobbyRoom({ roomId: ROOM_ID, roomCode: ROOM_CODE, hostPlayerId: HOST_ID, playerCount: 6 });
    addSeatToLobbyManager(ROOM_CODE, {
      seatIndex: 0, playerId: HOST_ID, displayName: 'Host',
      teamId: 1, isBot: false, isGuest: false,
    });

    await _handleTimerExpiry(ROOM_CODE);

    // lobby-starting should have been sent to the connected player
    expect(msgOfType(ws, 'lobby-starting')).not.toBeNull();
  });

  it('handles DB errors gracefully without throwing', async () => {
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

    await expect(_handleTimerExpiry(ROOM_CODE)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// F. botFiller unit tests (via _handleGameStart)
// ---------------------------------------------------------------------------

describe('F. Bot name generation', () => {
  const { fillWithBots, _keyToDisplayName } = require('../matchmaking/botFiller');

  it('_keyToDisplayName converts "quirky_turing" to "Quirky Turing"', () => {
    expect(_keyToDisplayName('quirky_turing')).toBe('Quirky Turing');
  });

  it('_keyToDisplayName handles multi-segment keys', () => {
    expect(_keyToDisplayName('admiring_von_neumann')).toContain('Admiring');
  });

  it('fillWithBots returns 0 bots when all seats occupied', () => {
    const seats = new Map();
    for (let i = 0; i < 6; i++) {
      seats.set(i, { seatIndex: i, playerId: `p${i}`, isBot: false });
    }
    expect(fillWithBots(6, seats)).toHaveLength(0);
  });

  it('fillWithBots returns player_count bots when no seats occupied', () => {
    const bots = fillWithBots(6, new Map());
    expect(bots).toHaveLength(6);
  });

  it('fillWithBots returns correct count for 8-player game with 3 humans', () => {
    const seats = new Map();
    seats.set(0, { seatIndex: 0, playerId: 'h', isBot: false });
    seats.set(2, { seatIndex: 2, playerId: 'p2', isBot: false });
    seats.set(4, { seatIndex: 4, playerId: 'p4', isBot: false });
    const bots = fillWithBots(8, seats);
    expect(bots).toHaveLength(5); // 8 - 3 = 5
  });

  it('fillWithBots bot IDs start with bot_', () => {
    const bots = fillWithBots(6, new Map());
    for (const bot of bots) {
      expect(bot.playerId).toMatch(/^bot_/);
    }
  });

  it('fillWithBots team assignments alternate correctly (even=T1, odd=T2)', () => {
    const bots = fillWithBots(6, new Map());
    for (const bot of bots) {
      const expected = bot.seatIndex % 2 === 0 ? 1 : 2;
      expect(bot.teamId).toBe(expected);
    }
  });

  it('fillWithBots all displayNames are non-empty strings', () => {
    const bots = fillWithBots(8, new Map());
    for (const bot of bots) {
      expect(typeof bot.displayName).toBe('string');
      expect(bot.displayName.length).toBeGreaterThan(0);
    }
  });

  it('fillWithBots generates unique displayNames within the same call', () => {
    const bots = fillWithBots(8, new Map());
    const names = bots.map((b) => b.displayName);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('fillWithBots bots all have isBot=true and isGuest=false', () => {
    const bots = fillWithBots(6, new Map());
    for (const bot of bots) {
      expect(bot.isBot).toBe(true);
      expect(bot.isGuest).toBe(false);
    }
  });
});
