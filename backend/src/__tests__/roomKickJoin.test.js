'use strict';

/**
 * Integration tests for per-room blocklist via the kick and join HTTP routes.
 *
 * POST /api/rooms/:code/kick  — host kicks a player (adds to blocklist)
 * POST /api/rooms/:code/join  — player joins (blocked players get 403)
 * GET  /api/rooms/:code/blocklist — host views the blocklist
 *
 * Supabase is fully mocked.  The roomBlocklist store is reset between tests.
 */

const request = require('supertest');

// We reset modules before each describe block so that the in-memory
// blocklist starts fresh and the Supabase mock is consistently wired.

// ---------------------------------------------------------------------------
// POST /api/rooms/:code/kick
// ---------------------------------------------------------------------------

describe('POST /api/rooms/:code/kick', () => {
  let app;
  let mockSupabase;

  beforeEach(() => {
    jest.resetModules();
    const { _setSupabaseClient } = require('../db/supabase');
    mockSupabase = buildMockSupabase();
    _setSupabaseClient(mockSupabase);

    // Reset the in-memory blocklist
    const { _resetForTests } = require('../rooms/roomBlocklist');
    _resetForTests();

    app = require('../index');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it('returns 200 and kicks the player when host calls kick', async () => {
    const hostUserId = 'host-uuid-111';
    const targetId = 'player-uuid-999';

    // Auth resolves to the host
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: hostUserId, email: 'host@example.com' } },
      error: null,
    });

    // Room lookup returns a room owned by the host
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: {
        id: 'room-id',
        code: 'KICK01',
        host_user_id: hostUserId,
        status: 'waiting',
      },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms/KICK01/kick')
      .set('Authorization', 'Bearer valid-token')
      .send({ targetPlayerId: targetId });

    expect(res.status).toBe(200);
    expect(res.body.kicked).toBe(true);
    expect(res.body.targetPlayerId).toBe(targetId);
  });

  it('works with lowercase room code in the URL', async () => {
    const hostUserId = 'host-uuid-lc';

    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: hostUserId, email: 'host@lc.com' } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: {
        id: 'r-id',
        code: 'LCROOM',
        host_user_id: hostUserId,
        status: 'waiting',
      },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms/lcroom/kick')
      .set('Authorization', 'Bearer valid-token')
      .send({ targetPlayerId: 'some-player' });

    expect(res.status).toBe(200);
  });

  // ── Auth errors ────────────────────────────────────────────────────────────

  it('returns 401 when no Authorization header', async () => {
    const res = await request(app)
      .post('/api/rooms/ABCDEF/kick')
      .send({ targetPlayerId: 'someone' });

    expect(res.status).toBe(401);
  });

  it('returns 401 when token is invalid', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Invalid JWT' },
    });

    const res = await request(app)
      .post('/api/rooms/ABCDEF/kick')
      .set('Authorization', 'Bearer bad-token')
      .send({ targetPlayerId: 'someone' });

    expect(res.status).toBe(401);
  });

  // ── Validation errors ──────────────────────────────────────────────────────

  it('returns 400 for invalid room code length', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'host-id', email: 'h@e.com' } },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms/ABC/kick')
      .set('Authorization', 'Bearer valid-token')
      .send({ targetPlayerId: 'someone' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when targetPlayerId is missing', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'host-id', email: 'h@e.com' } },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms/ABCDEF/kick')
      .set('Authorization', 'Bearer valid-token')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('targetPlayerId');
  });

  it('returns 400 when targetPlayerId is empty string', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'host-id', email: 'h@e.com' } },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms/ABCDEF/kick')
      .set('Authorization', 'Bearer valid-token')
      .send({ targetPlayerId: '   ' });

    expect(res.status).toBe(400);
  });

  // ── Authorization errors ───────────────────────────────────────────────────

  it('returns 403 when requester is a guest (guests cannot be hosts)', async () => {
    // Guest sessions are resolved from the in-memory store, not Supabase.
    // We create a guest session so requireAuth passes, then the kick route
    // should reject because guests cannot own rooms.
    const { createGuestSession, _clearStore } = require('../sessions/guestSessionStore');
    _clearStore();
    const { token } = createGuestSession('GuestPlayer', 'avatar-1');

    const res = await request(app)
      .post('/api/rooms/ABCDEF/kick')
      .set('Authorization', `Bearer ${token}`)
      .send({ targetPlayerId: 'someone' });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('host');
  });

  it('returns 403 when registered user is not the host', async () => {
    const notHostId = 'not-the-host-uuid';

    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: notHostId, email: 'other@example.com' } },
      error: null,
    });

    // Room is owned by a different user
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: {
        id: 'room-id',
        code: 'NOTMY1',
        host_user_id: 'real-host-uuid',
        status: 'waiting',
      },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms/NOTMY1/kick')
      .set('Authorization', 'Bearer valid-token')
      .send({ targetPlayerId: 'some-player' });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('host');
  });

  // ── Room state errors ──────────────────────────────────────────────────────

  it('returns 404 when room does not exist', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'host-uuid', email: 'h@e.com' } },
      error: null,
    });

    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms/NOTFND/kick')
      .set('Authorization', 'Bearer valid-token')
      .send({ targetPlayerId: 'p1' });

    expect(res.status).toBe(404);
  });

  it('returns 409 when the room is completed', async () => {
    const hostId = 'host-completed';
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: hostId, email: 'h@e.com' } },
      error: null,
    });

    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: {
        id: 'room-done',
        code: 'DONERM',
        host_user_id: hostId,
        status: 'completed',
      },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms/DONERM/kick')
      .set('Authorization', 'Bearer valid-token')
      .send({ targetPlayerId: 'p1' });

    expect(res.status).toBe(409);
  });

  it('returns 409 when the room is cancelled', async () => {
    const hostId = 'host-cancelled';
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: hostId, email: 'h@e.com' } },
      error: null,
    });

    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: {
        id: 'room-cancelled',
        code: 'CNCL01',
        host_user_id: hostId,
        status: 'cancelled',
      },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms/CNCL01/kick')
      .set('Authorization', 'Bearer valid-token')
      .send({ targetPlayerId: 'p1' });

    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// POST /api/rooms/:code/join
