'use strict';

/**
 * Authentication routes.
 *
 * ── Guest (no Supabase account) ──────────────────────────────────────────────
 * POST   /api/auth/guest   — Create a temporary guest session (no DB writes)
 * DELETE /api/auth/guest   — Destroy the caller's guest session
 *
 * ── Registered users ─────────────────────────────────────────────────────────
 * POST   /api/auth/register — Create a new account (email + password)
 * POST   /api/auth/login    — Sign in with email + password; returns JWT
 * POST   /api/auth/logout   — Invalidate the current session
 * POST   /api/auth/refresh  — Exchange a refresh token for a new access token
 *
 * ── Shared ───────────────────────────────────────────────────────────────────
 * GET    /api/auth/me       — Return the current session's public identity
 * GET    /api/auth/avatars  — Return valid avatar IDs (public)
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

const { requireAuth, optionalAuth, extractBearerToken } = require('../middleware/auth');
const { getSupabaseClient, getAuthClient } = require('../db/supabase');

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
  // Use a custom key so that tests can override by not mounting the limiter.
  skip: () => process.env.NODE_ENV === 'test',
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
router.get('/me', requireAuth, async (req, res) => {
  const { user } = req;

  if (user.isGuest) {
    return res.status(200).json({
      isGuest: true,
      sessionId: user.sessionId,
      displayName: user.displayName,
      avatarId: user.avatarId,
    });
  }

  // For registered users, fetch the authoritative display name and avatar
  // from user_profiles. Google OAuth users have their display name stored
  // there (set on first sign-in by the callback route), not in user_metadata.
  let displayName = user.displayName;
  let avatarId = user.avatarId;

  try {
    const supabase = getSupabaseClient();
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('display_name, avatar_id')
      .eq('id', user.id)
      .maybeSingle();

    if (profile) {
      displayName = profile.display_name || displayName;
      avatarId = profile.avatar_id || avatarId;
    }
  } catch {
    // Profile lookup failure is non-fatal — use JWT metadata fallback.
  }

  return res.status(200).json({
    isGuest: false,
    id: user.id,
    email: user.email,
    displayName,
    avatarId,
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

// ===========================================================================
// Registered-user authentication
// ===========================================================================

// ---------------------------------------------------------------------------
// Rate limiters for registered-user auth
// ---------------------------------------------------------------------------

/**
 * Strict rate limit for registration — prevents mass account creation.
 * 5 registrations per IP per hour.
 */
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too Many Requests',
    message: 'Too many registration attempts from this IP. Please try again later.',
  },
  skip: () => process.env.NODE_ENV === 'test',
});

/**
 * Anti-brute-force limiter for login.
 * 10 attempts per IP per 15 minutes.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too Many Requests',
    message: 'Too many login attempts from this IP. Please try again later.',
  },
  skip: () => process.env.NODE_ENV === 'test',
});

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

/**
 * Basic email format validation (RFC 5321-ish: local@domain.tld).
 * Supabase performs full validation on its end; this is a fast client-side gate.
 *
 * @param {string} email
 * @returns {boolean}
 */
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * Password policy:
 *   - At least 8 characters
 *   - At least one letter
 *   - At least one digit
 *
 * These rules are enforced server-side only; the client may apply the same
 * rules for UX feedback but the server is always authoritative.
 *
 * @param {string} password
 * @returns {string|null} Error message or null if valid.
 */
function validatePassword(password) {
  if (typeof password !== 'string') return 'password must be a string';
  if (password.length < 8) return 'password must be at least 8 characters';
  if (!/[a-zA-Z]/.test(password)) return 'password must contain at least one letter';
  if (!/[0-9]/.test(password)) return 'password must contain at least one digit';
  return null;
}

// ---------------------------------------------------------------------------
// POST /api/auth/register
// ---------------------------------------------------------------------------

/**
 * Create a new registered account.
 *
 * Request body:
 *   email        {string}  required
 *   password     {string}  required — ≥8 chars, ≥1 letter, ≥1 digit
 *   displayName  {string}  required — 1–20 characters
 *   avatarId     {string}  optional — one of VALID_AVATAR_IDS; defaults to 'avatar-1'
 *
 * Response 201:
 *   {
 *     accessToken  : string   — JWT; use as "Authorization: Bearer <token>"
 *     refreshToken : string   — Opaque; store securely for token refresh
 *     expiresIn    : number   — Access token lifetime in seconds
 *     user : {
 *       id          : string  — Supabase UUID
 *       email       : string
 *       displayName : string
 *       avatarId    : string
 *     }
 *   }
 *
 * Errors:
 *   400 — Validation failure or malformed request
 *   409 — Email address already registered
 *   429 — Rate limit exceeded
 *   500 — Unexpected server error
 *
 * Implementation notes:
 *   - Supabase Auth handles password hashing (bcrypt, cost factor 10+).
 *   - email_confirm is set to true so no email verification step is required
 *     (per product spec: "No email verification required").
 *   - After the Supabase user is created, a user_profiles row is inserted
 *     with display_name and avatar_id.
 *   - We immediately sign the user in and return their access + refresh tokens
 *     so the client can start using the API without a second round-trip.
 */
