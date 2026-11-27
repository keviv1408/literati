/**
 * Integration tests for POST /api/rooms and GET /api/rooms/:code
 *
 * All Supabase calls are mocked so no real DB connection is needed.
 */

const request = require('supertest');
const { _setSupabaseClient } = require('../db/supabase');
const { setGame, deleteGame } = require('../game/gameStore');
const roomsApp = require('../index');

describe('returning while the first game snapshot is pending', () => {
  const code = 'START1';

  afterEach(() => deleteGame(code));

  it('switches Home and the game page to the live game as soon as the seats exist', async () => {
    const db = buildMockSupabase();
    _setSupabaseClient(db);
    db.auth.getUser.mockResolvedValue({ data: { user: { id: 'owner' } } });
    const room = { code, status: 'starting', player_count: 6 };
    const chain = db._chain;
    chain.order.mockResolvedValue({ data: [room] });
    chain.maybeSingle.mockResolvedValue({ data: room });
    chain.eq.mockImplementation(column => column === 'is_matchmaking' ? Promise.resolve({ data: [room] }) : chain);
    const returnFromHome = () => request(roomsApp).post('/api/rooms/return').set('Authorization', 'Bearer valid-token').send({ codes: [code] });
    const loadPage = () => request(roomsApp).get(`/api/rooms/${code}`);

    expect((await returnFromHome()).body).toEqual({ room: { code, destination: 'lobby' }, hosting: true });
    expect((await loadPage()).body.room.status).toBe('starting');

    setGame(code, { status: 'active', players: [{ playerId: 'owner' }] });

    expect((await returnFromHome()).body).toEqual({ room: { code, destination: 'game' }, hosting: true });
    expect((await loadPage()).body.room.status).toBe('in_progress');
    expect(chain.select).not.toHaveBeenCalledWith('code, game_state');

    db.auth.getUser.mockResolvedValue({ data: { user: { id: 'visitor' } } });
    chain.order.mockResolvedValue({ data: [] });
    expect((await returnFromHome()).body).toEqual({ room: null, hosting: false });
  });
});

// We need to set the mock BEFORE requiring the app, because the app and
// routes import supabase at module load time via getSupabaseClient().
// Use jest.resetModules() before each test block to get a fresh state.