// ---------------------------------------------------------------------------

describe('POST /api/rooms/:code/join', () => {
  let app;
  let mockSupabase;

  beforeEach(() => {
    jest.resetModules();
    const { _setSupabaseClient } = require('../db/supabase');
    mockSupabase = buildMockSupabase();
    _setSupabaseClient(mockSupabase);
    const { _resetForTests } = require('../rooms/roomBlocklist');
    _resetForTests();
    app = require('../index');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it('returns 200 and allowed:true for a non-blocked registered user', async () => {
    const userId = 'player-uuid-200';
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: userId, email: 'p@e.com' } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: {
        id: 'r-id',
        code: 'JOIN01',
        status: 'waiting',
        player_count: 6,
      },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms/JOIN01/join')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.allowed).toBe(true);
    expect(res.body.roomCode).toBe('JOIN01');
  });

  it('allows a guest to join a non-blocked room', async () => {
    const { createGuestSession, _clearStore } = require('../sessions/guestSessionStore');
    _clearStore();
    const { token } = createGuestSession('GuestJoiner', 'avatar-2');

    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: {
        id: 'r-id',
        code: 'GJOIN1',
        status: 'waiting',
        player_count: 8,
      },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms/GJOIN1/join')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.allowed).toBe(true);
  });

  it('normalises lowercase room code to uppercase in response', async () => {
    const userId = 'player-lc';
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: userId, email: 'lc@e.com' } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { id: 'r', code: 'LCJOIN', status: 'waiting', player_count: 6 },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms/lcjoin/join')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.roomCode).toBe('LCJOIN');
  });

  // ── Blocklist rejection ────────────────────────────────────────────────────

  it('returns 403 when a kicked registered user tries to rejoin', async () => {
    const kickedUserId = 'kicked-player-uuid';

    // Pre-populate the blocklist BEFORE requiring the app (module reset
    // means we must do this after resetModules but the blocklist module
    // is the same singleton accessed via require).
    const { blockPlayer } = require('../rooms/roomBlocklist');
    blockPlayer('BLOCK1', kickedUserId);

    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: kickedUserId, email: 'kicked@e.com' } },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms/BLOCK1/join')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('removed from this room');
  });

  it('returns 403 when a kicked guest tries to rejoin', async () => {
    const { createGuestSession, _clearStore } = require('../sessions/guestSessionStore');
    _clearStore();
    const { token, session } = createGuestSession('KickedGuest', 'avatar-3');

    // Block the guest's sessionId
    const { blockPlayer } = require('../rooms/roomBlocklist');
    blockPlayer('GBLOCK', session.sessionId);

    const res = await request(app)
      .post('/api/rooms/GBLOCK/join')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('removed from this room');
  });

  it('does not block a different player in the same room', async () => {
    const { blockPlayer } = require('../rooms/roomBlocklist');
    blockPlayer('PARTBL', 'blocked-player-id');

    // A different player tries to join — should succeed
    const otherUserId = 'different-player-uuid';
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: otherUserId, email: 'other@e.com' } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { id: 'r', code: 'PARTBL', status: 'waiting', player_count: 6 },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms/PARTBL/join')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.allowed).toBe(true);
  });

  it('blocklist is per-room — blocked from one room can join another', async () => {
    const userId = 'cross-room-player';
    const { blockPlayer } = require('../rooms/roomBlocklist');
    blockPlayer('ROOMX1', userId); // blocked only in ROOMX1

    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: userId, email: 'cr@e.com' } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { id: 'r', code: 'ROOMX2', status: 'waiting', player_count: 6 },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms/ROOMX2/join')
      .set('Authorization', 'Bearer valid-token');

    // Should be allowed in the other room
    expect(res.status).toBe(200);
    expect(res.body.allowed).toBe(true);
  });

  // ── Kick then rejoin cycle ─────────────────────────────────────────────────

  it('full cycle: kick via kick endpoint then rejoin is rejected', async () => {
    const hostUserId = 'host-full-cycle';
    const targetUserId = 'target-full-cycle';

    // Step 1: Host kicks the player
    mockSupabase.auth.getUser
      .mockResolvedValueOnce({
        data: { user: { id: hostUserId, email: 'host@cycle.com' } },
        error: null,
      })
      // Step 2: Player tries to rejoin (auth)
      .mockResolvedValueOnce({
        data: { user: { id: targetUserId, email: 'target@cycle.com' } },
        error: null,
      });

    // Room lookup for the kick
    mockSupabase._chain.maybeSingle
      .mockResolvedValueOnce({
        data: {
          id: 'cycle-room',
          code: 'CYCLE1',
          host_user_id: hostUserId,
          status: 'in_progress',
        },
        error: null,
      });
    // Room lookup for the join (would be called only if blocklist check passes)
    // Since the player is blocked the route returns early before the DB call.

    const kickRes = await request(app)
      .post('/api/rooms/CYCLE1/kick')
      .set('Authorization', 'Bearer host-token')
      .send({ targetPlayerId: targetUserId });

    expect(kickRes.status).toBe(200);
    expect(kickRes.body.kicked).toBe(true);

    // Step 2: Kicked player tries to rejoin
    const joinRes = await request(app)
      .post('/api/rooms/CYCLE1/join')
      .set('Authorization', 'Bearer target-token');

    expect(joinRes.status).toBe(403);
    expect(joinRes.body.error).toContain('removed from this room');
  });

  // ── Auth errors ────────────────────────────────────────────────────────────

  it('returns 401 when no token provided', async () => {
    const res = await request(app).post('/api/rooms/ABCDEF/join');
    expect(res.status).toBe(401);
  });

  // ── Room state errors ──────────────────────────────────────────────────────

  it('returns 404 when room does not exist', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'u', email: 'u@e.com' } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms/NOFIND/join')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(404);
  });

  it('returns 410 when room is completed', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'u', email: 'u@e.com' } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { id: 'r', code: 'DONE01', status: 'completed', player_count: 6 },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms/DONE01/join')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(410);
    expect(res.body.error).toContain('no longer accepting');
  });

  it('returns 410 when room is cancelled', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'u', email: 'u@e.com' } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { id: 'r', code: 'CNCLD1', status: 'cancelled', player_count: 8 },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms/CNCLD1/join')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(410);
  });

  it('returns 400 for invalid room code format', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'u', email: 'u@e.com' } },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms/AB/join')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/rooms/:code/blocklist
