'use strict';

/**
 * Unit tests for the authentication middleware.
 *
 * Uses a minimal Express app (via supertest) so we can test the middleware
 * directly without needing node-mocks-http.
 *
 * Tests cover:
 *  - extractBearerToken helper
 *  - resolveUser: guest session path
 *  - resolveUser: Supabase JWT path (resolution priority)
 *  - requireAuth, optionalAuth, requireRegisteredUser variants
 *
 * Supabase is mocked via _setSupabaseClient so no real DB calls occur.
 * The guest session store is used directly (with _clearStore reset).
 */

const express = require('express');
const request = require('supertest');

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildMockSupabase(userResult) {
  return {
    auth: { getUser: jest.fn().mockResolvedValue(userResult) },
    from: jest.fn(),
  };
}

/**
 * Build a tiny Express app that applies `middleware` to GET /test and
 * responds with req.user (or null) as JSON, plus the HTTP status 200.
 */
function buildTestApp(middleware) {
  const app = express();
  app.use(express.json());
  app.get('/test', middleware, (req, res) => {
    res.status(200).json({ user: req.user || null });
  });
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

/**
 * Reset module cache and inject an optional Supabase mock.
 * Returns freshly required `auth` middleware and `store` modules.
 */
function freshModules(mockSupabase) {
  jest.resetModules();
  if (mockSupabase) {
    const { _setSupabaseClient } = require('../db/supabase');
    _setSupabaseClient(mockSupabase);
  }
  const { _clearStore, stopCleanupTimer } = require('../sessions/guestSessionStore');
  _clearStore();
  stopCleanupTimer();
  return {
    auth: require('../middleware/auth'),
    store: require('../sessions/guestSessionStore'),
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

afterEach(() => {
  jest.clearAllMocks();
  // Always stop any running timer
  try {
    const { stopCleanupTimer } = require('../sessions/guestSessionStore');
    stopCleanupTimer();
  } catch (_) { /* module may have been reset */ }
});

// =============================================================================
// extractBearerToken
// =============================================================================

describe('extractBearerToken', () => {
  // Pure function — test directly without HTTP.
  let extractBearerToken;

  beforeEach(() => {
    jest.resetModules();
    ({ extractBearerToken } = require('../middleware/auth'));
  });

  it('extracts token from a valid Authorization header', () => {
    expect(extractBearerToken({ headers: { authorization: 'Bearer mytoken' } })).toBe('mytoken');
  });

  it('returns null when the header is absent', () => {
    expect(extractBearerToken({ headers: {} })).toBeNull();
  });

  it('returns null for non-Bearer schemes', () => {
    expect(extractBearerToken({ headers: { authorization: 'Basic abc' } })).toBeNull();
  });

  it('returns null when value after "Bearer " is empty', () => {
    expect(extractBearerToken({ headers: { authorization: 'Bearer ' } })).toBeNull();
  });

  it('trims whitespace around the token', () => {
    expect(
      extractBearerToken({ headers: { authorization: 'Bearer   trimmed   ' } })
    ).toBe('trimmed');
  });
});

// =============================================================================
// requireAuth — guest path
// =============================================================================

describe('requireAuth (guest session)', () => {
  it('resolves a valid guest token; req.user has isGuest=true', async () => {
    const { auth, store } = freshModules();
    const { token } = store.createGuestSession('GuestAlice', 'avatar-3');
    const app = buildTestApp(auth.requireAuth);

    const res = await request(app)
      .get('/test')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.isGuest).toBe(true);
    expect(res.body.user._noDbWrites).toBe(true);
    expect(res.body.user.displayName).toBe('GuestAlice');
    expect(res.body.user.avatarId).toBe('avatar-3');
    expect(typeof res.body.user.sessionId).toBe('string');
    // The raw token must not be exposed in any response field
    expect(JSON.stringify(res.body)).not.toContain(token);
  });

  it('returns 401 when no Authorization header is present', async () => {
    const { auth } = freshModules();
    const app = buildTestApp(auth.requireAuth);

    const res = await request(app).get('/test');
    expect(res.status).toBe(401);
  });

  it('returns 401 for an unknown / invalid token', async () => {
    const mock = buildMockSupabase({ data: { user: null }, error: { message: 'bad' } });
    const { auth } = freshModules(mock);
    const app = buildTestApp(auth.requireAuth);

    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer totally-unknown-token');

    expect(res.status).toBe(401);
  });
});

// =============================================================================
// requireAuth — registered user (Supabase) path
// =============================================================================

describe('requireAuth (Supabase JWT)', () => {
  it('resolves a valid Supabase JWT; req.user has isGuest=false', async () => {
    const mock = buildMockSupabase({
      data: {
        user: {
          id: 'user-uuid-1',
          email: 'test@example.com',
          user_metadata: { display_name: 'TestUser', avatar_id: 'avatar-5' },
        },
      },
      error: null,
    });
    const { auth } = freshModules(mock);
    const app = buildTestApp(auth.requireAuth);

    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer valid-supabase-jwt');

    expect(res.status).toBe(200);
    expect(res.body.user.isGuest).toBe(false);
    expect(res.body.user._noDbWrites).toBe(false);
    expect(res.body.user.id).toBe('user-uuid-1');
    expect(res.body.user.email).toBe('test@example.com');
    expect(res.body.user.displayName).toBe('TestUser');
  });

  it('returns 401 when Supabase reports an error', async () => {
    const mock = buildMockSupabase({ data: { user: null }, error: { message: 'bad jwt' } });
    const { auth } = freshModules(mock);
    const app = buildTestApp(auth.requireAuth);

    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer bad-token');

    expect(res.status).toBe(401);
  });

  it('returns 401 (not 500) when Supabase throws an exception', async () => {
    jest.resetModules();
    const { _setSupabaseClient } = require('../db/supabase');
    _setSupabaseClient({
      auth: { getUser: jest.fn().mockRejectedValue(new Error('network')) },
      from: jest.fn(),
    });
    const { _clearStore, stopCleanupTimer } = require('../sessions/guestSessionStore');
    _clearStore();
    stopCleanupTimer();
    const auth = require('../middleware/auth');
    const app = buildTestApp(auth.requireAuth);

    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer anything');

    expect(res.status).toBe(401);
  });
});

// =============================================================================
// Resolution priority: guest wins over Supabase
// =============================================================================

describe('resolveUser priority', () => {
  it('uses guest session and does NOT call Supabase when token is in the store', async () => {
    const supabaseMock = buildMockSupabase({
      data: { user: { id: 'sb-user', email: 'x@x.com', user_metadata: {} } },
      error: null,
    });
    const { auth, store } = freshModules(supabaseMock);
    const { token } = store.createGuestSession('GuestPriority');
    const app = buildTestApp(auth.requireAuth);

    const res = await request(app)
      .get('/test')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.isGuest).toBe(true);
    // Supabase must NOT have been called — no unnecessary network traffic
    expect(supabaseMock.auth.getUser).not.toHaveBeenCalled();
  });
});

// =============================================================================
// optionalAuth
// =============================================================================

describe('optionalAuth middleware', () => {
  it('attaches req.user and returns 200 for a valid guest token', async () => {
    const { auth, store } = freshModules();
    const { token } = store.createGuestSession('GuestOptional');
    const app = buildTestApp(auth.optionalAuth);

    const res = await request(app)
      .get('/test')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.isGuest).toBe(true);
  });

  it('sets req.user to null and returns 200 when no token is present (never 401)', async () => {
    const { auth } = freshModules();
    const app = buildTestApp(auth.optionalAuth);

    const res = await request(app).get('/test');

    expect(res.status).toBe(200); // explicitly NOT 401
    expect(res.body.user).toBeNull();
  });

  it('sets req.user to null for an unknown token and returns 200', async () => {
    const mock = buildMockSupabase({ data: { user: null }, error: { message: 'bad' } });
    const { auth } = freshModules(mock);
    const app = buildTestApp(auth.optionalAuth);

    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer unknown-token');

    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
  });
});

