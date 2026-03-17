/**
 * Integration tests for POST /api/rooms and GET /api/rooms/:code
 *
 * All Supabase calls are mocked so no real DB connection is needed.
 */

const request = require('supertest');
const { _setSupabaseClient } = require('../db/supabase');

// We need to set the mock BEFORE requiring the app, because the app and
// routes import supabase at module load time via getSupabaseClient().
// Use jest.resetModules() before each test block to get a fresh state.

describe('POST /api/rooms', () => {
  let app;
  let mockSupabase;

  beforeEach(() => {
    // Build a fresh mock for each test
    mockSupabase = buildMockSupabase();
    _setSupabaseClient(mockSupabase);

    // Re-require app so environment is fresh
    jest.resetModules();
    // Re-set mock after module reset
    const { _setSupabaseClient: set } = require('../db/supabase');
    set(mockSupabase);
    app = require('../index');
  });

  afterEach(() => {
    jest.clearAllMocks();
    const { _clearStore } = require('../sessions/guestSessionStore');
    _clearStore();
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('creates a room and returns 201 with room details including invite_code and spectator_token', async () => {
    const fakeUserId = 'user-uuid-123';
    const fakeRoom = {
      id: 'room-uuid-456',
      code: 'ABC123',
      invite_code: 'A3F2C91E7B046D52',
      spectator_token: 'A3F2C91E7B046D52C91E7B046D52A3F2',
      host_user_id: fakeUserId,
      player_count: 6,
      card_removal_variant: 'remove_7s',
      status: 'waiting',
      created_at: '2026-03-14T00:00:00.000Z',
      updated_at: '2026-03-14T00:00:00.000Z',
    };

    // Auth: user lookup returns fakeUserId
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: fakeUserId, email: 'test@example.com' } },
      error: null,
    });

    // Existing active room check: none found
    mockSupabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null }) // uniqueness check
      .mockResolvedValueOnce({ data: null, error: null }); // existing room check

    // Room code uniqueness: no collision
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: null,
    });

    // Insert: returns the new room
    mockSupabase._chain.single.mockResolvedValueOnce({
      data: fakeRoom,
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms')
      .set('Authorization', 'Bearer valid-token')
      .send({ playerCount: 6, cardRemovalVariant: 'remove_7s' });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('room');
    expect(res.body.room.host_user_id).toBe(fakeUserId);
    expect(res.body.room.player_count).toBe(6);
    expect(res.body.room.card_removal_variant).toBe('remove_7s');
    expect(res.body.room.status).toBe('waiting');
    expect(res.body.room.code).toHaveLength(6);
    // invite_code: 16-char hex token
    expect(res.body.room.invite_code).toHaveLength(16);
    expect(res.body.room.invite_code).toMatch(/^[0-9A-F]{16}$/i);
    // spectator_token: 32-char hex token
    expect(res.body.room.spectator_token).toHaveLength(32);
    expect(res.body.room.spectator_token).toMatch(/^[0-9A-F]{32}$/i);
  });

  it('insert payload includes invite_code and spectator_token', async () => {
    const fakeUserId = 'user-insert-check';
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: fakeUserId } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValue({ data: null, error: null });
    mockSupabase._chain.single.mockResolvedValue({
      data: {
        id: 'room-id',
        code: 'AABBCC',
        invite_code: 'B4E3D20F9C158A71',
        spectator_token: 'B4E3D20F9C158A71B4E3D20F9C158A71',
        host_user_id: fakeUserId,
        player_count: 6,
        card_removal_variant: 'remove_7s',
        status: 'waiting',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms')
      .set('Authorization', 'Bearer valid-token')
      .send({ playerCount: 6, cardRemovalVariant: 'remove_7s' });

    expect(res.status).toBe(201);

    // Verify the insert() was called with invite_code and spectator_token
    const insertCall = mockSupabase._chain.insert.mock.calls[0][0];
    expect(insertCall).toHaveProperty('invite_code');
    expect(insertCall).toHaveProperty('spectator_token');
    expect(insertCall.invite_code).toMatch(/^[0-9A-F]{16}$/i);
    expect(insertCall.spectator_token).toMatch(/^[0-9A-F]{32}$/i);
  });

  // ── Validation errors ──────────────────────────────────────────────────────

  it('returns 400 when playerCount is missing', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-123' } },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms')
      .set('Authorization', 'Bearer valid-token')
      .send({ cardRemovalVariant: 'remove_7s' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details).toContain('playerCount is required');
  });

  it('returns 400 when playerCount is invalid (e.g. 7)', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-123' } },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms')
      .set('Authorization', 'Bearer valid-token')
      .send({ playerCount: 7, cardRemovalVariant: 'remove_7s' });

    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => d.includes('playerCount'))).toBe(true);
  });

  it('returns 400 when cardRemovalVariant is missing', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-123' } },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms')
      .set('Authorization', 'Bearer valid-token')
      .send({ playerCount: 8 });

    expect(res.status).toBe(400);
    expect(res.body.details).toContain('cardRemovalVariant is required');
  });

  it('returns 400 when cardRemovalVariant is invalid', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-123' } },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms')
      .set('Authorization', 'Bearer valid-token')
      .send({ playerCount: 6, cardRemovalVariant: 'remove_jokers' });

    expect(res.status).toBe(400);
    expect(
      res.body.details.some((d) => d.includes('cardRemovalVariant'))
    ).toBe(true);
  });

  it('returns 400 for both missing fields simultaneously', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-123' } },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms')
      .set('Authorization', 'Bearer valid-token')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.details).toHaveLength(2);
  });

  // ── Auth errors ────────────────────────────────────────────────────────────

  it('returns 401 when Authorization header is missing', async () => {
    const res = await request(app)
      .post('/api/rooms')
      .send({ playerCount: 6, cardRemovalVariant: 'remove_7s' });

    expect(res.status).toBe(401);
  });

  it('returns 401 when token is invalid', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Invalid JWT' },
    });

    const res = await request(app)
      .post('/api/rooms')
      .set('Authorization', 'Bearer bad-token')
      .send({ playerCount: 6, cardRemovalVariant: 'remove_7s' });

    expect(res.status).toBe(401);
  });

  // ── One active game per account ────────────────────────────────────────────

  it('returns 409 when host already has an active room', async () => {
    const fakeUserId = 'user-active-room';
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: fakeUserId } },
      error: null,
    });

    // The route checks for an existing active room FIRST (before generating a
    // room code), so the first maybeSingle call must return the existing room.
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { id: 'existing-room', code: 'XYZ999', status: 'waiting' },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms')
      .set('Authorization', 'Bearer valid-token')
      .send({ playerCount: 8, cardRemovalVariant: 'remove_2s' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('active game room');
    expect(res.body.existingRoom.code).toBe('XYZ999');
  });

  it('returns guest existing room code when a guest host already has an active room', async () => {
    const { createGuestSession } = require('../sessions/guestSessionStore');
    const { token, session } = createGuestSession('Guest Host');
    const fakeGuestRoom = {
      id: 'guest-room-id',
      code: 'GUEST1',
      invite_code: 'A3F2C91E7B046D52',
      spectator_token: 'A3F2C91E7B046D52C91E7B046D52A3F2',
      host_user_id: null,
      player_count: 6,
      card_removal_variant: 'remove_7s',
      status: 'waiting',
      created_at: '2026-03-16T00:00:00.000Z',
      updated_at: '2026-03-16T00:00:00.000Z',
    };

    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: null,
    });
    mockSupabase._chain.single.mockResolvedValueOnce({
      data: fakeGuestRoom,
      error: null,
    });

    const creationRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerCount: 6, cardRemovalVariant: 'remove_7s' });

    expect(creationRes.status).toBe(201);

    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { id: fakeGuestRoom.id, code: fakeGuestRoom.code, status: 'waiting' },
      error: null,
    });

    const conflictRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerCount: 6, cardRemovalVariant: 'remove_7s' });

    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.existingRoom.id).toBe(fakeGuestRoom.id);
    expect(conflictRes.body.existingRoom.code).toBe(fakeGuestRoom.code);
    expect(conflictRes.body.existingRoom.status).toBe('waiting');
    expect(session.displayName).toBe('Guest Host');
  });

  it('allows a guest host to create a new room after their previous room completed', async () => {
    const { createGuestSession } = require('../sessions/guestSessionStore');
    const { guestHostMap } = require('../routes/rooms');
    const { token, session } = createGuestSession('Guest Host');
    const staleRoomId = 'completed-room-id';
    const freshGuestRoom = {
      id: 'new-guest-room-id',
      code: 'NEW123',
      invite_code: 'B3F2C91E7B046D52',
      spectator_token: 'B3F2C91E7B046D52C91E7B046D52B3F2',
      host_user_id: null,
      player_count: 6,
      card_removal_variant: 'remove_7s',
      status: 'waiting',
      created_at: '2026-03-17T00:00:00.000Z',
      updated_at: '2026-03-17T00:00:00.000Z',
    };

    guestHostMap.set(staleRoomId, session.sessionId);

    mockSupabase._chain.maybeSingle
      .mockResolvedValueOnce({
        data: { id: staleRoomId, code: 'OLD123', status: 'completed' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: null,
      });
    mockSupabase._chain.single.mockResolvedValueOnce({
      data: freshGuestRoom,
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerCount: 6, cardRemovalVariant: 'remove_7s' });

    expect(res.status).toBe(201);
    expect(res.body.room.code).toBe('NEW123');
    expect(guestHostMap.has(staleRoomId)).toBe(false);
    expect(guestHostMap.get(freshGuestRoom.id)).toBe(session.sessionId);
  });

  // ── All card removal variants accepted ────────────────────────────────────

  it.each(['remove_2s', 'remove_7s', 'remove_8s'])(
    'accepts cardRemovalVariant=%s',
    async (variant) => {
      mockSupabase.auth.getUser.mockResolvedValue({
        data: { user: { id: 'user-' + variant } },
        error: null,
      });
      mockSupabase._chain.maybeSingle
        .mockResolvedValue({ data: null, error: null });
      mockSupabase._chain.single.mockResolvedValue({
        data: {
          id: 'room-id',
          code: 'AABBCC',
          invite_code: 'C5D4E3F2A1B0987F',
          spectator_token: 'C5D4E3F2A1B0987FC5D4E3F2A1B0987F',
          host_user_id: 'user-' + variant,
          player_count: 6,
          card_removal_variant: variant,
          status: 'waiting',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        error: null,
      });

      const res = await request(app)
        .post('/api/rooms')
        .set('Authorization', 'Bearer valid-token')
        .send({ playerCount: 6, cardRemovalVariant: variant });

      expect(res.status).toBe(201);
      expect(res.body.room.card_removal_variant).toBe(variant);
    }
  );

  // ── Both player counts accepted ────────────────────────────────────────────

  it.each([6, 8])('accepts playerCount=%i', async (count) => {
    const userId = 'user-count-' + count;
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: userId } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValue({ data: null, error: null });
    mockSupabase._chain.single.mockResolvedValue({
      data: {
        id: 'room-id',
        code: 'ABCDEF',
        invite_code: 'D6E5F4A3B2C19087',
        spectator_token: 'D6E5F4A3B2C19087D6E5F4A3B2C19087',
        host_user_id: userId,
        player_count: count,
        card_removal_variant: 'remove_7s',
        status: 'waiting',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms')
      .set('Authorization', 'Bearer valid-token')
      .send({ playerCount: count, cardRemovalVariant: 'remove_7s' });

    expect(res.status).toBe(201);
    expect(res.body.room.player_count).toBe(count);
  });
});

// ── GET /api/rooms/:code ───────────────────────────────────────────────────────

describe('GET /api/rooms/:code', () => {
  let app;
  let mockSupabase;

  beforeEach(() => {
    jest.resetModules();
    mockSupabase = buildMockSupabase();
    const { _setSupabaseClient: set } = require('../db/supabase');
    set(mockSupabase);
    app = require('../index');
  });

  it('returns 200 with room when found, including invite_code', async () => {
    const fakeRoom = {
      id: 'room-uuid',
      code: 'ABCDEF',
      invite_code: 'E7F6A5B4C3D21098',
      host_user_id: 'user-uuid',
      player_count: 6,
      card_removal_variant: 'remove_7s',
      status: 'waiting',
      created_at: '2026-03-14T00:00:00Z',
      updated_at: '2026-03-14T00:00:00Z',
    };
    mockSupabase._chain.maybeSingle.mockResolvedValue({
      data: fakeRoom,
      error: null,
    });

    const res = await request(app).get('/api/rooms/ABCDEF');

    expect(res.status).toBe(200);
    expect(res.body.room.code).toBe('ABCDEF');
    // invite_code is included in public GET response
    expect(res.body.room.invite_code).toBe('E7F6A5B4C3D21098');
    // spectator_token is NOT in GET response (security)
    expect(res.body.room).not.toHaveProperty('spectator_token');
  });

  it('returns 404 when room not found', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValue({
      data: null,
      error: null,
    });

    const res = await request(app).get('/api/rooms/ZZZZZZ');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Room not found');
  });

  it('is case-insensitive (lowercase code is uppercased)', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValue({
      data: null,
      error: null,
    });

    // Should not 400 for lowercase — just not found
    const res = await request(app).get('/api/rooms/abcdef');
    expect([200, 404]).toContain(res.status);
  });

  it('returns 400 for invalid room code length', async () => {
    const res = await request(app).get('/api/rooms/ABC');
    expect(res.status).toBe(400);
  });
});

// ── Mock factory ───────────────────────────────────────────────────────────────

/**
 * Builds a chainable Supabase mock that tracks calls across the fluent API.
 * The ._chain property exposes the terminal mocks for test assertions.
 */
function buildMockSupabase() {
  const maybeSingle = jest.fn();
  const single = jest.fn();
  const select = jest.fn();
  const eq = jest.fn();
  const insert = jest.fn();
  const inFn = jest.fn();

  // Build the fluent chain
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