router.post('/register', registerLimiter, async (req, res) => {
  const { email, password, displayName, avatarId } = req.body || {};

  // ── Input validation ───────────────────────────────────────────────────────

  const errors = [];

  // email
  if (!email) {
    errors.push('email is required');
  } else if (!isValidEmail(email)) {
    errors.push('email must be a valid email address');
  }

  // password
  const passwordError = validatePassword(password);
  if (password === undefined || password === null) {
    errors.push('password is required');
  } else if (passwordError) {
    errors.push(passwordError);
  }

  // displayName
  if (displayName === undefined || displayName === null) {
    errors.push('displayName is required');
  } else if (typeof displayName !== 'string') {
    errors.push('displayName must be a string');
  } else {
    const trimmed = displayName.trim();
    if (trimmed.length < MIN_DISPLAY_NAME_LENGTH) {
      errors.push(`displayName must be at least ${MIN_DISPLAY_NAME_LENGTH} character`);
    } else if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
      errors.push(`displayName must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`);
    }
  }

  // avatarId (optional)
  if (avatarId !== undefined && avatarId !== null) {
    if (typeof avatarId !== 'string' || !VALID_AVATAR_IDS.includes(avatarId)) {
      errors.push(`avatarId must be one of: ${VALID_AVATAR_IDS.join(', ')}`);
    }
  }

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }

  const trimmedName = displayName.trim();
  const resolvedAvatarId = avatarId || 'avatar-1';
  const normalizedEmail = email.trim().toLowerCase();

  // ── Create Supabase Auth user ──────────────────────────────────────────────

  let newUser;
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.auth.admin.createUser({
      email: normalizedEmail,
      password,
      email_confirm: true, // no email verification required per spec
      user_metadata: {
        display_name: trimmedName,
        avatar_id: resolvedAvatarId,
      },
    });

    if (error) {
      // Supabase returns status 422 for duplicate email
      if (
        error.status === 422 ||
        (error.message && error.message.toLowerCase().includes('already registered'))
      ) {
        return res.status(409).json({
          error: 'Conflict',
          message: 'An account with this email address already exists.',
        });
      }
      console.error('Supabase admin.createUser error:', error);
      return res.status(500).json({
        error: 'Registration failed',
        message: 'Unable to create account. Please try again.',
      });
    }

    newUser = data.user;
  } catch (err) {
    console.error('Registration unexpected error:', err);
    return res.status(500).json({
      error: 'Registration failed',
      message: 'Unable to create account. Please try again.',
    });
  }

  // ── Create user_profiles row ───────────────────────────────────────────────
  // Non-fatal: profile row may fail if table doesn't exist yet (e.g., in
  // environments that haven't run migration 002).  Log the error but continue
  // so the user can still receive their tokens.

  try {
    const supabase = getSupabaseClient();
    const { error: profileError } = await supabase
      .from('user_profiles')
      .insert({
        id: newUser.id,
        display_name: trimmedName,
        avatar_id: resolvedAvatarId,
      });

    if (profileError) {
      console.error('Failed to create user_profiles row:', profileError);
    }
  } catch (err) {
    console.error('user_profiles insert unexpected error:', err);
  }

  // ── Sign in to obtain access + refresh tokens ──────────────────────────────

  try {
    const authClient = getAuthClient();
    const { data: sessionData, error: signInError } =
      await authClient.auth.signInWithPassword({
        email: normalizedEmail,
        password,
      });

    if (signInError || !sessionData?.session) {
      // Registration succeeded but auto-sign-in failed.  Return 201 without
      // tokens — the client should redirect to the login page.
      console.error('Auto-sign-in after registration failed:', signInError);
      return res.status(201).json({
        message: 'Account created. Please sign in.',
        user: {
          id: newUser.id,
          email: newUser.email,
          displayName: trimmedName,
          avatarId: resolvedAvatarId,
        },
      });
    }

    const { session } = sessionData;
    return res.status(201).json({
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresIn: session.expires_in,
      user: {
        id: newUser.id,
        email: newUser.email,
        displayName: trimmedName,
        avatarId: resolvedAvatarId,
      },
    });
  } catch (err) {
    console.error('Sign-in after registration unexpected error:', err);
    return res.status(201).json({
      message: 'Account created. Please sign in.',
      user: {
        id: newUser.id,
        email: newUser.email,
        displayName: trimmedName,
        avatarId: resolvedAvatarId,
      },
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------

/**
 * Sign in with email and password.
 *
 * Request body:
 *   email    {string}  required
 *   password {string}  required
 *
 * Response 200:
 *   {
 *     accessToken  : string
 *     refreshToken : string
 *     expiresIn    : number   — seconds
 *     user : {
 *       id          : string
 *       email       : string
 *       displayName : string
 *       avatarId    : string | null
 *     }
 *   }
 *
 * Errors:
 *   400 — Validation failure
 *   401 — Invalid credentials
 *   429 — Rate limit exceeded
 *   500 — Unexpected server error
 */
router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};

  // ── Input validation ───────────────────────────────────────────────────────

  const errors = [];

  if (!email) {
    errors.push('email is required');
  } else if (!isValidEmail(email)) {
    errors.push('email must be a valid email address');
  }

  if (password === undefined || password === null || password === '') {
    errors.push('password is required');
  } else if (typeof password !== 'string') {
    errors.push('password must be a string');
  }

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }

  const normalizedEmail = email.trim().toLowerCase();

  // ── Authenticate via Supabase ──────────────────────────────────────────────

  try {
    const authClient = getAuthClient();
    const { data, error } = await authClient.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });

    if (error || !data?.session) {
      // Use a generic message to avoid user enumeration.
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid email address or password.',
      });
    }

    const { user, session } = data;

    return res.status(200).json({
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresIn: session.expires_in,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.user_metadata?.display_name || user.email,
        avatarId: user.user_metadata?.avatar_id || null,
      },
    });
  } catch (err) {
    console.error('Login unexpected error:', err);
    return res.status(500).json({
      error: 'Login failed',
      message: 'Unable to sign in. Please try again.',
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------

/**
 * Invalidate the caller's current session.
 *
 * The client must present a valid Bearer token (registered user only;
 * guests should use DELETE /api/auth/guest instead).
 *
 * Response 200: { message: 'Logged out successfully' }
 * Response 401: No valid Bearer token
 * Response 403: Token belongs to a guest session (guests cannot use this endpoint)
 */
router.post('/logout', requireAuth, async (req, res) => {
  if (req.user.isGuest) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Guest sessions cannot use this endpoint. Use DELETE /api/auth/guest instead.',
    });
  }

  const token = extractBearerToken(req);

  try {
    const supabase = getSupabaseClient();
    // Sign the user out globally (invalidates all sessions for this user).
    await supabase.auth.admin.signOut(token);
  } catch (err) {
    // Log but do not surface internal errors; the client should clear local
    // tokens regardless of whether the server-side revocation succeeded.
    console.error('Logout error (non-fatal):', err);
  }

  return res.status(200).json({ message: 'Logged out successfully' });
});

