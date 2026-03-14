'use strict';

/**
 * Integration tests for registered-user authentication routes:
 *   POST /api/auth/register  — create account with email + password
 *   POST /api/auth/login     — sign in; receive JWT
 *   POST /api/auth/logout    — invalidate session
 *   POST /api/auth/refresh   — exchange refresh token
 *
 * No real Supabase connections are made.  Both the service-role client
 * (getSupabaseClient) and the anon-key client (getAuthClient) are mocked.
 */

const request = require('supertest');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * (Re)load the Express app with fresh module state and optional mock clients.
 *
 * @param {object} [opts]
 * @param {object} [opts.mockAdmin]   — Mock for getSupabaseClient() (service role)
 * @param {object} [opts.mockAuth]    — Mock for getAuthClient() (anon key)
 */
function loadApp({ mockAdmin, mockAuth } = {}) {
  jest.resetModules();

  if (mockAdmin || mockAuth) {
    // We need to inject mocks before any module that calls getSupabaseClient /
    // getAuthClient is loaded.
    jest.mock('../db/supabase', () => {
      const actual = jest.requireActual('../db/supabase');
      return {
        ...actual,
        getSupabaseClient: mockAdmin ? () => mockAdmin : actual.getSupabaseClient,
        getAuthClient: mockAuth ? () => mockAuth : actual.getAuthClient,
      };
    });
  }

  // Reset the in-memory guest store so tests don't bleed into each other.
  const { _clearStore, stopCleanupTimer } = require('../sessions/guestSessionStore');
  _clearStore();
  stopCleanupTimer();

  return require('../index');
}

/**
 * Build a mock Supabase admin client (service-role operations).
 *
 * @param {object} opts
 * @param {object} opts.createUserResult   — Return value of admin.createUser()
 * @param {object} [opts.signOutResult]    — Return value of admin.signOut()
 * @param {object} [opts.fromResult]       — Chainable .from().insert() mock
 * @param {object} [opts.getUserResult]    — Return value of auth.getUser()
 */
function buildAdminMock({
  createUserResult,
  signOutResult = { error: null },
  fromResult = { error: null },
  getUserResult = { data: { user: null }, error: { message: 'not found' } },
} = {}) {
  const insertMock = jest.fn().mockResolvedValue(fromResult);
  const fromMock = jest.fn().mockReturnValue({ insert: insertMock });

  return {
    auth: {
      admin: {
        createUser: jest.fn().mockResolvedValue(createUserResult),
        signOut: jest.fn().mockResolvedValue(signOutResult),
      },
      getUser: jest.fn().mockResolvedValue(getUserResult),
    },
    from: fromMock,
    _insertMock: insertMock, // exposed for assertions
    _fromMock: fromMock,
  };
}

/**
 * Build a mock Supabase anon-key client (user-facing auth flows).
 *
 * @param {object} opts
 * @param {object} opts.signInResult      — Return value of auth.signInWithPassword()
 * @param {object} [opts.refreshResult]   — Return value of auth.refreshSession()
 */
function buildAuthMock({
  signInResult,
  refreshResult = { data: null, error: { message: 'invalid' } },
} = {}) {
  return {
    auth: {
      signInWithPassword: jest.fn().mockResolvedValue(signInResult),
      refreshSession: jest.fn().mockResolvedValue(refreshResult),
    },
  };
}

/** Minimal Supabase user object returned by admin.createUser */
function fakeUser(overrides = {}) {
  return {
    id: 'user-uuid-123',
    email: 'test@example.com',
    user_metadata: {
      display_name: 'TestUser',
      avatar_id: 'avatar-1',
    },
    ...overrides,
  };
}

/** Minimal Supabase session object */
function fakeSession(overrides = {}) {
  return {
    access_token: 'fake-access-token',
    refresh_token: 'fake-refresh-token',
    expires_in: 3600,
    token_type: 'bearer',
    ...overrides,
  };
}

afterEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
});

// =============================================================================
// POST /api/auth/register
// =============================================================================

