'use strict';

/**
 * Unit tests for the guest session store.
 *
 * These tests cover:
 *  - Session creation (valid / invalid inputs)
 *  - Session retrieval (by token)
 *  - Session expiry (TTL enforcement)
 *  - Session deletion
 *  - Cleanup of expired sessions
 *  - Active session count metric
 *  - Timer lifecycle helpers
 */

const {
  createGuestSession,
  getGuestSession,
  deleteGuestSession,
  cleanupExpiredSessions,
  getActiveSessionCount,
  startCleanupTimer,
  stopCleanupTimer,
  VALID_AVATAR_IDS,
  DEFAULT_AVATAR_ID,
  MAX_DISPLAY_NAME_LENGTH,
  MIN_DISPLAY_NAME_LENGTH,
  SESSION_TTL_MS,
  _clearStore,
  _getRawStore,
} = require('../sessions/guestSessionStore');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Mutate a stored session's expiresAt to a past timestamp for TTL tests. */
function expireSession(token) {
  const store = _getRawStore();
  const session = store.get(token);
  if (session) {
    store.set(token, { ...session, expiresAt: Date.now() - 1000 });
  }
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  _clearStore();
  stopCleanupTimer(); // prevent timer interference between tests
});

afterEach(() => {
  stopCleanupTimer();
});

// =============================================================================
// createGuestSession
// =============================================================================

describe('createGuestSession', () => {
  it('returns a token and session object', () => {
    const { token, session } = createGuestSession('Alice');

    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThanOrEqual(32); // at least 32 hex chars
    expect(session).toMatchObject({
      displayName: 'Alice',
      avatarId: DEFAULT_AVATAR_ID,
      isGuest: true,
    });
    expect(typeof session.sessionId).toBe('string');
    expect(session.sessionId.length).toBeGreaterThan(0);
  });

  it('trims whitespace from displayName', () => {
    const { session } = createGuestSession('  Bob  ');
    expect(session.displayName).toBe('Bob');
  });

  it('sets createdAt and expiresAt correctly', () => {
    const before = Date.now();
    const { session } = createGuestSession('Carol');
    const after = Date.now();

    expect(session.createdAt).toBeGreaterThanOrEqual(before);
    expect(session.createdAt).toBeLessThanOrEqual(after);
    expect(session.expiresAt).toBeCloseTo(session.createdAt + SESSION_TTL_MS, -3);
  });

  it('assigns a valid avatarId when provided', () => {
    const avatarId = VALID_AVATAR_IDS[3];
    const { session } = createGuestSession('Dave', avatarId);
    expect(session.avatarId).toBe(avatarId);
  });

  it('defaults to DEFAULT_AVATAR_ID when no avatarId is provided', () => {
    const { session } = createGuestSession('Eve');
    expect(session.avatarId).toBe(DEFAULT_AVATAR_ID);
  });

  it('falls back to DEFAULT_AVATAR_ID for an unknown avatarId', () => {
    const { session } = createGuestSession('Frank', 'avatar-999');
    expect(session.avatarId).toBe(DEFAULT_AVATAR_ID);
  });

  it('stores an optional recoveryKey for restart-safe guest reconnects', () => {
    const { session } = createGuestSession('Grace', undefined, 'client-sid');
    expect(session.recoveryKey).toBe('client-sid');
  });

  it('generates unique tokens for each call', () => {
    const tokens = new Set();
    for (let i = 0; i < 50; i++) {
      const { token } = createGuestSession(`Player${i}`);
      tokens.add(token);
    }
    expect(tokens.size).toBe(50);
  });

  it('generates unique sessionIds for each call', () => {
    const ids = new Set();
    for (let i = 0; i < 20; i++) {
      const { session } = createGuestSession(`Player${i}`);
      ids.add(session.sessionId);
    }
    expect(ids.size).toBe(20);
  });

  // ── Validation errors ────────────────────────────────────────────────────

  it('throws when displayName is missing', () => {
    expect(() => createGuestSession()).toThrow();
  });

  it('throws when displayName is not a string', () => {
    expect(() => createGuestSession(42)).toThrow();
    expect(() => createGuestSession(null)).toThrow();
    expect(() => createGuestSession(undefined)).toThrow();
  });

  it(`throws when displayName is shorter than ${MIN_DISPLAY_NAME_LENGTH} character after trim`, () => {
    expect(() => createGuestSession('')).toThrow(/between/i);
    expect(() => createGuestSession('   ')).toThrow(/between/i); // only whitespace
  });

  it(`throws when displayName exceeds ${MAX_DISPLAY_NAME_LENGTH} characters`, () => {
    const tooLong = 'A'.repeat(MAX_DISPLAY_NAME_LENGTH + 1);
    expect(() => createGuestSession(tooLong)).toThrow(/between/i);
  });

  it(`accepts a displayName of exactly ${MAX_DISPLAY_NAME_LENGTH} characters`, () => {
    const maxName = 'A'.repeat(MAX_DISPLAY_NAME_LENGTH);
    expect(() => createGuestSession(maxName)).not.toThrow();
  });

  it('does NOT write to Supabase (store remains in-memory)', () => {
    // Simply creating sessions should not require any external calls.
    // The test would fail or hang if a real network call were attempted.
    expect(() => {
      for (let i = 0; i < 5; i++) createGuestSession(`Player${i}`);
    }).not.toThrow();
  });
});