// =============================================================================
// resolveUser — registered user display name resolution
// =============================================================================
//
// The auth middleware uses user_metadata for the initial display name because
// it is a lightweight path (no extra DB round-trip per request).
// The authoritative profile (including OAuth display names) is fetched by the
// GET /api/auth/me endpoint, not the middleware.

describe('resolveUser: display name resolution from metadata', () => {
  it('uses display_name from user_metadata when present', async () => {
    const mock = buildMockSupabase({
      data: {
        user: {
          id: 'u-meta',
          email: 'meta@example.com',
          user_metadata: { display_name: 'MetaName', avatar_id: 'avatar-7' },
        },
      },
      error: null,
    });
    const { auth } = freshModules(mock);
    const app = buildTestApp(auth.requireAuth);

    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer jwt');

    expect(res.status).toBe(200);
    expect(res.body.user.displayName).toBe('MetaName');
    expect(res.body.user.avatarId).toBe('avatar-7');
    // user_profiles is NOT queried in the middleware — verify from() not called
    expect(mock.from).not.toHaveBeenCalled();
  });

  it('falls back to email when user_metadata has no display_name', async () => {
    const mock = buildMockSupabase({
      data: {
        user: {
          id: 'u-email-fallback',
          email: 'noname@example.com',
          user_metadata: {},
        },
      },
      error: null,
    });
    const { auth } = freshModules(mock);
    const app = buildTestApp(auth.requireAuth);

    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer jwt');

    expect(res.status).toBe(200);
    expect(res.body.user.displayName).toBe('noname@example.com');
    expect(res.body.user.avatarId).toBeNull();
  });

  it('does not call supabase.from() (no profile DB lookup in middleware)', async () => {
    const mock = buildMockSupabase({
      data: {
        user: {
          id: 'u-no-from',
          email: 'test@example.com',
          user_metadata: { display_name: 'NoFrom' },
        },
      },
      error: null,
    });
    const { auth } = freshModules(mock);
    const app = buildTestApp(auth.requireAuth);

    await request(app)
      .get('/test')
      .set('Authorization', 'Bearer jwt');

    // Profile lookup is done at the /me endpoint level, not here.
    expect(mock.from).not.toHaveBeenCalled();
  });
});

// =============================================================================
// requireRegisteredUser
// =============================================================================

describe('requireRegisteredUser middleware', () => {
  it('calls next() for a valid registered user', async () => {
    const mock = buildMockSupabase({
      data: {
        user: { id: 'reg-user', email: 'reg@example.com', user_metadata: {} },
      },
      error: null,
    });
    const { auth } = freshModules(mock);
    const app = buildTestApp(auth.requireRegisteredUser);

    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer registered-jwt');

    expect(res.status).toBe(200);
    expect(res.body.user.isGuest).toBe(false);
  });

  it('returns 403 Forbidden for a guest session — explicitly blocks DB writes', async () => {
    const { auth, store } = freshModules();
    const { token } = store.createGuestSession('GuestBlocked');
    const app = buildTestApp(auth.requireRegisteredUser);

    const res = await request(app)
      .get('/test')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });

  it('returns 401 when no token is provided', async () => {
    const { auth } = freshModules();
    const app = buildTestApp(auth.requireRegisteredUser);

    const res = await request(app).get('/test');

    expect(res.status).toBe(401);
  });
});
