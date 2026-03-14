'use strict';

/**
 * Integration tests for the room-created Socket.io event.
 *
 * Verifies that after a successful POST /api/rooms:
 *   1. The host's Socket.io connection receives a 'room-created' event.
 *   2. The event payload contains inviteCode, inviteLink, and spectatorLink.
 *   3. spectatorLink uses the token-based /spectate/<TOKEN> format.
 *   4. Unauthenticated socket connections are rejected.
 *   5. REST succeeds even when no socket is connected for the host.
 *
 * Strategy:
 *   - A real Node.js HTTP server is started on a dynamic port (port 0) to
 *     avoid conflicts with other test suites.
 *   - Socket.io is attached to that server via initSocket().
 *   - socket.io-client connects using a test bearer token.
 *   - Supabase is fully mocked — no real DB or network calls are made.
 *   - jest.resetModules() is called once in beforeAll to obtain a clean
 *     singleton state for socket/server.js.
 */

const http = require('http');
const express = require('express');
const supertest = require('supertest');
const { io: ioc } = require('socket.io-client');

// ── Module references populated after jest.resetModules() ────────────────────
let _setSupabaseClient;
let initSocket, _resetSocket, getConnectedUsers;
let roomsRouter;
let mockSupabase;

// ── Test constants ────────────────────────────────────────────────────────────
const FAKE_USER_ID = 'socket-test-host-uuid-abcdef';
const FAKE_TOKEN   = 'socket-test-bearer-token-xyzabc123';

// ── Supabase mock factory ─────────────────────────────────────────────────────

/**
 * Builds a chainable Supabase mock mirroring the pattern used in rooms.test.js.
 */
function buildMockSupabase() {
  const maybeSingle = jest.fn();
  const single      = jest.fn();
  const select      = jest.fn();
  const eq          = jest.fn();
  const insert      = jest.fn();
  const inFn        = jest.fn();

  const chain = { select, eq, maybeSingle, single, in: inFn, insert };
  select.mockReturnValue(chain);
  eq.mockReturnValue(chain);
  inFn.mockReturnValue(chain);
  insert.mockReturnValue(chain);

  const from = jest.fn().mockReturnValue(chain);

  return {
    from,
    auth: { getUser: jest.fn() },
    _chain: chain,
  };
}

// ── Helper: fresh fake room ───────────────────────────────────────────────────