// ---------------------------------------------------------------------------
// POST /api/auth/refresh
// ---------------------------------------------------------------------------

/**
 * Exchange a refresh token for a new access token.
 *
 * This endpoint is intentionally unauthenticated (no Bearer token required)
 * because the whole point is to issue a new access token when the old one
 * has expired.
 *
 * Request body:
 *   refreshToken {string}  required
 *
 * Response 200:
 *   {
 *     accessToken  : string
 *     refreshToken : string   — new refresh token (rotation)
 *     expiresIn    : number
 *   }
 *
 * Errors:
 *   400 — refreshToken missing or not a string
 *   401 — Invalid or expired refresh token
 *   500 — Unexpected server error
 */
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body || {};

  if (!refreshToken || typeof refreshToken !== 'string') {
    return res.status(400).json({
      error: 'Validation failed',
      details: ['refreshToken is required and must be a string'],
    });
  }

  try {
    const authClient = getAuthClient();
    const { data, error } = await authClient.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error || !data?.session) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or expired refresh token. Please sign in again.',
      });
    }

    const { session } = data;
    return res.status(200).json({
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresIn: session.expires_in,
    });
  } catch (err) {
    console.error('Token refresh unexpected error:', err);
    return res.status(500).json({
      error: 'Refresh failed',
      message: 'Unable to refresh session. Please sign in again.',
    });
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = router;
