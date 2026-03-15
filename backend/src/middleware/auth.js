'use strict';

/**
 * Authentication middleware.
 *
 * Supports two mutually-exclusive session types:
 *
 *  1. **Registered user** — presents a Supabase JWT as a Bearer token.
 *     `req.user` is populated with `{ id, email, isGuest: false }`.
 *     Database operations (stats, history, etc.) are permitted.
 *
 *  2. **Guest** — presents the opaque token issued by `POST /api/auth/guest`.
 *     `req.user` is populated with `{ sessionId, displayName, avatarId, isGuest: true }`.
 *     NO database writes are performed for guests anywhere in the application;
 *     middleware consumers MUST check `req.user.isGuest` before any DB call.
 *
 * Middleware variants:
 *   requireAuth          — 401 if unauthenticated (allows guests)
 *   optionalAuth         — attaches user if present; never 401s
 *   requireRegisteredUser — 401 if unauthenticated, 403 if guest
 */

const { getSupabaseClient } = require('../db/supabase');
const { getGuestSession } = require('../sessions/guestSessionStore');

// ---------------------------------------------------------------------------
// Helper: extract Bearer token from the Authorization header
// ---------------------------------------------------------------------------

/**
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function extractBearerToken(req) {
  const header = req.headers && req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

// ---------------------------------------------------------------------------
// Core resolution logic
// ---------------------------------------------------------------------------

/**
 * Attempt to resolve a user from the request's Bearer token.
 *
 * Resolution order:
 *   1. Guest session store — cheap in-memory lookup; avoids a Supabase
 *      network call for the common guest case.
 *   2. Supabase JWT verification — for registered users.
 *
 * Returns `null` when no valid session is found.
 *
 * @param {import('express').Request} req
 * @returns {Promise<Object|null>}
 */
async function resolveUser(req) {
  const token = extractBearerToken(req);
  if (!token) return null;

  // ---- 1. Guest session (in-memory, no DB) --------------------------------
  const guestSession = getGuestSession(token);
  if (guestSession) {
    // Return a safe view — the raw bearer token is never re-exposed.
    return {
      sessionId: guestSession.sessionId,
      displayName: guestSession.displayName,
      avatarId: guestSession.avatarId,
      isGuest: true,
      // Explicit sentinel: checked by any code path that would otherwise
      // attempt a database write (stats updates, game records, etc.).
      _noDbWrites: true,
    };
  }

  // ---- 2. Supabase JWT verification ----------------------------------------
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) return null;

    const { user } = data;

    // Use Supabase user metadata for basic identity.
    // The user_profiles table holds the authoritative display name, but
    // it is only fetched by endpoints that need the full profile (e.g.
    // GET /api/auth/me) to avoid coupling the lightweight JWT-verification
    // path to an additional database round-trip on every request.
    const displayName = user.user_metadata?.display_name || user.email;
    const avatarId = user.user_metadata?.avatar_id || null;

    return {
      id: user.id,
      email: user.email,
      displayName,
      avatarId,
      isGuest: false,
      _noDbWrites: false,
    };
  } catch (_err) {
    // Supabase client not configured (e.g. during unit tests without env vars)
    // — treat as unauthenticated rather than crashing.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Middleware: requireAuth
// ---------------------------------------------------------------------------

/**
 * Requires a valid session (guest or registered).
 * Attaches `req.user` on success; responds 401 on failure.
 *
 * @type {import('express').RequestHandler}
 */
async function requireAuth(req, res, next) {
  try {
    const user = await resolveUser(req);
    if (!user) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'A valid Bearer token is required.',
      });
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Middleware: optionalAuth
// ---------------------------------------------------------------------------

/**
 * Resolves the session if one is present but does NOT reject unauthenticated
 * requests. Sets `req.user` to `null` when no valid session exists.
 *
 * Useful for endpoints that behave differently for authenticated vs. anonymous
 * visitors (e.g. spectator views, public game listings).
 *
 * @type {import('express').RequestHandler}
 */
async function optionalAuth(req, res, next) {
  try {
    req.user = (await resolveUser(req)) || null;
    next();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Middleware: requireRegisteredUser
// ---------------------------------------------------------------------------

/**
 * Extends `requireAuth` by also rejecting guest sessions with 403.
 *
 * Use this for any endpoint that writes to the database:
 *   - Updating persistent stats
 *   - Changing account settings
 *   - Any action that should not be available to ephemeral guest identities
 *
 * @type {import('express').RequestHandler}
 */
async function requireRegisteredUser(req, res, next) {
  try {
    const user = await resolveUser(req);
    if (!user) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'A valid Bearer token is required.',
      });
    }
    if (user.isGuest) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'This action requires a registered account.',
      });
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  requireAuth,
  optionalAuth,
  requireRegisteredUser,
  // Exported for testing:
  resolveUser,
  extractBearerToken,
};
