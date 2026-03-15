'use strict';

/**
 * Integration tests for auth routes:
 *   POST   /api/auth/guest   — create a guest session
 *   DELETE /api/auth/guest   — destroy a guest session
 *   GET    /api/auth/me      — return current identity
 *   GET    /api/auth/avatars — return valid avatar IDs
 *
 * No real Supabase connections are made. Registered-user paths mock
 * Supabase; guest paths use the in-memory store directly.
 */

const request = require('supertest');

// We need a fresh module state for each describe block so that env vars and
// the in-memory store are predictable.
function loadApp(mockSupabase) {
  jest.resetModules();
  if (mockSupabase) {
    const { _setSupabaseClient } = require('../db/supabase');
    _setSupabaseClient(mockSupabase);
  }
  const { stopCleanupTimer, _clearStore } = require('../sessions/guestSessionStore');
  _clearStore();
  stopCleanupTimer();
  return require('../index');
}

function buildMockSupabase(userResult) {
  return {
    auth: {
      getUser: jest.fn().mockResolvedValue(userResult),
    },
    from: jest.fn(),
  };
}

afterEach(() => {
  jest.clearAllMocks();
});

// =============================================================================
// POST /api/auth/guest
// =============================================================================

describe('POST /api/auth/guest', () => {
  let app;

  beforeEach(() => {
    app = loadApp();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it('returns 201 with token, session, and validAvatarIds', async () => {
    const res = await request(app)
      .post('/api/auth/guest')
      .send({ displayName: 'Alice' });

    expect(res.status).toBe(201);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThanOrEqual(32);

    expect(res.body.session).toMatchObject({
      displayName: 'Alice',
      isGuest: true,
    });
    expect(typeof res.body.session.sessionId).toBe('string');
    expect(typeof res.body.session.expiresAt).toBe('number');

    expect(Array.isArray(res.body.validAvatarIds)).toBe(true);
    expect(res.body.validAvatarIds.length).toBeGreaterThan(0);
    expect(typeof res.body.sessionTtlMs).toBe('number');
  });

  it('accepts a valid avatarId and reflects it in the session', async () => {
    const res = await request(app)
      .post('/api/auth/guest')
      .send({ displayName: 'Bob', avatarId: 'avatar-5' });

    expect(res.status).toBe(201);
    expect(res.body.session.avatarId).toBe('avatar-5');
  });

  it('defaults to avatar-1 when avatarId is omitted', async () => {
    const res = await request(app)
      .post('/api/auth/guest')
      .send({ displayName: 'Carol' });

    expect(res.status).toBe(201);
    expect(res.body.session.avatarId).toBe('avatar-1');
  });

  it('trims whitespace from the displayName', async () => {
    const res = await request(app)
      .post('/api/auth/guest')
      .send({ displayName: '  Dave  ' });

    expect(res.status).toBe(201);
    expect(res.body.session.displayName).toBe('Dave');
  });

  it('generates distinct tokens on repeated calls', async () => {
    const tokens = new Set();
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/api/auth/guest')
        .send({ displayName: `Player${i}` });
      tokens.add(res.body.token);
    }
    expect(tokens.size).toBe(5);
  });

  it('does NOT persist anything to Supabase (from() is never called)', async () => {
    // The mock has from() — if it's called the test will notice.
    const mock = buildMockSupabase({ data: { user: null }, error: null });
    app = loadApp(mock);

    await request(app).post('/api/auth/guest').send({ displayName: 'NoDb' });

    expect(mock.from).not.toHaveBeenCalled();
    expect(mock.auth.getUser).not.toHaveBeenCalled();
  });

  // ── Validation errors ──────────────────────────────────────────────────────

  it('returns 400 when displayName is missing', async () => {
    const res = await request(app).post('/api/auth/guest').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details.some((d) => /displayName/i.test(d))).toBe(true);
  });

  it('returns 400 when displayName is an empty string', async () => {
    const res = await request(app)
      .post('/api/auth/guest')
      .send({ displayName: '' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when displayName is only whitespace', async () => {
    const res = await request(app)
      .post('/api/auth/guest')
      .send({ displayName: '   ' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when displayName exceeds 20 characters', async () => {
    const res = await request(app)
      .post('/api/auth/guest')
      .send({ displayName: 'A'.repeat(21) });

    expect(res.status).toBe(400);
  });

  it('accepts displayName of exactly 20 characters', async () => {
    const res = await request(app)
      .post('/api/auth/guest')
      .send({ displayName: 'A'.repeat(20) });

    expect(res.status).toBe(201);
  });

  it('returns 400 for an invalid avatarId', async () => {
    const res = await request(app)
      .post('/api/auth/guest')
      .send({ displayName: 'Eve', avatarId: 'not-a-real-avatar' });

    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => /avatarId/i.test(d))).toBe(true);
  });

  it('returns 400 when displayName is a number (not a string)', async () => {
    const res = await request(app)
      .post('/api/auth/guest')
      .send({ displayName: 42 });

    expect(res.status).toBe(400);
  });
});

// =============================================================================
// DELETE /api/auth/guest
// =============================================================================

describe('DELETE /api/auth/guest', () => {
  let app;

  beforeEach(() => {
    app = loadApp();
  });

  it('returns 200 and invalidates the guest session', async () => {
    // Create a session via the API
    const createRes = await request(app)
      .post('/api/auth/guest')
      .send({ displayName: 'Frank' });
    const { token } = createRes.body;

    // Delete it
    const deleteRes = await request(app)
      .delete('/api/auth/guest')
      .set('Authorization', `Bearer ${token}`);

    expect(deleteRes.status).toBe(200);

    // Confirm the session is gone — GET /me should now 401
    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(meRes.status).toBe(401);
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app).delete('/api/auth/guest');
    expect(res.status).toBe(401);
  });

  it('returns 200 even when called by a registered user (no-op for non-guests)', async () => {
    // Registered user: Supabase returns a valid user.
    const mock = buildMockSupabase({
      data: {
        user: { id: 'reg-user', email: 'r@r.com', user_metadata: {} },
      },
      error: null,
    });
    app = loadApp(mock);

    const res = await request(app)
      .delete('/api/auth/guest')
      .set('Authorization', 'Bearer registered-jwt');

    expect(res.status).toBe(200);
  });
});

// =============================================================================
// GET /api/auth/me
// =============================================================================

describe('GET /api/auth/me', () => {
  let app;

  beforeEach(() => {
    app = loadApp();
  });

  it('returns guest identity for a guest token', async () => {
    const createRes = await request(app)
      .post('/api/auth/guest')
      .send({ displayName: 'Grace', avatarId: 'avatar-7' });
    const { token } = createRes.body;

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.isGuest).toBe(true);
    expect(res.body.displayName).toBe('Grace');
    expect(res.body.avatarId).toBe('avatar-7');
    expect(typeof res.body.sessionId).toBe('string');
    // Must NOT expose internal _noDbWrites flag to the client
    expect(res.body._noDbWrites).toBeUndefined();
  });

  it('returns registered user identity for a Supabase token', async () => {
    const mock = buildMockSupabase({
      data: {
        user: {
          id: 'user-abc',
          email: 'user@example.com',
          user_metadata: { display_name: 'RegUser', avatar_id: 'avatar-9' },
        },
      },
      error: null,
    });
    app = loadApp(mock);

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer supabase-jwt');

    expect(res.status).toBe(200);
    expect(res.body.isGuest).toBe(false);
    expect(res.body.id).toBe('user-abc');
    expect(res.body.email).toBe('user@example.com');
    expect(res.body.displayName).toBe('RegUser');
    expect(res.body.avatarId).toBe('avatar-9');
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns 401 for an expired / unknown token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer expired-unknown-token');
    expect(res.status).toBe(401);
  });
});