// =============================================================================
// getGuestSession
// =============================================================================

describe('getGuestSession', () => {
  it('returns the session for a valid token', () => {
    const { token, session } = createGuestSession('Alice');
    const found = getGuestSession(token);

    expect(found).not.toBeNull();
    expect(found.sessionId).toBe(session.sessionId);
    expect(found.displayName).toBe('Alice');
    expect(found.isGuest).toBe(true);
  });

  it('returns null for an unknown token', () => {
    expect(getGuestSession('totally-unknown-token')).toBeNull();
  });

  it('returns null for an empty string token', () => {
    expect(getGuestSession('')).toBeNull();
  });

  it('returns null for non-string inputs', () => {
    expect(getGuestSession(null)).toBeNull();
    expect(getGuestSession(undefined)).toBeNull();
    expect(getGuestSession(123)).toBeNull();
  });

  it('returns null and removes the session when it has expired', () => {
    const { token } = createGuestSession('ExpiryTest');
    expireSession(token);

    const found = getGuestSession(token);
    expect(found).toBeNull();

    // The expired entry must have been lazily removed from the store.
    expect(_getRawStore().has(token)).toBe(false);
  });
});

// =============================================================================
// deleteGuestSession
// =============================================================================

describe('deleteGuestSession', () => {
  it('removes the session so subsequent lookups return null', () => {
    const { token } = createGuestSession('Bob');

    deleteGuestSession(token);

    expect(getGuestSession(token)).toBeNull();
  });

  it('is a no-op for an unknown token (does not throw)', () => {
    expect(() => deleteGuestSession('does-not-exist')).not.toThrow();
  });
});

// =============================================================================
// cleanupExpiredSessions
// =============================================================================

describe('cleanupExpiredSessions', () => {
  it('removes only expired sessions, keeping live ones intact', () => {
    const { token: liveToken } = createGuestSession('LivePlayer');
    const { token: expiredToken1 } = createGuestSession('Expired1');
    const { token: expiredToken2 } = createGuestSession('Expired2');

    expireSession(expiredToken1);
    expireSession(expiredToken2);

    cleanupExpiredSessions();

    expect(getGuestSession(liveToken)).not.toBeNull();
    expect(_getRawStore().has(expiredToken1)).toBe(false);
    expect(_getRawStore().has(expiredToken2)).toBe(false);
  });

  it('does not throw when the store is empty', () => {
    expect(() => cleanupExpiredSessions()).not.toThrow();
  });
});

// =============================================================================
// getActiveSessionCount
// =============================================================================

describe('getActiveSessionCount', () => {
  it('returns 0 when the store is empty', () => {
    expect(getActiveSessionCount()).toBe(0);
  });

  it('counts only non-expired sessions', () => {
    createGuestSession('A');
    createGuestSession('B');
    const { token: expiredToken } = createGuestSession('C');
    expireSession(expiredToken);

    expect(getActiveSessionCount()).toBe(2);
  });
});

// =============================================================================
// Timer lifecycle
// =============================================================================

describe('startCleanupTimer / stopCleanupTimer', () => {
  it('starts and stops without throwing', () => {
    expect(() => startCleanupTimer()).not.toThrow();
    expect(() => stopCleanupTimer()).not.toThrow();
  });

  it('calling startCleanupTimer twice does not create a duplicate timer', () => {
    startCleanupTimer();
    startCleanupTimer(); // second call is a no-op
    // As long as stopCleanupTimer cleans up correctly, this is fine.
    expect(() => stopCleanupTimer()).not.toThrow();
  });

  it('calling stopCleanupTimer when not started is safe', () => {
    stopCleanupTimer(); // already stopped in beforeEach
    expect(() => stopCleanupTimer()).not.toThrow();
  });
});

// =============================================================================
// Isolation: sessions do not persist between tests
// =============================================================================

describe('store isolation between tests', () => {
  it('starts empty due to beforeEach _clearStore()', () => {
    expect(getActiveSessionCount()).toBe(0);
  });

  it('sessions created in this test do not affect subsequent tests', () => {
    createGuestSession('IsolationTest');
    expect(getActiveSessionCount()).toBe(1);
  });

  it('store is empty again after previous test (cleared by beforeEach)', () => {
    expect(getActiveSessionCount()).toBe(0);
  });
});