describe('POST /api/auth/register', () => {
  // ── Happy path ─────────────────────────────────────────────────────────────

  it('returns 201 with accessToken, refreshToken, expiresIn, and user on success', async () => {
    const user = fakeUser();
    const session = fakeSession();

    const adminMock = buildAdminMock({
      createUserResult: { data: { user }, error: null },
    });
    const authMock = buildAuthMock({
      signInResult: { data: { user, session }, error: null },
    });

    const app = loadApp({ mockAdmin: adminMock, mockAuth: authMock });

    const res = await request(app).post('/api/auth/register').send({
      email: 'test@example.com',
      password: 'Password1',
      displayName: 'TestUser',
    });

    expect(res.status).toBe(201);
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
    expect(typeof res.body.expiresIn).toBe('number');
    expect(res.body.user).toMatchObject({
      id: user.id,
      email: user.email,
      displayName: 'TestUser',
      avatarId: 'avatar-1',
    });
  });

  it('uses provided avatarId in the created user', async () => {
    const user = fakeUser({ user_metadata: { display_name: 'Tester', avatar_id: 'avatar-7' } });
    const session = fakeSession();

    const adminMock = buildAdminMock({
      createUserResult: { data: { user }, error: null },
    });
    const authMock = buildAuthMock({
      signInResult: { data: { user, session }, error: null },
    });

    const app = loadApp({ mockAdmin: adminMock, mockAuth: authMock });

    const res = await request(app).post('/api/auth/register').send({
      email: 'tester@example.com',
      password: 'Password1',
      displayName: 'Tester',
      avatarId: 'avatar-7',
    });

    expect(res.status).toBe(201);
    expect(res.body.user.avatarId).toBe('avatar-7');
    // The admin.createUser call should have received the avatarId in user_metadata
    expect(adminMock.auth.admin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        user_metadata: expect.objectContaining({ avatar_id: 'avatar-7' }),
      })
    );
  });

  it('trims whitespace from displayName', async () => {
    const user = fakeUser({ user_metadata: { display_name: 'Alice', avatar_id: 'avatar-1' } });
    const session = fakeSession();

    const adminMock = buildAdminMock({
      createUserResult: { data: { user }, error: null },
    });
    const authMock = buildAuthMock({
      signInResult: { data: { user, session }, error: null },
    });

    const app = loadApp({ mockAdmin: adminMock, mockAuth: authMock });

    const res = await request(app).post('/api/auth/register').send({
      email: 'alice@example.com',
      password: 'Password1',
      displayName: '  Alice  ',
    });

    expect(res.status).toBe(201);
    expect(adminMock.auth.admin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        user_metadata: expect.objectContaining({ display_name: 'Alice' }),
      })
    );
  });

  it('normalises email to lowercase', async () => {
    const user = fakeUser({ email: 'upper@example.com' });
    const session = fakeSession();

    const adminMock = buildAdminMock({
      createUserResult: { data: { user }, error: null },
    });
    const authMock = buildAuthMock({
      signInResult: { data: { user, session }, error: null },
    });

    const app = loadApp({ mockAdmin: adminMock, mockAuth: authMock });

    const res = await request(app).post('/api/auth/register').send({
      email: 'UPPER@EXAMPLE.COM',
      password: 'Password1',
      displayName: 'Upper',
    });

    expect(res.status).toBe(201);
    expect(adminMock.auth.admin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'upper@example.com' })
    );
  });

  it('inserts a row into user_profiles after creating the user', async () => {
    const user = fakeUser();
    const session = fakeSession();

    const adminMock = buildAdminMock({
      createUserResult: { data: { user }, error: null },
    });
    const authMock = buildAuthMock({
      signInResult: { data: { user, session }, error: null },
    });

    const app = loadApp({ mockAdmin: adminMock, mockAuth: authMock });

    await request(app).post('/api/auth/register').send({
      email: 'test@example.com',
      password: 'Password1',
      displayName: 'TestUser',
    });

    expect(adminMock._fromMock).toHaveBeenCalledWith('user_profiles');
    expect(adminMock._insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: user.id,
        display_name: 'TestUser',
        avatar_id: 'avatar-1',
      })
    );
  });

  it('sets email_confirm: true (no email verification required)', async () => {
    const user = fakeUser();
    const session = fakeSession();

    const adminMock = buildAdminMock({
      createUserResult: { data: { user }, error: null },
    });
    const authMock = buildAuthMock({
      signInResult: { data: { user, session }, error: null },
    });

    const app = loadApp({ mockAdmin: adminMock, mockAuth: authMock });

    await request(app).post('/api/auth/register').send({
      email: 'test@example.com',
      password: 'Password1',
      displayName: 'TestUser',
    });

    expect(adminMock.auth.admin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email_confirm: true })
    );
  });

  // ── Conflict (duplicate email) ─────────────────────────────────────────────

  it('returns 409 when the email is already registered', async () => {
    const adminMock = buildAdminMock({
      createUserResult: {
        data: { user: null },
        error: { status: 422, message: 'User already registered' },
      },
    });
    const authMock = buildAuthMock({ signInResult: { data: null, error: null } });

    const app = loadApp({ mockAdmin: adminMock, mockAuth: authMock });

    const res = await request(app).post('/api/auth/register').send({
      email: 'existing@example.com',
      password: 'Password1',
      displayName: 'Existing',
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Conflict');
  });

  // ── Validation errors ──────────────────────────────────────────────────────

  it('returns 400 when email is missing', async () => {
    const app = loadApp();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ password: 'Password1', displayName: 'Test' });

    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => /email/i.test(d))).toBe(true);
  });

  it('returns 400 for an invalid email format', async () => {
    const app = loadApp();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'not-an-email', password: 'Password1', displayName: 'Test' });

    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => /email/i.test(d))).toBe(true);
  });

  it('returns 400 when password is missing', async () => {
    const app = loadApp();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'test@example.com', displayName: 'Test' });

    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => /password/i.test(d))).toBe(true);
  });

  it('returns 400 when password is fewer than 8 characters', async () => {
    const app = loadApp();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'test@example.com', password: 'Abc1', displayName: 'Test' });

    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => /8 characters/i.test(d))).toBe(true);
  });

  it('returns 400 when password has no digit', async () => {
    const app = loadApp();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'test@example.com', password: 'NoDigitsHere', displayName: 'Test' });

    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => /digit/i.test(d))).toBe(true);
  });

  it('returns 400 when password has no letter', async () => {
    const app = loadApp();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'test@example.com', password: '12345678', displayName: 'Test' });

    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => /letter/i.test(d))).toBe(true);
  });

  it('returns 400 when displayName is missing', async () => {
    const app = loadApp();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'test@example.com', password: 'Password1' });

    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => /displayName/i.test(d))).toBe(true);
  });

  it('returns 400 when displayName exceeds 20 characters', async () => {
    const app = loadApp();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'test@example.com', password: 'Password1', displayName: 'A'.repeat(21) });

    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid avatarId', async () => {
    const app = loadApp();
    const res = await request(app).post('/api/auth/register').send({
      email: 'test@example.com',
      password: 'Password1',
      displayName: 'Test',
      avatarId: 'bad-avatar',
    });

    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => /avatarId/i.test(d))).toBe(true);
  });

  it('returns 400 when all required fields are missing', async () => {
    const app = loadApp();
    const res = await request(app).post('/api/auth/register').send({});

    expect(res.status).toBe(400);
    expect(res.body.details.length).toBeGreaterThanOrEqual(3);
  });
});