// =============================================================================
// GET /api/auth/avatars
// =============================================================================

describe('GET /api/auth/avatars', () => {
  let app;

  beforeEach(() => {
    app = loadApp();
  });

  it('returns 200 with a non-empty list of avatar IDs', async () => {
    const res = await request(app).get('/api/auth/avatars');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.avatarIds)).toBe(true);
    expect(res.body.avatarIds.length).toBeGreaterThan(0);
  });

  it('is a public endpoint — works without any auth token', async () => {
    const res = await request(app).get('/api/auth/avatars');
    expect(res.status).toBe(200);
  });

  it('avatar IDs match the format avatar-N', async () => {
    const res = await request(app).get('/api/auth/avatars');
    for (const id of res.body.avatarIds) {
      expect(id).toMatch(/^avatar-\d+$/);
    }
  });
});

// =============================================================================
// GET /api/auth/me — profile enrichment from user_profiles
// =============================================================================
//
// The /me endpoint fetches the authoritative display_name and avatar_id from
// the user_profiles table. This is important for Google OAuth users whose
// display name is stored in user_profiles (set by the OAuth callback route),
// not in user_metadata.

describe('GET /api/auth/me: profile enrichment', () => {
  /**
   * Build a Supabase mock that supports the chained profile query used in /me:
   *   supabase.from('user_profiles').select(...).eq(...).maybeSingle()
   */
  function buildProfileMock(userResult, profileResult) {
    const maybeSingleMock = jest.fn().mockResolvedValue(profileResult);
    const eqMock = jest.fn().mockReturnValue({ maybeSingle: maybeSingleMock });
    const selectMock = jest.fn().mockReturnValue({ eq: eqMock });
    const fromMock = jest.fn().mockReturnValue({ select: selectMock });

    return {
      auth: { getUser: jest.fn().mockResolvedValue(userResult) },
      from: fromMock,
      _mocks: { maybeSingleMock, eqMock, selectMock, fromMock },
    };
  }

  it('returns display_name from user_profiles for a Google OAuth user', async () => {
    // Simulate a Google OAuth user: no display_name in metadata (raw from Google),
    // but the callback route has already populated user_profiles.
    const mock = buildProfileMock(
      {
        data: {
          user: {
            id: 'google-user-id',
            email: 'googleuser@gmail.com',
            user_metadata: { full_name: 'Google User' },
          },
        },
        error: null,
      },
      { data: { display_name: 'Google User', avatar_id: 'avatar-1' }, error: null }
    );
    const app = loadApp(mock);

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer google-oauth-jwt');

    expect(res.status).toBe(200);
    expect(res.body.isGuest).toBe(false);
    expect(res.body.displayName).toBe('Google User');
    expect(res.body.avatarId).toBe('avatar-1');
    // Verify from() was called to look up user_profiles
    expect(mock.from).toHaveBeenCalledWith('user_profiles');
  });

  it('falls back to metadata display_name when user_profiles row not found', async () => {
    const mock = buildProfileMock(
      {
        data: {
          user: {
            id: 'no-profile-user',
            email: 'noprofile@example.com',
            user_metadata: { display_name: 'MetaUser', avatar_id: 'avatar-5' },
          },
        },
        error: null,
      },
      // No profile row
      { data: null, error: null }
    );
    const app = loadApp(mock);

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer jwt');

    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('MetaUser');
    expect(res.body.avatarId).toBe('avatar-5');
  });

  it('falls back gracefully when profile lookup throws', async () => {
    const throwingMock = {
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: {
            user: {
              id: 'throw-user',
              email: 'throw@example.com',
              user_metadata: { display_name: 'ThrowUser' },
            },
          },
          error: null,
        }),
      },
      from: jest.fn().mockImplementation(() => {
        throw new Error('DB unavailable');
      }),
    };
    const app = loadApp(throwingMock);

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer jwt');

    // Must still return 200 — profile lookup failure is non-fatal
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('ThrowUser');
  });

  it('profile lookup is NOT performed for guest sessions (guest /me is DB-free)', async () => {
    // Guest tokens are resolved in-memory — from() must never be called.
    const trackingMock = {
      auth: { getUser: jest.fn() },
      from: jest.fn(),
    };
    const app = loadApp(trackingMock);

    const createRes = await request(app)
      .post('/api/auth/guest')
      .send({ displayName: 'GuestMe' });
    const { token } = createRes.body;

    await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    // from() must NOT have been called for a guest /me request
    expect(trackingMock.from).not.toHaveBeenCalled();
  });
});

// =============================================================================
// No-DB-write guarantee
// =============================================================================

describe('Guest session: no database writes', () => {
  it('entire guest session lifecycle makes zero Supabase writes', async () => {
    // A mock with explicit tracking — any DB write would be caught.
    const mock = {
      auth: { getUser: jest.fn() },
      from: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      upsert: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
    };
    const app = loadApp(mock);

    // Create session
    const createRes = await request(app)
      .post('/api/auth/guest')
      .send({ displayName: 'NoDbTest' });
    const { token } = createRes.body;

    // Read identity
    await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    // Destroy session
    await request(app)
      .delete('/api/auth/guest')
      .set('Authorization', `Bearer ${token}`);

    // Zero database interaction throughout
    expect(mock.from).not.toHaveBeenCalled();
    expect(mock.insert).not.toHaveBeenCalled();
    expect(mock.update).not.toHaveBeenCalled();
    expect(mock.upsert).not.toHaveBeenCalled();
    expect(mock.delete).not.toHaveBeenCalled();
    expect(mock.auth.getUser).not.toHaveBeenCalled();
  });
});
