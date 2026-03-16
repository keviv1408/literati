'use strict';

/**
 * Authentication routes (guest-only MVP).
 *
 * POST   /api/auth/guest   — Create a temporary guest session (no DB writes)
 * DELETE /api/auth/guest   — Destroy the caller's guest session
 * GET    /api/auth/me      — Return the current session's public identity
 * GET    /api/auth/avatars — Return valid avatar IDs (public)
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

const {
  createGuestSession,
  deleteGuestSession,
  VALID_AVATAR_IDS,
  MAX_DISPLAY_NAME_LENGTH,
  MIN_DISPLAY_NAME_LENGTH,
  SESSION_TTL_MS,
} = require('../sessions/guestSessionStore');

const { requireAuth, extractBearerToken } = require('../middleware/auth');

const router = express.Router();

// ---------------------------------------------------------------------------
// Rate limiter for guest session creation
// Prevents a single IP from flooding the in-memory store.
// ---------------------------------------------------------------------------
const guestCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15-minute window
  max: 20,                   // max 20 guest sessions per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too Many Requests',
    message: 'Too many guest sessions created from this IP. Please try again later.',
  },
  skip: () => process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development',
});

// ---------------------------------------------------------------------------
// POST /api/auth/guest
// ---------------------------------------------------------------------------

/**
 * Create a temporary, non-persisted guest session.
 *
 * Request body:
 *   displayName  {string}  required — 1–20 characters
 *   avatarId     {string}  optional — one of VALID_AVATAR_IDS; defaults to 'avatar-1'
 *
 * Response 201:
 *   {
 *     token   : string  — opaque bearer token; must be sent as
 *                         "Authorization: Bearer <token>" on every subsequent request
 *     session : {
 *       sessionId   : string
 *       displayName : string
 *       avatarId    : string
 *       isGuest     : true
 *       expiresAt   : number   — Unix ms; client should re-create the session before this
 *     }
 *     validAvatarIds : string[]  — complete list of allowed avatar identifiers
 *   }
 *
 * Errors:
 *   400 — missing or invalid displayName / avatarId
 *   429 — rate limit exceeded
 *
 * Implementation notes:
 *   - The session is stored ONLY in the server's in-memory Map.
 *   - No rows are written to Supabase.
 *   - Stats tracking is explicitly disabled for guests throughout the
 *     application; any code that writes stats MUST check req.user.isGuest
 *     (or _noDbWrites) before attempting a database write.
 */
router.post('/guest', guestCreateLimiter, (req, res) => {
  const { displayName, avatarId } = req.body || {};

  // ── Input validation ───────────────────────────────────────────────────────

  const errors = [];

  if (displayName === undefined || displayName === null) {
    errors.push('displayName is required');
  } else if (typeof displayName !== 'string') {
    errors.push('displayName must be a string');
  } else {
    const trimmed = displayName.trim();
    if (trimmed.length < MIN_DISPLAY_NAME_LENGTH) {
      errors.push(
        `displayName must be at least ${MIN_DISPLAY_NAME_LENGTH} character`
      );
    } else if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
      errors.push(
        `displayName must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`
      );
    }
  }

  // avatarId is optional but must be from the allowed set when provided
  if (avatarId !== undefined && avatarId !== null) {
    if (typeof avatarId !== 'string' || !VALID_AVATAR_IDS.includes(avatarId)) {
      errors.push(
        `avatarId must be one of: ${VALID_AVATAR_IDS.join(', ')}`
      );
    }
  }

  if (errors.length > 0) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors,
    });
  }

  // ── Create session ─────────────────────────────────────────────────────────

  try {
    const { token, session } = createGuestSession(displayName, avatarId);

    return res.status(201).json({
      token,
      session: {
        sessionId: session.sessionId,
        displayName: session.displayName,
        avatarId: session.avatarId,
        isGuest: session.isGuest,
        expiresAt: session.expiresAt,
      },
      validAvatarIds: VALID_AVATAR_IDS,
      // Remind clients how long the session lasts (milliseconds)
      sessionTtlMs: SESSION_TTL_MS,
    });
  } catch (err) {
    // createGuestSession throws on invalid input — shouldn't reach here after
    // the validation block above, but guard just in case.
    return res.status(400).json({
      error: 'Failed to create guest session',
      message: err.message,
    });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/auth/guest
// ---------------------------------------------------------------------------

/**
 * Explicitly destroy the caller's guest session.
 *
 * The client should call this when the user navigates away or closes the tab,
 * so that the server can immediately free the in-memory slot rather than
 * waiting for the TTL to expire.
 *
 * This endpoint is a no-op (still returns 200) for registered users — it will
 * simply not find a matching guest session to remove.
 *
 * Response 200: { message: 'Guest session ended' }
 * Response 401: No valid Bearer token present
 */
router.delete('/guest', requireAuth, (req, res) => {
  if (req.user.isGuest) {
    const token = extractBearerToken(req);
    if (token) deleteGuestSession(token);
  }
  return res.status(200).json({ message: 'Guest session ended' });
});

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------

/**
 * Return the public identity of the currently authenticated session.
 *
 * Works for both registered users and guests.
 * Returns null body fields for the identity type that does not apply.
 *
 * Response 200 (guest):
 *   {
 *     isGuest     : true
 *     sessionId   : string
 *     displayName : string
 *     avatarId    : string
 *   }
 *
 * Response 200 (registered):
 *   {
 *     isGuest     : false
 *     id          : string   — Supabase user UUID
 *     email       : string
 *     displayName : string
 *     avatarId    : string | null
 *   }
 *
 * Response 401: No valid session
 */
router.get('/me', requireAuth, (req, res) => {
  const { user } = req;

  return res.status(200).json({
    isGuest: true,
    sessionId: user.sessionId,
    displayName: user.displayName,
    avatarId: user.avatarId,
  });
});

// ---------------------------------------------------------------------------
// GET /api/auth/avatars
// ---------------------------------------------------------------------------

/**
 * Return the list of valid avatar identifiers.
 * Public endpoint — used by the frontend to populate avatar pickers.
 *
 * Response 200: { avatarIds: string[] }
 */
router.get('/avatars', (req, res) => {
  return res.status(200).json({ avatarIds: VALID_AVATAR_IDS });
});



// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = router;