function makeFakeRoom(overrides = {}) {
  return {
    id:                    'room-uuid-socket-test',
    code:                  'SCKTST',
    invite_code:           'ABCDEF0123456789',
    spectator_token:       'SPECTOK0123456789ABCDEF01234567',
    host_user_id:          FAKE_USER_ID,
    player_count:          6,
    card_removal_variant:  'remove_7s',
    status:                'waiting',
    created_at:            new Date().toISOString(),
    updated_at:            new Date().toISOString(),
    ...overrides,
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('room-created Socket.io event', () => {
  let httpServer;
  let app;
  let port;

  // ── One-time setup ─────────────────────────────────────────────────────────
  beforeAll((done) => {
    // Reset the module registry so this suite gets its own singleton instances
    // for socket/server.js (independent of any other test file).
    jest.resetModules();

    // Inject Supabase mock BEFORE any module that calls getSupabaseClient().
    mockSupabase = buildMockSupabase();
    ({ _setSupabaseClient } = require('../db/supabase'));
    _setSupabaseClient(mockSupabase);

    // Import socket server + rooms router AFTER mock is set.
    ({ initSocket, _resetSocket, getConnectedUsers } = require('../socket/server'));
    roomsRouter = require('../routes/rooms');

    // Build a minimal Express app (no rate-limiting for test predictability).
    app = express();
    app.use(express.json({ limit: '10kb' }));
    app.use('/api/rooms', roomsRouter);

    // Create the HTTP server and attach Socket.io.
    httpServer = http.createServer(app);
    initSocket(httpServer, { corsOrigins: ['*'] });

    // Listen on a random port so this suite never conflicts with other suites.
    httpServer.listen(0, () => {
      port = httpServer.address().port;
      done();
    });
  });

  // ── One-time teardown ──────────────────────────────────────────────────────
  afterAll((done) => {
    _resetSocket();
    httpServer.close(done);
  });

  // ── Per-test mock reset ────────────────────────────────────────────────────
  beforeEach(() => {
    jest.clearAllMocks();

    // Auth mock: return the fake registered user for any token.
    // This is used by both:
    //   • Socket.io auth middleware  (resolveTokenDirect → supabase.auth.getUser)
    //   • Express requireAuth        (resolveUser → supabase.auth.getUser)
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: FAKE_USER_ID, email: 'host@socket-test.example.com' } },
      error: null,
    });
  });

  // ── Authentication ─────────────────────────────────────────────────────────

  it('rejects socket connections with no token', (done) => {
    const socket = ioc(`http://localhost:${port}`, {
      auth: {},
      reconnection: false,
    });

    socket.on('connect_error', (err) => {
      expect(err.message).toBe('Unauthorized');
      socket.disconnect();
      done();
    });

    socket.on('connect', () => {
      socket.disconnect();
      done(new Error('Expected connection to be rejected but it succeeded'));
    });
  }, 8000);

  it('rejects socket connections with an invalid token', (done) => {
    // Make Supabase return no user for the bad token.
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Invalid JWT' },
    });

    const socket = ioc(`http://localhost:${port}`, {
      auth: { token: 'bad-invalid-token-zzzz' },
      reconnection: false,
    });

    socket.on('connect_error', (err) => {
      expect(err.message).toBe('Unauthorized');
      socket.disconnect();
      done();
    });

    socket.on('connect', () => {
      socket.disconnect();
      done(new Error('Expected connection to be rejected but it succeeded'));
    });
  }, 8000);

  it('accepts a socket connection with a valid token', (done) => {
    const socket = ioc(`http://localhost:${port}`, {
      auth: { token: FAKE_TOKEN },
      reconnection: false,
    });

    socket.on('connect', () => {
      expect(socket.connected).toBe(true);
      socket.disconnect();
      done();
    });

    socket.on('connect_error', (err) => {
      done(new Error(`Expected connection to succeed: ${err.message}`));
    });
  }, 8000);

  // ── room-created emission ──────────────────────────────────────────────────

  it('emits room-created to host socket after successful POST /api/rooms', (done) => {
    const fakeRoom = makeFakeRoom();

    // Supabase DB mocks for the POST /api/rooms handler:
    //   call 1: existing-active-room check  → null (no active room)
    //   call 2: room-code uniqueness check  → null (code is unique)
    mockSupabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })  // active room check
      .mockResolvedValueOnce({ data: null, error: null }); // code uniqueness
    // insert().select().single() → new room
    mockSupabase._chain.single.mockResolvedValueOnce({
      data: fakeRoom,
      error: null,
    });

    const socket = ioc(`http://localhost:${port}`, {
      auth: { token: FAKE_TOKEN },
      reconnection: false,
    });

    socket.on('room-created', (payload) => {
      try {
        // ── Verify inviteCode ──────────────────────────────────────────────
        expect(payload.inviteCode).toBe(fakeRoom.invite_code);

        // ── Verify inviteLink ──────────────────────────────────────────────
        expect(payload.inviteLink).toBeDefined();
        expect(payload.inviteLink).toContain(`/room/${fakeRoom.code}`);
        expect(payload.inviteLink).not.toContain('spectate');

        // ── Verify spectatorLink ───────────────────────────────────────────
        // spectatorLink now uses the token-based /spectate/<TOKEN> format
        // so the link is unguessable from the room code alone.
        expect(payload.spectatorLink).toBeDefined();
        expect(payload.spectatorLink).toContain('/spectate/');
        expect(payload.spectatorLink).toContain(fakeRoom.spectator_token);

        // ── Verify room object ─────────────────────────────────────────────
        expect(payload.room).toBeDefined();
        expect(payload.room.code).toBe(fakeRoom.code);
        expect(payload.room.player_count).toBe(6);
        expect(payload.room.card_removal_variant).toBe('remove_7s');

        socket.disconnect();
        done();
      } catch (assertErr) {
        socket.disconnect();
        done(assertErr);
      }
    });

    socket.on('connect', () => {
      // Trigger room creation via the REST endpoint.
      supertest(app)
        .post('/api/rooms')
        .set('Authorization', `Bearer ${FAKE_TOKEN}`)
        .send({ playerCount: 6, cardRemovalVariant: 'remove_7s' })
        .then((res) => {
          if (res.status !== 201) {
            socket.disconnect();
            done(new Error(`POST /api/rooms returned ${res.status}: ${JSON.stringify(res.body)}`));
          }
          // The room-created socket event should arrive shortly;
          // the listener above will call done().
        })
        .catch((restErr) => {
          socket.disconnect();
          done(restErr);
        });
    });

    socket.on('connect_error', (err) => {
      done(new Error(`Socket connection failed: ${err.message}`));
    });
  }, 12000); // generous timeout for async handshake + REST round-trip

  it('spectatorLink uses token-based /spectate/<TOKEN> format', (done) => {
    const fakeRoom = makeFakeRoom({
      code:                 'SPEC88',
      invite_code:          'INVITECODE000001',
      spectator_token:      'AABBCCDD00112233AABBCCDD00112233',
      player_count:         8,
      card_removal_variant: 'remove_2s',
    });

    mockSupabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    mockSupabase._chain.single.mockResolvedValueOnce({ data: fakeRoom, error: null });

    const socket = ioc(`http://localhost:${port}`, {
      auth: { token: FAKE_TOKEN },
      reconnection: false,
    });

    socket.on('room-created', (payload) => {
      try {
        // spectatorLink should use the token-based format
        expect(payload.spectatorLink).toMatch(/\/spectate\/[0-9A-F]{32}$/i);
        expect(payload.spectatorLink).toContain(fakeRoom.spectator_token);
        // spectatorLink must NOT contain the ?spectate=1 query param
        expect(payload.spectatorLink).not.toContain('?spectate=1');
        socket.disconnect();
        done();
      } catch (e) {
        socket.disconnect();
        done(e);
      }
    });

    socket.on('connect', () => {
      supertest(app)
        .post('/api/rooms')
        .set('Authorization', `Bearer ${FAKE_TOKEN}`)
        .send({ playerCount: 8, cardRemovalVariant: 'remove_2s' })
        .catch(done);
    });

    socket.on('connect_error', (err) => {
      done(new Error(`Socket connect failed: ${err.message}`));
    });
  }, 12000);

  it('REST succeeds with 201 even when host has no socket connection', async () => {
    const fakeRoom = makeFakeRoom({ code: 'NOSCKT', id: 'room-no-socket-id' });

    mockSupabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    mockSupabase._chain.single.mockResolvedValueOnce({ data: fakeRoom, error: null });

    // Remove any lingering socket registrations so host appears offline.
    getConnectedUsers().clear();

    const res = await supertest(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${FAKE_TOKEN}`)
      .send({ playerCount: 6, cardRemovalVariant: 'remove_7s' });

    expect(res.status).toBe(201);
    expect(res.body.room).toBeDefined();
    expect(res.body.room.code).toBe('NOSCKT');
  });

  it('room-created payload inviteLink uses the room code (not the invite_code token)', (done) => {
    const fakeRoom = makeFakeRoom({ code: 'LNKCHK', invite_code: 'INVITE_TOKEN_ABC1' });

    mockSupabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    mockSupabase._chain.single.mockResolvedValueOnce({ data: fakeRoom, error: null });

    const socket = ioc(`http://localhost:${port}`, {
      auth: { token: FAKE_TOKEN },
      reconnection: false,
    });

    socket.on('room-created', (payload) => {
      try {
        // inviteLink navigates players to /room/<CODE> (the 6-char display code)
        expect(payload.inviteLink).toContain('/room/LNKCHK');
        // inviteCode is the long hex token stored in the DB
        expect(payload.inviteCode).toBe('INVITE_TOKEN_ABC1');
        socket.disconnect();
        done();
      } catch (e) {
        socket.disconnect();
        done(e);
      }
    });

    socket.on('connect', () => {
      supertest(app)
        .post('/api/rooms')
        .set('Authorization', `Bearer ${FAKE_TOKEN}`)
        .send({ playerCount: 6, cardRemovalVariant: 'remove_7s' })
        .catch(done);
    });

    socket.on('connect_error', (err) => {
      done(new Error(`Socket connect failed: ${err.message}`));
    });
  }, 12000);
});