// =============================================================================
// POST /api/auth/login
// =============================================================================

describe('POST /api/auth/login', () => {
  // ── Happy path ─────────────────────────────────────────────────────────────

  it('returns 200 with accessToken, refreshToken, expiresIn, and user', async () => {
    const user = fakeUser();
    const session = fakeSession();

    const authMock = buildAuthMock({
      signInResult: { data: { user, session }, error: null },
    });

    const app = loadApp({ mockAuth: authMock });

    const res = await request(app).post('/api/auth/login').send({
      email: 'test@example.com',
      password: 'Password1',
    });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBe(session.access_token);
    expect(res.body.refreshToken).toBe(session.refresh_token);
    expect(res.body.expiresIn).toBe(session.expires_in);
    expect(res.body.user).toMatchObject({
      id: user.id,
      email: user.email,
      displayName: user.user_metadata.display_name,
      avatarId: user.user_metadata.avatar_id,
    });
  });

  it('normalises email to lowercase before signing in', async () => {
    const user = fakeUser();
    const session = fakeSession();

    const authMock = buildAuthMock({
      signInResult: { data: { user, session }, error: null },
    });

    const app = loadApp({ mockAuth: authMock });

    await request(app).post('/api/auth/login').send({
      email: 'TEST@EXAMPLE.COM',
      password: 'Password1',
    });

    expect(authMock.auth.signInWithPassword).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'test@example.com' })
    );
  });

  it('uses email as displayName fallback when user_metadata is absent', async () => {
    const user = { id: 'uid', email: 'bare@example.com', user_metadata: {} };
    const session = fakeSession();

    const authMock = buildAuthMock({
      signInResult: { data: { user, session }, error: null },
    });

    const app = loadApp({ mockAuth: authMock });

    const res = await request(app).post('/api/auth/login').send({
      email: 'bare@example.com',
      password: 'Password1',
    });

    expect(res.status).toBe(200);
    expect(res.body.user.displayName).toBe('bare@example.com');
    expect(res.body.user.avatarId).toBeNull();
  });

  // ── Invalid credentials ────────────────────────────────────────────────────

  it('returns 401 for wrong password', async () => {
    const authMock = buildAuthMock({
      signInResult: {
        data: { user: null, session: null },
        error: { message: 'Invalid login credentials' },
      },
    });

    const app = loadApp({ mockAuth: authMock });

    const res = await request(app).post('/api/auth/login').send({
      email: 'test@example.com',
      password: 'WrongPass1',
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('returns 401 for unknown email (same generic message — no user enumeration)', async () => {
    const authMock = buildAuthMock({
      signInResult: {
        data: { user: null, session: null },
        error: { message: 'Invalid login credentials' },
      },
    });

    const app = loadApp({ mockAuth: authMock });

    const res = await request(app).post('/api/auth/login').send({
      email: 'nobody@example.com',
      password: 'Password1',
    });

    expect(res.status).toBe(401);
    // Message must be the same generic message as wrong password — no user enumeration.
    // The message may mention "email" or "password" together, but must NOT say
    // something specific like "email not found" or "no account" that leaks account existence.
    expect(res.body.message).not.toMatch(/not found|no account|does not exist|unknown/i);
    // Both bad-email and bad-password return the same status and same message
    expect(res.body.error).toBe('Unauthorized');
  });

  // ── Validation errors ──────────────────────────────────────────────────────

  it('returns 400 when email is missing', async () => {
    const app = loadApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ password: 'Password1' });

    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => /email/i.test(d))).toBe(true);
  });

  it('returns 400 for an invalid email format', async () => {
    const app = loadApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'bad-email', password: 'Password1' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when password is missing', async () => {
    const app = loadApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@example.com' });

    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => /password/i.test(d))).toBe(true);
  });

  it('returns 400 when both fields are missing', async () => {
    const app = loadApp();
    const res = await request(app).post('/api/auth/login').send({});

    expect(res.status).toBe(400);
    expect(res.body.details.length).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// POST /api/auth/logout
// =============================================================================

describe('POST /api/auth/logout', () => {
  it('returns 200 for a valid registered-user token', async () => {
    const adminMock = buildAdminMock({
      createUserResult: { data: { user: null }, error: null },
      getUserResult: {
        data: {
          user: {
            id: 'uid-logout',
            email: 'logout@example.com',
            user_metadata: { display_name: 'Logout', avatar_id: 'avatar-1' },
          },
        },
        error: null,
      },
    });

    const app = loadApp({ mockAdmin: adminMock });

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', 'Bearer valid-jwt-token');

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/logged out/i);
    expect(adminMock.auth.admin.signOut).toHaveBeenCalledWith('valid-jwt-token');
  });

  it('returns 401 when no token is provided', async () => {
    const app = loadApp();
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(401);
  });

  it('returns 403 when a guest token is used', async () => {
    // Create a guest session first, then try to use logout with that token.
    const app = loadApp();

    const createRes = await request(app)
      .post('/api/auth/guest')
      .send({ displayName: 'GuestUser' });

    const { token } = createRes.body;

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });

  it('still returns 200 even if the admin.signOut call throws (non-fatal)', async () => {
    const adminMock = buildAdminMock({
      createUserResult: { data: { user: null }, error: null },
      signOutResult: undefined, // will be overridden below
      getUserResult: {
        data: {
          user: {
            id: 'uid-err',
            email: 'err@example.com',
            user_metadata: {},
          },
        },
        error: null,
      },
    });
    // Make signOut throw
    adminMock.auth.admin.signOut = jest.fn().mockRejectedValue(new Error('network error'));

    const app = loadApp({ mockAdmin: adminMock });

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', 'Bearer some-token');

    expect(res.status).toBe(200);
  });
});

// =============================================================================
// POST /api/auth/refresh
// =============================================================================

describe('POST /api/auth/refresh', () => {
  it('returns 200 with new accessToken, refreshToken, and expiresIn', async () => {
    const newSession = fakeSession({
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
      expires_in: 3600,
    });

    const authMock = buildAuthMock({
      signInResult: { data: null, error: null }, // unused in this test
      refreshResult: { data: { session: newSession, user: fakeUser() }, error: null },
    });

    const app = loadApp({ mockAuth: authMock });

    const res = await request(app).post('/api/auth/refresh').send({
      refreshToken: 'old-refresh-token',
    });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBe('new-access-token');
    expect(res.body.refreshToken).toBe('new-refresh-token');
    expect(res.body.expiresIn).toBe(3600);

    expect(authMock.auth.refreshSession).toHaveBeenCalledWith({
      refresh_token: 'old-refresh-token',
    });
  });

  it('returns 401 for an expired / invalid refresh token', async () => {
    const authMock = buildAuthMock({
      signInResult: { data: null, error: null },
      refreshResult: {
        data: { session: null, user: null },
        error: { message: 'Invalid Refresh Token' },
      },
    });

    const app = loadApp({ mockAuth: authMock });

    const res = await request(app).post('/api/auth/refresh').send({
      refreshToken: 'expired-token',
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('returns 400 when refreshToken is missing', async () => {
    const app = loadApp();
    const res = await request(app).post('/api/auth/refresh').send({});

    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => /refreshToken/i.test(d))).toBe(true);
  });

  it('returns 400 when refreshToken is not a string', async () => {
    const app = loadApp();
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 12345 });

    expect(res.status).toBe(400);
  });

  it('does not require an Authorization header (public endpoint)', async () => {
    const newSession = fakeSession();

    const authMock = buildAuthMock({
      signInResult: { data: null, error: null },
      refreshResult: { data: { session: newSession, user: fakeUser() }, error: null },
    });

    const app = loadApp({ mockAuth: authMock });

    // Deliberately no Authorization header
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'any-refresh-token' });

    expect(res.status).toBe(200);
  });
});

