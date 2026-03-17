'use strict';

/**
 * In-memory guest session store.
 *
 * Guest sessions are NEVER written to the database. They live only in this
 * module's Map for the lifetime of the process (or until they expire / the
 * guest explicitly ends the session).
 *
 * Shape of a stored session:
 * {
 * sessionId : string — UUIDv4, stable identity for this guest
 * token : string — cryptographically random hex string used as the
 * bearer token; treated as a secret
 * displayName: string — chosen display name (1–20 chars, trimmed)
 * avatarId : string — one of VALID_AVATAR_IDS
 * isGuest : true — always true; used by middleware to gate DB writes
 * createdAt : number — Unix timestamp (ms)
 * expiresAt : number — Unix timestamp (ms); session auto-expires after TTL
 * }
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long a guest session lives without activity (24 hours). */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** How often to sweep expired sessions from memory. */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** Maximum display name length (matches frontend validation). */
const MAX_DISPLAY_NAME_LENGTH = 20;
const MIN_DISPLAY_NAME_LENGTH = 1;

/**
 * Allowed avatar identifiers.
 * Frontend maps these to actual image assets.
 * Twelve avatars: avatar-1 through avatar-12.
 */
const VALID_AVATAR_IDS = Array.from({ length: 12 }, (_, i) => `avatar-${i + 1}`);

/** Default avatar when none is supplied or an invalid one is given. */
const DEFAULT_AVATAR_ID = 'avatar-1';

// ---------------------------------------------------------------------------
// Internal store
// ---------------------------------------------------------------------------

/** @type {Map<string, Object>} token → session object */
const _store = new Map();

// ---------------------------------------------------------------------------
// Helper: generate a secure random token
// ---------------------------------------------------------------------------
function _generateToken() {
  return crypto.randomBytes(32).toString('hex'); // 256-bit entropy
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new guest session.
 *
 * @param {string} displayName - The guest's chosen display name.
 * @param {string} [avatarId] - One of VALID_AVATAR_IDS; defaults to DEFAULT_AVATAR_ID.
 * @returns {{ token: string, session: Object }} - The opaque bearer token and
 * the public session data the client needs. The `token` must be kept secret
 * (sent only over HTTPS / WSS).
 * @throws {Error} if displayName fails validation.
 */
function createGuestSession(displayName, avatarId) {
  // --- validate displayName ---
  if (typeof displayName !== 'string') {
    throw new Error('displayName must be a string');
  }
  const trimmedName = displayName.trim();
  if (
    trimmedName.length < MIN_DISPLAY_NAME_LENGTH ||
    trimmedName.length > MAX_DISPLAY_NAME_LENGTH
  ) {
    throw new Error(
      `displayName must be between ${MIN_DISPLAY_NAME_LENGTH} and ${MAX_DISPLAY_NAME_LENGTH} characters`
    );
  }

  // --- validate / normalise avatarId ---
  const resolvedAvatar =
    avatarId && VALID_AVATAR_IDS.includes(avatarId) ? avatarId : DEFAULT_AVATAR_ID;

  const now = Date.now();
  const session = {
    sessionId: uuidv4(),
    displayName: trimmedName,
    avatarId: resolvedAvatar,
    isGuest: true,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };

  const token = _generateToken();

  // Store token → session (token is NOT exposed inside the stored object to
  // prevent accidental leakage through serialisation).
  _store.set(token, session);

  return { token, session };
}

/**
 * Look up a guest session by its bearer token.
 *
 * Returns `null` when the token is unknown or the session has expired.
 * Expired sessions are lazily removed on lookup.
 *
 * @param {string} token
 * @returns {Object|null}
 */
function getGuestSession(token) {
  if (typeof token !== 'string' || token.length === 0) return null;

  const session = _store.get(token);
  if (!session) return null;

  if (Date.now() > session.expiresAt) {
    _store.delete(token);
    return null;
  }

  return session;
}

/**
 * Explicitly delete a guest session (e.g. when the guest leaves a game or
 * the WebSocket connection is permanently closed).
 *
 * @param {string} token
 */
function deleteGuestSession(token) {
  _store.delete(token);
}

/**
 * Remove all expired sessions from the store.
 * Called automatically on a timer; can also be invoked manually in tests.
 */
function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of _store.entries()) {
    if (now > session.expiresAt) {
      _store.delete(token);
    }
  }
}

/**
 * Return the current number of live (non-expired) guest sessions.
 * Useful for health checks and metrics.
 */
function getActiveSessionCount() {
  const now = Date.now();
  let count = 0;
  for (const session of _store.values()) {
    if (now <= session.expiresAt) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Test helpers (only exposed for unit tests, not for production use)
// ---------------------------------------------------------------------------

/** Wipe the entire store — used in tests to reset state between cases. */
function _clearStore() {
  _store.clear();
}

/** Direct read of the raw store — used in tests to inspect internal state. */
function _getRawStore() {
  return _store;
}

// ---------------------------------------------------------------------------
// Periodic cleanup timer
// ---------------------------------------------------------------------------

let _cleanupTimer = null;

/**
 * Start the background cleanup interval.
 * Called once at application startup.
 */
function startCleanupTimer() {
  if (_cleanupTimer) return; // already running
  _cleanupTimer = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);
  // Don't block process exit:
  if (_cleanupTimer.unref) _cleanupTimer.unref();
}

/**
 * Stop the background cleanup interval.
 * Called during graceful shutdown or in test teardown.
 */
function stopCleanupTimer() {
  if (_cleanupTimer) {
    clearInterval(_cleanupTimer);
    _cleanupTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Core CRUD
  createGuestSession,
  getGuestSession,
  deleteGuestSession,
  cleanupExpiredSessions,

  // Metrics
  getActiveSessionCount,

  // Lifecycle
  startCleanupTimer,
  stopCleanupTimer,

  // Constants (re-exported so other modules stay in sync)
  VALID_AVATAR_IDS,
  DEFAULT_AVATAR_ID,
  MAX_DISPLAY_NAME_LENGTH,
  MIN_DISPLAY_NAME_LENGTH,
  SESSION_TTL_MS,

  // Test helpers
  _clearStore,
  _getRawStore,
};