// ---------------------------------------------------------------------------

describe('GET /api/rooms/:code/blocklist', () => {
  let app;
  let mockSupabase;

  beforeEach(() => {
    jest.resetModules();
    const { _setSupabaseClient } = require('../db/supabase');
    mockSupabase = buildMockSupabase();
    _setSupabaseClient(mockSupabase);
    const { _resetForTests } = require('../rooms/roomBlocklist');
    _resetForTests();
    app = require('../index');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns 200 with the blocklist for the room host', async () => {
    const hostId = 'host-bl-view';
    const { blockPlayer } = require('../rooms/roomBlocklist');
    blockPlayer('BLVIEW', 'pid-blocked-1');
    blockPlayer('BLVIEW', 'pid-blocked-2');

    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: hostId, email: 'host@bl.com' } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { id: 'r', host_user_id: hostId },
      error: null,
    });

    const res = await request(app)
      .get('/api/rooms/BLVIEW/blocklist')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.roomCode).toBe('BLVIEW');
    expect(res.body.blockedPlayers).toHaveLength(2);
    expect(res.body.blockedPlayers).toContain('pid-blocked-1');
    expect(res.body.blockedPlayers).toContain('pid-blocked-2');
  });

  it('returns 200 with empty array when no one has been blocked', async () => {
    const hostId = 'host-empty-bl';

    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: hostId, email: 'h@e.com' } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { id: 'r', host_user_id: hostId },
      error: null,
    });

    const res = await request(app)
      .get('/api/rooms/EMPTYB/blocklist')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.blockedPlayers).toEqual([]);
  });

  it('returns 403 when a non-host registered user requests the blocklist', async () => {
    const notHostId = 'not-host';

    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: notHostId, email: 'nh@e.com' } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { id: 'r', host_user_id: 'real-host' },
      error: null,
    });

    const res = await request(app)
      .get('/api/rooms/BLLIST/blocklist')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(403);
  });

  it('returns 403 when a guest requests the blocklist', async () => {
    const { createGuestSession, _clearStore } = require('../sessions/guestSessionStore');
    _clearStore();
    const { token } = createGuestSession('GuestPeek', 'avatar-4');

    const res = await request(app)
      .get('/api/rooms/BLLIST/blocklist')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/rooms/BLLIST/blocklist');
    expect(res.status).toBe(401);
  });

  it('returns 404 when room does not exist', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'host-id', email: 'h@e.com' } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: null,
    });

    const res = await request(app)
      .get('/api/rooms/NOFND2/blocklist')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

/**
 * Builds a chainable Supabase mock.
 */
function buildMockSupabase() {
  const maybeSingle = jest.fn();
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

  const from = jest.fn().mockReturnValue(chain);

  return {
    from,
    auth: {
      getUser: jest.fn(),
    },
    _chain: chain,
  };
}
