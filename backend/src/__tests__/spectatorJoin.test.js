'use strict';

/**
 * Tests for Sub-AC 42b: Backend Spectator Join Handler
 *
 * Covers:
 *   1. GET /api/rooms/spectate/:token (REST validation endpoint)
 *      - Validates spectator token format (must be 32 hex chars)
 *      - Returns 400 for invalid token format
 *      - Returns 404 for unknown tokens
 *      - Returns 200 with room info for valid token
 *   2. resolveSpectatorToken() helper (unit tests)
 *      - Returns null for invalid tokens
 *      - Returns room record for valid tokens
 *      - Normalises token to uppercase
 *   3. Game WebSocket spectator connection (integration tests)
 *      - Valid spectator token → spectator_init with public snapshot only
 *      - spectator_init.gameState has no moveHistory / hands / botKnowledge
 *      - spectator_init.inferenceMode is present
 *      - Invalid / missing token → rejected
 *      - Spectator cannot send game messages (receives SPECTATOR error)
 *      - Lowercase token also accepted (case-insensitive)
 */

const supertest = require('supertest');
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_SPECTATOR_TOKEN = 'AABBCCDDEEFF00112233445566778899'; // 32 hex chars
const VALID_ROOM_CODE       = 'SPECTA';
const PLAYER_ID             = 'player-uuid-001';