// =============================================================================
// Password validation unit tests
// =============================================================================

describe('Password policy (via register endpoint)', () => {
  const basePayload = { email: 'test@example.com', displayName: 'Test' };

  async function attemptRegister(password) {
    // No mocks needed — validation fires before any DB calls
    const app = loadApp();
    return request(app)
      .post('/api/auth/register')
      .send({ ...basePayload, password });
  }

  it('accepts exactly 8 chars with at least one letter and one digit', async () => {
    // We still need DB mocks to get past validation to a real 201
    const user = fakeUser();
    const session = fakeSession();

    const adminMock = buildAdminMock({
      createUserResult: { data: { user }, error: null },
    });
    const authMock = buildAuthMock({
      signInResult: { data: { user, session }, error: null },
    });

    const app = loadApp({ mockAdmin: adminMock, mockAuth: authMock });

    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...basePayload, password: 'Abcde123' });

    expect(res.status).toBe(201);
  });

  it('rejects "password" (no digit)', async () => {
    const res = await attemptRegister('password');
    expect(res.status).toBe(400);
  });

  it('rejects "12345678" (no letter)', async () => {
    const res = await attemptRegister('12345678');
    expect(res.status).toBe(400);
  });

  it('rejects "Abc1234" (7 chars — too short)', async () => {
    const res = await attemptRegister('Abc1234');
    expect(res.status).toBe(400);
  });

  it('rejects an empty string', async () => {
    const res = await attemptRegister('');
    expect(res.status).toBe(400);
  });
});