describe('POST /api/rooms', () => {
  let app;
  let mockSupabase;
  let originalFrontendUrl;

  beforeEach(() => {
    originalFrontendUrl = process.env.FRONTEND_URL;
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
    if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = originalFrontendUrl;
    jest.clearAllMocks();
    const { _clearStore } = require('../sessions/guestSessionStore');
    _clearStore();
  });

  it.each([
    ['owner', true, 200],
    ['visitor', false, 409],
    ['owner', false, 409],
  ])('claims a waiting private room for %s only while filters match (%s)', async (id, matched, status) => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id } } });
    const chain = mockSupabase._chain;
    chain.update = jest.fn().mockReturnValue(chain);
    chain.maybeSingle.mockResolvedValue({ data: matched ? { code: 'ABC123' } : null });
    const response = await request(app).post('/api/rooms/ABC123/abandon').set('Authorization', 'Bearer token');
    expect(response.status).toBe(status);
    expect(chain.update).toHaveBeenCalledWith({ status: 'cancelled' });
    expect(chain.in).toHaveBeenCalledWith('status', ['waiting', 'cancelled']);
    expect(chain.eq.mock.calls).toEqual(expect.arrayContaining([
      ['code', 'ABC123'], ['is_matchmaking', false], ['host_user_id', id],
    ]));
  });

  it.each([true, false])('checks guest host ownership when abandoning (%s)', async (matched) => {
    const { createGuestSession } = require('../sessions/guestSessionStore');
    const { token, session } = createGuestSession('Guest');
    const chain = mockSupabase._chain;
    chain.update = jest.fn().mockReturnValue(chain);
    chain.maybeSingle.mockResolvedValue({ data: matched ? { code: 'ABC123' } : null });
    const response = await request(app).post('/api/rooms/ABC123/abandon').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(matched ? 200 : 409);
    expect(chain.eq).toHaveBeenCalledWith('host_guest_id', session.sessionId);
  });

  it('finds the authenticated host lobby without any client hints', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'owner' } } });
    const lobby = { code: 'ABC123', status: 'waiting' };
    const chain = mockSupabase._chain;
    chain.order.mockResolvedValue({ data: [lobby] });
    chain.eq.mockImplementation(column => column === 'is_matchmaking' ? Promise.resolve({ data: [lobby] }) : chain);

    const response = await request(app).post('/api/rooms/return').set('Authorization', 'Bearer valid-token').send({ codes: [] });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ room: { code: 'ABC123', destination: 'lobby' }, hosting: true });
    expect(mockSupabase._chain.eq).toHaveBeenCalledWith('host_user_id', 'owner');
  });

  it('returns a saved bot-covered seat only to its original player', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'owner' } } });
    const chain = mockSupabase._chain;
    chain.order.mockResolvedValue({ data: [] });
    chain.eq.mockImplementation((column) => {
      if (column === 'is_matchmaking') return Promise.resolve({ data: [{ code: 'ABC123', status: 'in_progress' }] });
      if (column === 'status') return Promise.resolve({ data: [{ code: 'ABC123', game_state: {
        status: 'active', players: [{ playerId: 'owner', isBot: true }], hands: { owner: ['secret'] },
      } }] });
      return chain;
    });
    const lookup = () => request(app).post('/api/rooms/return').set('Authorization', 'Bearer valid-token').send({ codes: ['ABC123'] });

    expect((await lookup()).body).toEqual({ room: { code: 'ABC123', destination: 'game' }, hosting: false });
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'stranger' } } });
    expect((await lookup()).body).toEqual({ room: null, hosting: false });
  });

  it.each([
    ['waiting', ['JOIN02']],
    ['waiting', ['HOST01', 'JOIN02']],
    ['waiting', ['STALE9', 'HOST01', 'JOIN02']],
    ['in_progress', ['JOIN02']],
  ])('offers the joined game alongside an owned %s room with hints %j', async (status, codes) => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'owner' } } });
    const hosted = { code: 'HOST01', status };
    const joined = { code: 'JOIN02', status: 'in_progress' };
    const chain = mockSupabase._chain;
    chain.order.mockResolvedValue({ data: [hosted] });
    chain.eq.mockImplementation((column) => {
      if (column === 'is_matchmaking') return Promise.resolve({ data: [hosted, joined] });
      if (column === 'status') return Promise.resolve({ data: [
        { code: hosted.code, game_state: { status: 'active', players: [{ playerId: 'other' }] } },
        { code: joined.code, game_state: { status: 'active', players: [{ playerId: 'owner' }] } },
      ] });
      return chain;
    });

    const response = await request(app).post('/api/rooms/return').set('Authorization', 'Bearer valid-token').send({ codes });

    expect(response.body).toEqual({
      room: { code: joined.code, destination: 'game' }, hosting: true,
      ...(status === 'waiting' ? { hostedLobby: hosted.code } : {}),
    });
  });

  it('offers an older transferred lobby alongside a newer hosted game without client hints', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'owner' } } });
    const game = { code: 'GAME01', status: 'in_progress' };
    const lobby = { code: 'LOBBY2', status: 'waiting' };
    const chain = mockSupabase._chain;
    chain.order.mockResolvedValue({ data: [game, lobby] });
    chain.eq.mockImplementation((column) => {
      if (column === 'is_matchmaking') return Promise.resolve({ data: [lobby, game] });
      if (column === 'status') return Promise.resolve({ data: [
        { code: game.code, game_state: { status: 'active', players: [{ playerId: 'owner' }] } },
      ] });
      return chain;
    });

    const response = await request(app).post('/api/rooms/return').set('Authorization', 'Bearer valid-token').send({ codes: [] });

    expect(chain.in).toHaveBeenCalledWith('code', [game.code, lobby.code]);
    expect(response.body).toEqual({ room: { code: game.code, destination: 'game' }, hosting: true, hostedLobby: lobby.code });
  });

  it('rejects a waiting lobby hint without current or previous seating', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'spectator' } } });
    const chain = mockSupabase._chain;
    chain.order.mockResolvedValue({ data: [] });
    chain.eq.mockImplementation((column) => column === 'is_matchmaking'
      ? Promise.resolve({ data: [{ code: 'ABC123', status: 'waiting', player_count: 6 }] })
      : chain);
    const response = await request(app).post('/api/rooms/return').set('Authorization', 'Bearer valid-token').send({ codes: ['ABC123'] });

    expect(response.body).toEqual({ room: null, hosting: false });
    expect(chain.in).toHaveBeenCalledWith('status', ['waiting', 'starting', 'in_progress']);
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

    process.env.FRONTEND_URL = 'https://literati-ochre.vercel.app';

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
    expect(res.body.inviteLink).toBe('https://literati-ochre.vercel.app/room/ABC123');
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

    mockSupabase._chain.limit.mockResolvedValueOnce({
      data: [{ id: 'existing-room', code: 'XYZ999', status: 'waiting' }],
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms')
      .set('Authorization', 'Bearer valid-token')
      .send({ playerCount: 8, cardRemovalVariant: 'remove_2s' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('active game room');
    expect(res.body.existingRoom.code).toBe('XYZ999');
    expect(mockSupabase._chain.eq).toHaveBeenCalledWith('host_user_id', fakeUserId);
    expect(mockSupabase._chain.eq).not.toHaveBeenCalledWith('host_guest_id', expect.anything());
  });

  it('stores a guest host in host_guest_id and leaves host_user_id null', async () => {
    const { createGuestSession } = require('../sessions/guestSessionStore');
    const { token, session } = createGuestSession('Guest Host');
    mockSupabase._chain.maybeSingle.mockResolvedValue({ data: null, error: null });
    mockSupabase._chain.single.mockResolvedValueOnce({
      data: { id: 'guest-room-id', code: 'GUEST1', host_user_id: null, host_guest_id: session.sessionId },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerCount: 6, cardRemovalVariant: 'remove_7s' });

    expect(res.status).toBe(201);
    const insertCall = mockSupabase._chain.insert.mock.calls[0][0];
    expect(insertCall.host_guest_id).toBe(session.sessionId);
    expect(insertCall.host_user_id).toBeNull();
  });

  it('stores a registered host in host_user_id and leaves host_guest_id null', async () => {
    const fakeUserId = 'user-registered-host';
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: fakeUserId } },
      error: null,
    });
    mockSupabase._chain.maybeSingle.mockResolvedValue({ data: null, error: null });
    mockSupabase._chain.single.mockResolvedValueOnce({
      data: { id: 'room-id', code: 'AABBCC', host_user_id: fakeUserId, host_guest_id: null },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms')
      .set('Authorization', 'Bearer valid-token')
      .send({ playerCount: 6, cardRemovalVariant: 'remove_7s' });

    expect(res.status).toBe(201);
    const insertCall = mockSupabase._chain.insert.mock.calls[0][0];
    expect(insertCall.host_user_id).toBe(fakeUserId);
    expect(insertCall.host_guest_id).toBeNull();
  });

  it('returns 409 when a guest already hosts an active room, querying host_guest_id', async () => {
    const { createGuestSession } = require('../sessions/guestSessionStore');
    const { token, session } = createGuestSession('Guest Host');
    mockSupabase._chain.limit.mockResolvedValueOnce({
      data: [{ id: 'guest-room-id', code: 'GUEST1', status: 'waiting' }],
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerCount: 6, cardRemovalVariant: 'remove_7s' });

    expect(res.status).toBe(409);
    expect(res.body.existingRoom).toEqual({ id: 'guest-room-id', code: 'GUEST1', status: 'waiting' });
    expect(mockSupabase._chain.eq).toHaveBeenCalledWith('host_guest_id', session.sessionId);
    expect(mockSupabase._chain.eq).not.toHaveBeenCalledWith('host_user_id', session.sessionId);
    expect(mockSupabase._chain.in).toHaveBeenCalledWith('status', ['waiting', 'starting', 'in_progress']);
    expect(mockSupabase._chain.insert).not.toHaveBeenCalled();
  });

  it('returns 409 with the newest room when a guest hosts two active rooms', async () => {
    const { createGuestSession } = require('../sessions/guestSessionStore');
    const { token } = createGuestSession('Guest Host');
    mockSupabase._chain.limit.mockResolvedValueOnce({
      data: [
        { id: 'newest-room', code: 'NEW111', status: 'in_progress' },
        { id: 'older-room', code: 'OLD222', status: 'waiting' },
      ],
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerCount: 6, cardRemovalVariant: 'remove_7s' });

    expect(res.status).toBe(409);
    expect(res.body.existingRoom).toEqual({ id: 'newest-room', code: 'NEW111', status: 'in_progress' });
    expect(mockSupabase._chain.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(mockSupabase._chain.limit).toHaveBeenCalledWith(1);
  });

  it('lets a guest create a room when their only hosted room is abandoned', async () => {
    const { createGuestSession } = require('../sessions/guestSessionStore');
    const { token, session } = createGuestSession('Guest Host');
    mockSupabase._chain.limit.mockResolvedValueOnce({ data: [], error: null });
    mockSupabase._chain.maybeSingle.mockResolvedValue({ data: null, error: null });
    mockSupabase._chain.single.mockResolvedValueOnce({
      data: { id: 'new-guest-room-id', code: 'NEW123', host_user_id: null, host_guest_id: session.sessionId },
      error: null,
    });

    const res = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerCount: 6, cardRemovalVariant: 'remove_7s' });

    expect(res.status).toBe(201);
    expect(res.body.room.code).toBe('NEW123');
    expect(mockSupabase._chain.eq).toHaveBeenCalledWith('host_guest_id', session.sessionId);
    expect(mockSupabase._chain.in).toHaveBeenCalledWith('status', ['waiting', 'starting', 'in_progress']);
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
  let originalFrontendUrl;

  beforeEach(() => {
    originalFrontendUrl = process.env.FRONTEND_URL;
    jest.resetModules();
    mockSupabase = buildMockSupabase();
    const { _setSupabaseClient: set } = require('../db/supabase');
    set(mockSupabase);
    app = require('../index');
  });

  afterEach(() => {
    if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = originalFrontendUrl;
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

    process.env.FRONTEND_URL = 'https://cards.example.org:8443/';

    const res = await request(app).get('/api/rooms/ABCDEF');

    expect(res.status).toBe(200);
    expect(res.body.room.code).toBe('ABCDEF');
    // invite_code is included in public GET response
    expect(res.body.room.invite_code).toBe('E7F6A5B4C3D21098');
    // spectator_token is NOT in GET response (security)
    expect(res.body.room).not.toHaveProperty('spectator_token');
    expect(res.body.room.players).toEqual([]);
    expect(res.body.inviteLink).toBe('https://cards.example.org:8443/room/ABCDEF');
    expect(res.body).not.toHaveProperty('spectatorLink');
  });

  it('includes the players currently connected to the lobby', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValue({
      data: { id: 'room-uuid', code: 'ABCDEF', status: 'waiting', player_count: 6 },
      error: null,
    });
    const { roomClients } = require('../ws/roomSocketServer');
    roomClients.set('ABCDEF', new Map([
      ['u1', { ws: {}, userId: 'u1', displayName: 'HostA', avatarId: 'avatar-3', isGuest: true, isHost: true, teamId: 1 }],
      ['u2', { ws: {}, userId: 'u2', displayName: 'Bea', isGuest: true, isHost: false, teamId: 2 }],
    ]));

    const res = await request(app).get('/api/rooms/abcdef');

    expect(res.status).toBe(200);
    expect(res.body.room.players).toEqual([
      { userId: 'u1', displayName: 'HostA', avatarId: 'avatar-3', isGuest: true, isHost: true, teamId: 1 },
      { userId: 'u2', displayName: 'Bea', avatarId: null, isGuest: true, isHost: false, teamId: 2 },
    ]);
    roomClients.delete('ABCDEF');
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
 * The._chain property exposes the terminal mocks for test assertions.
 */
function buildMockSupabase() {
  const maybeSingle = jest.fn();
  const single = jest.fn();
  const select = jest.fn();
  const eq = jest.fn();
  const insert = jest.fn();
  const inFn = jest.fn();
  const order = jest.fn();
  const limit = jest.fn().mockResolvedValue({ data: [], error: null });

  // Build the fluent chain
  const chain = { select, eq, maybeSingle, single, in: inFn, insert, order, limit };

  select.mockReturnValue(chain);
  eq.mockReturnValue(chain);
  inFn.mockReturnValue(chain);
  insert.mockReturnValue(chain);
  order.mockReturnValue(chain);

  const from = jest.fn().mockReturnValue(chain);

  return {
    from,
    auth: {
      getUser: jest.fn(),
    },
    _chain: chain,
  };
}