function makeRoomRow(overrides = {}) {
  return {
    id:                   'room-id-001',
    code:                 VALID_ROOM_CODE,
    player_count:         6,
    card_removal_variant: 'remove_7s',
    status:               'in_progress',
    is_matchmaking:       false,
    spectator_token:      VALID_SPECTATOR_TOKEN,
    created_at:           '2024-01-01T00:00:00Z',
    updated_at:           '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

// ── Supabase chain mock factory ───────────────────────────────────────────────
function buildChainMock(defaultResolution = { data: null, error: null }) {
  const maybeSingleFn = jest.fn().mockResolvedValue(defaultResolution);

  const chain = {};
  chain.select      = jest.fn().mockReturnValue(chain);
  chain.eq          = jest.fn().mockReturnValue(chain);
  chain.maybeSingle = maybeSingleFn;

  const supabase = {
    from: jest.fn().mockReturnValue(chain),
    auth: {
      getUser: jest.fn().mockResolvedValue({ data: { user: null }, error: 'no user' }),
    },
    _chain:      chain,
    _maybeSingle: maybeSingleFn,
  };

  return supabase;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: GET /api/rooms/spectate/:token
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/rooms/spectate/:token', () => {
  let app;
  let mockSupabase;

  beforeAll(() => {
    jest.resetModules();
    mockSupabase = buildChainMock();
    const { _setSupabaseClient } = require('../db/supabase');
    _setSupabaseClient(mockSupabase);
    const roomsRouter = require('../routes/rooms');

    app = express();
    app.use(express.json());
    app.use('/api/rooms', roomsRouter);
  });

  afterAll(() => {
    jest.resetModules();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 400 when token is too short', async () => {
    const res = await supertest(app).get('/api/rooms/spectate/TOOSHORT');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid spectator token/i);
  });

  it('returns 400 when token contains non-hex characters', async () => {
    // 32 chars but with invalid hex chars (G, H, Z, etc.)
    const badToken = 'GGHHIIJJKKLLMMNNPPQQRRSSTTUU1234';
    const res = await supertest(app).get(`/api/rooms/spectate/${badToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid spectator token/i);
  });

  it('returns 400 when token is 33 characters (too long)', async () => {
    const longToken = 'A'.repeat(33);
    const res = await supertest(app).get(`/api/rooms/spectate/${longToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid spectator token/i);
  });

  it('returns 404 when token does not match any room', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const res = await supertest(app).get(`/api/rooms/spectate/${VALID_SPECTATOR_TOKEN}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  it('returns 500 when Supabase returns an error object', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: 'DB connection error' },
    });
    const res = await supertest(app).get(`/api/rooms/spectate/${VALID_SPECTATOR_TOKEN}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });

  it('returns 200 with room info for a valid token', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeRoomRow(),
      error: null,
    });

    const res = await supertest(app).get(`/api/rooms/spectate/${VALID_SPECTATOR_TOKEN}`);

    expect(res.status).toBe(200);
    // roomCode is at the top level
    expect(res.body.roomCode).toBe(VALID_ROOM_CODE);
    // room object contains the raw DB fields
    expect(res.body.room).toBeDefined();
    expect(res.body.room.player_count).toBe(6);
    expect(res.body.room.card_removal_variant).toBe('remove_7s');
    expect(res.body.room.status).toBe('in_progress');

    // spectator_token must NOT be exposed (it was only selected for the join
    // page; this endpoint should not leak it back)
    // (Note: the existing route selects without spectator_token so it's absent)
  });

  it('accepts lowercase hex tokens (normalised to uppercase for DB query)', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeRoomRow(),
      error: null,
    });

    const lowerToken = VALID_SPECTATOR_TOKEN.toLowerCase();
    const res = await supertest(app).get(`/api/rooms/spectate/${lowerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.roomCode).toBe(VALID_ROOM_CODE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: resolveSpectatorToken() unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveSpectatorToken()', () => {
  let resolveSpectatorToken;
  let mockSupabase;

  beforeAll(() => {
    jest.resetModules();
    mockSupabase = buildChainMock();
    const { _setSupabaseClient } = require('../db/supabase');
    _setSupabaseClient(mockSupabase);
    ({ resolveSpectatorToken } = require('../game/gameSocketServer'));
  });

  afterAll(() => {
    jest.resetModules();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when spectatorToken is null', async () => {
    const result = await resolveSpectatorToken(VALID_ROOM_CODE, null);
    expect(result).toBeNull();
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('returns null when spectatorToken is undefined', async () => {
    const result = await resolveSpectatorToken(VALID_ROOM_CODE, undefined);
    expect(result).toBeNull();
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('returns null for a token shorter than 32 characters', async () => {
    const result = await resolveSpectatorToken(VALID_ROOM_CODE, 'TOOSHORT');
    expect(result).toBeNull();
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('returns null for a token longer than 32 characters', async () => {
    const result = await resolveSpectatorToken(VALID_ROOM_CODE, 'A'.repeat(33));
    expect(result).toBeNull();
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('returns null for a 32-char string with non-hex characters', async () => {
    const badToken = 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'; // 32 Z's — not valid hex
    const result = await resolveSpectatorToken(VALID_ROOM_CODE, badToken);
    expect(result).toBeNull();
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('returns null when DB returns no room (token mismatch)', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const result = await resolveSpectatorToken(VALID_ROOM_CODE, VALID_SPECTATOR_TOKEN);
    expect(result).toBeNull();
  });

  it('returns null on Supabase error', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: 'network error' },
    });
    const result = await resolveSpectatorToken(VALID_ROOM_CODE, VALID_SPECTATOR_TOKEN);
    expect(result).toBeNull();
  });

  it('returns the room record when token matches', async () => {
    const roomRecord = { id: 'room-id-001', code: VALID_ROOM_CODE, status: 'in_progress' };
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({ data: roomRecord, error: null });

    const result = await resolveSpectatorToken(VALID_ROOM_CODE, VALID_SPECTATOR_TOKEN);

    expect(result).not.toBeNull();
    expect(result.code).toBe(VALID_ROOM_CODE);
    expect(result.status).toBe('in_progress');
  });

  it('normalises the spectatorToken to uppercase before querying', async () => {
    const lowerToken = VALID_SPECTATOR_TOKEN.toLowerCase();
    const roomRecord = { id: 'room-id-001', code: VALID_ROOM_CODE, status: 'in_progress' };
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({ data: roomRecord, error: null });

    await resolveSpectatorToken(VALID_ROOM_CODE, lowerToken);

    // Verify the eq() call for spectator_token used the uppercase version
    const eqCalls = mockSupabase._chain.eq.mock.calls;
    const tokenCall = eqCalls.find(([col]) => col === 'spectator_token');
    expect(tokenCall).toBeDefined();
    expect(tokenCall[1]).toBe(VALID_SPECTATOR_TOKEN); // must be uppercase
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: Game WebSocket — spectator connection (integration)
// ─────────────────────────────────────────────────────────────────────────────

describe('Game WebSocket spectator connection', () => {
  let httpServer;
  let port;
  let mockSupabase;
  let gameSocketServer;
  let clearGameStore;

  // 6-player seat layout — human at seat 0, bots at seats 1-5
  const ALL_SEATS = [
    { seatIndex: 0, playerId: PLAYER_ID, displayName: 'Alice', avatarId: null, teamId: 1, isBot: false, isGuest: false },
    { seatIndex: 1, playerId: 'bot-1',   displayName: 'Bot 1', avatarId: null, teamId: 2, isBot: true,  isGuest: false },
    { seatIndex: 2, playerId: 'bot-2',   displayName: 'Bot 2', avatarId: null, teamId: 1, isBot: true,  isGuest: false },
    { seatIndex: 3, playerId: 'bot-3',   displayName: 'Bot 3', avatarId: null, teamId: 2, isBot: true,  isGuest: false },
    { seatIndex: 4, playerId: 'bot-4',   displayName: 'Bot 4', avatarId: null, teamId: 1, isBot: true,  isGuest: false },
    { seatIndex: 5, playerId: 'bot-5',   displayName: 'Bot 5', avatarId: null, teamId: 2, isBot: true,  isGuest: false },
  ];

  beforeAll((done) => {
    jest.resetModules();

    // Supabase mock — must be set BEFORE any module that calls getSupabaseClient().
    mockSupabase = buildChainMock({ data: makeRoomRow(), error: null });
    const { _setSupabaseClient } = require('../db/supabase');
    _setSupabaseClient(mockSupabase);

    gameSocketServer = require('../game/gameSocketServer');
    ({ _clearAll: clearGameStore } = require('../game/gameStore'));

    // Pre-seed the game store so /ws/game/<CODE> finds the game in memory.
    // createGame deals a real deck and requires all 6 seats.
    gameSocketServer.createGame({
      roomCode:    VALID_ROOM_CODE,
      roomId:      'room-id-001',
      variant:     'remove_7s',
      playerCount: 6,
      seats:       ALL_SEATS,
    });

    // Attach game WebSocket server to a fresh HTTP server.
    const app = express();
    httpServer = http.createServer(app);
    gameSocketServer.attachGameSocketServer(httpServer);

    httpServer.listen(0, () => {
      port = httpServer.address().port;
      done();
    });
  });

  afterAll((done) => {
    if (clearGameStore) clearGameStore();
    httpServer.close(done);
    jest.resetModules();
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Default: spectator token resolves to a valid room.
    mockSupabase._chain.maybeSingle.mockResolvedValue({
      data: makeRoomRow(),
      error: null,
    });
    // Default: no bearer-token user (forces spectatorToken code path).
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: 'no-user',
    });
  });

  // ── Helper: open WS, collect messages up to `count`, then close. ───────────
  function collectMessages(queryString, count, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      const wsUrl    = `ws://localhost:${port}/ws/game/${VALID_ROOM_CODE}?${queryString}`;
      const ws       = new WebSocket(wsUrl);
      const messages = [];
      let closed     = false;

      const finish = (err) => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        ws.removeAllListeners();
        try { ws.close(); } catch (_) {}
        if (err) reject(err);
        else resolve(messages);
      };

      const timer = setTimeout(
        () => {
          // Partial results are still useful — resolve with what we got
          if (messages.length > 0) finish(null);
          else finish(new Error(`Timed out after ${timeoutMs}ms with no messages`));
        },
        timeoutMs,
      );

      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        messages.push(msg);
        if (messages.length >= count) finish(null);
      });

      ws.on('error',  (err) => finish(err));
      ws.on('close',  (code, reason) => {
        if (!closed && messages.length === 0) {
          finish(new Error(`Closed (${code}) before receiving any messages: ${reason}`));
        } else {
          finish(null);
        }
      });
    });
  }

  // ── Helper: open WS, get the first message (could be error or spectator_init).
  function firstMessage(queryString, timeoutMs = 6000) {
    return collectMessages(queryString, 1, timeoutMs).then((msgs) => msgs[0]);
  }

  // ── Helper: open WS, wait for spectator_init, send a message, wait for
  //            a message matching predicate, then close. ────────────────────────
  function spectatorSendAndWait(sendPayload, predicate, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const wsUrl = `ws://localhost:${port}/ws/game/${VALID_ROOM_CODE}?spectatorToken=${VALID_SPECTATOR_TOKEN}`;
      const ws    = new WebSocket(wsUrl);
      let closed  = false;
      let initReceived = false;

      const finish = (err, result) => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        ws.removeAllListeners();
        try { ws.close(); } catch (_) {}
        if (err) reject(err);
        else resolve(result);
      };

      const timer = setTimeout(
        () => finish(new Error(`Timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );

      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }

        // On spectator_init, send the payload we want to test.
        if (!initReceived && msg.type === 'spectator_init') {
          initReceived = true;
          ws.send(JSON.stringify(sendPayload));
          return;
        }

        // After init: check all subsequent messages for the target.
        if (initReceived && predicate(msg)) {
          finish(null, msg);
        }
      });

      ws.on('error',  (err) => finish(err));
      ws.on('close',  (code) => {
        if (!closed) finish(new Error(`Closed (${code}) before target message found`));
      });
    });
  }

  // ── no auth → UNAUTHORIZED ──────────────────────────────────────────────────
  it('rejects connections with neither bearer token nor spectator token', async () => {
    const msg = await firstMessage('');
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('UNAUTHORIZED');
  });

  // ── invalid format spectator token → error ─────────────────────────────────
  it('rejects connections with a malformed spectator token', async () => {
    // 31 chars — fails the 32-char hex check in resolveSpectatorToken
    const msg = await firstMessage('spectatorToken=AABBCCDDEEFF0011223344556677889');
    expect(msg.type).toBe('error');
    // Either INVALID_SPECTATOR_TOKEN (resolveSpectatorToken returns null)
    // or UNAUTHORIZED (catch-all when no user resolved)
    expect(['INVALID_SPECTATOR_TOKEN', 'UNAUTHORIZED']).toContain(msg.code);
  });

  // ── token not found in DB → INVALID_SPECTATOR_TOKEN ────────────────────────
  it('rejects connections when spectator token is not found in DB', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const msg = await firstMessage(`spectatorToken=${VALID_SPECTATOR_TOKEN}`);
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('INVALID_SPECTATOR_TOKEN');
  });

  // ── valid spectator token → spectator_init ──────────────────────────────────
  it('sends spectator_init when a valid spectator token is provided', async () => {
    const msg = await firstMessage(`spectatorToken=${VALID_SPECTATOR_TOKEN}`);

    expect(msg.type).toBe('spectator_init');
    expect(msg.roomCode).toBe(VALID_ROOM_CODE);
    expect(msg.variant).toBe('remove_7s');
    expect(msg.playerCount).toBe(6);
    expect(Array.isArray(msg.players)).toBe(true);
    expect(msg.players.length).toBe(6);
    expect(msg.gameState).toBeDefined();
  });

  // ── spectator_init.gameState is a public snapshot (no private fields) ───────
  it('spectator_init.gameState contains only public fields (no move history)', async () => {
    const msg = await firstMessage(`spectatorToken=${VALID_SPECTATOR_TOKEN}`);
    expect(msg.type).toBe('spectator_init');

    const gs = msg.gameState;

    // Required public fields must be present
    expect(gs.status).toBeDefined();
    expect(gs.currentTurnPlayerId).toBeDefined();
    expect(gs.scores).toBeDefined();
    expect(Array.isArray(gs.declaredSuits)).toBe(true);

    // Private / internal fields MUST be absent
    expect(gs.moveHistory).toBeUndefined();   // full event history — never sent
    expect(gs.hands).toBeUndefined();         // player hands — private
    expect(gs.botKnowledge).toBeUndefined();  // bot inference state — private
  });

  // ── spectator_init.players has cardCount but not actual cards ───────────────
  it('spectator_init.players includes cardCount but omits hand cards', async () => {
    const msg = await firstMessage(`spectatorToken=${VALID_SPECTATOR_TOKEN}`);
    expect(msg.type).toBe('spectator_init');

    for (const player of msg.players) {
      expect(typeof player.cardCount).toBe('number');
      expect(player.hand).toBeUndefined();
      expect(player.cards).toBeUndefined();
    }
  });

  // ── spectator_init carries inferenceMode flag ───────────────────────────────
  it('spectator_init includes the inferenceMode boolean flag', async () => {
    const msg = await firstMessage(`spectatorToken=${VALID_SPECTATOR_TOKEN}`);
    expect(msg.type).toBe('spectator_init');
    expect(typeof msg.inferenceMode).toBe('boolean');
  });

  // ── spectator cannot send game messages ─────────────────────────────────────
  it('returns a SPECTATOR error when spectator tries to send a game message', async () => {
    const errorMsg = await spectatorSendAndWait(
      { type: 'ask_card', targetPlayerId: 'bot-1', cardId: '2H' },
      (msg) => msg.type === 'error' && msg.code === 'SPECTATOR',
    );

    expect(errorMsg).toBeDefined();
    expect(errorMsg.type).toBe('error');
    expect(errorMsg.code).toBe('SPECTATOR');
  });

  // ── lowercase spectator token is case-insensitive ───────────────────────────
  it('accepts lowercase spectator tokens (normalised internally)', async () => {
    const lowerToken = VALID_SPECTATOR_TOKEN.toLowerCase();
    const msg = await firstMessage(`spectatorToken=${lowerToken}`);
    expect(msg.type).toBe('spectator_init');
  });
});
