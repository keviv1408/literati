'use client';

/**
 * useReconnect — validates the stored session against the backend and provides
 * the auth data needed to re-establish a WebSocket connection on page refresh.
 *
 * ── Why this hook exists ────────────────────────────────────────────────────
 * When a player refreshes the browser while inside a room, two separate
 * sessions must be validated before the WebSocket can reconnect:
 *
 *   Registered user:
 *     Supabase restores the session automatically in AuthContext (getSession
 *     auto-refreshes the access token if it is near expiry).  This hook then
 *     validates the access token with the backend to confirm it is still
 *     accepted.  If the token is rejected (401) it means both the access token
 *     and the refresh token have expired; the user is shown a "session expired"
 *     screen and prompted to sign in again.
 *
 *   Guest:
 *     The backend guest bearer token is stored in localStorage via
 *     backendSession.ts with a 24-hour TTL.  If the cached token is still
 *     within the TTL window, this hook validates it with the backend.  If the
 *     backend rejects it (e.g. because the server was restarted and lost its
 *     in-memory guest-session store), the stale token is cleared and a fresh
 *     guest session is created transparently so the player can continue
 *     without being shown an error.
 *
 * ── Returned status values ──────────────────────────────────────────────────
 *   'loading'          AuthContext is still hydrating the Supabase session.
 *   'reconnecting'     Validating the stored session with the backend.
 *   'ready'            Session valid; WebSocket can connect.
 *   'session_expired'  Registered-user session can no longer be refreshed;
 *                      sign-in required.
 *   'no_session'       No session found; guest has not entered a display name
 *                      and there is no Supabase session.
 *   'error'            Unexpected error (network failure, server unreachable).
 *
 * ── Usage in a room page ────────────────────────────────────────────────────
 *   const { status, sessionId, bearerToken, retry } = useReconnect();
 *
 *   // Guard the WebSocket hook until the session is validated:
 *   useRoomSocket({
 *     roomCode,
 *     sessionId: status === 'ready' ? sessionId : null,
 *     bearerToken: status === 'ready' ? bearerToken : null,
 *   });
 */

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useGuest } from '@/contexts/GuestContext';
import { clearToken, getCachedToken } from '@/lib/backendSession';
import { getGuestBearerToken, validateSession, ApiError } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ReconnectStatus =
  | 'loading'           // AuthContext still hydrating
  | 'reconnecting'      // Validating session with backend
  | 'ready'             // Session valid; can connect WebSocket
  | 'session_expired'   // Registered session expired (sign-in required)
  | 'no_session'        // Guest has no display name / not authenticated
  | 'error';            // Network failure or unexpected error

export interface ReconnectResult {
  /** Current validation lifecycle phase. */
  status: ReconnectStatus;
  /**
   * Backend identity for the current session:
   *   - Guest: server-side sessionId from the guest session store.
   *   - Registered: Supabase user UUID.
   *
   * Null while loading/reconnecting; populated once status === 'ready'.
   */
  sessionId: string | null;
  /**
   * Bearer token for WebSocket authentication (passed as ?token=).
   *   - Guest: opaque token from the backend guest session store.
   *   - Registered: Supabase JWT access token.
   *
   * Null while loading/reconnecting; populated once status === 'ready'.
   */
  bearerToken: string | null;
  /** True when the session belongs to a guest (no Supabase account). */
  isGuest: boolean;
  /** Display name of the current user. Null until status === 'ready'. */
  displayName: string | null;
  /**
   * Human-readable error for 'session_expired' and 'error' statuses.
   * Null otherwise.
   */
  errorMessage: string | null;
  /**
   * Re-trigger session validation after a transient error.
   * No-ops while status is already 'loading' or 'reconnecting'.
   */
  retry: () => void;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useReconnect(): ReconnectResult {
  const { user, session, loading: authLoading } = useAuth();
  const { guestSession } = useGuest();

  const [status, setStatus] = useState<ReconnectStatus>('loading');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [bearerToken, setBearerToken] = useState<string | null>(null);
  const [isGuest, setIsGuest] = useState(false);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Increment to force a re-run of the validation effect on retry().
  const [retryCounter, setRetryCounter] = useState(0);

  const retry = useCallback(() => {
    setStatus('loading');
    setErrorMessage(null);
    setRetryCounter((c) => c + 1);
  }, []);

  useEffect(() => {
    // ── Wait for the Supabase session to hydrate ─────────────────────────────
    // AuthContext calls getSession() on mount; this is async and takes ~100ms.
    // Supabase automatically refreshes the access token if it is near expiry.
    if (authLoading) {
      setStatus('loading');
      return;
    }

    let cancelled = false;

    // ── Registered-user path ──────────────────────────────────────────────────
    // `session` and `user` are both non-null when Supabase has a valid session.
    // By this point Supabase has already auto-refreshed the access token if
    // it was near expiry, so session.access_token should be fresh.
    if (session && user) {
      setStatus('reconnecting');

      const validateRegistered = async () => {
        try {
          const me = await validateSession(session.access_token);
          if (cancelled) return;

          setSessionId(me.id ?? user.id);
          setBearerToken(session.access_token);
          setIsGuest(false);
          setDisplayName(me.displayName || user.email || null);
          setErrorMessage(null);
          setStatus('ready');
        } catch (err) {
          if (cancelled) return;

          if (err instanceof ApiError && err.status === 401) {
            // Backend rejected the token.  Since Supabase already handled
            // session refresh in AuthContext (getSession auto-refreshes),
            // a 401 here means both access and refresh tokens are truly
            // expired — the user must sign in again.
            setSessionId(null);
            setBearerToken(null);
            setIsGuest(false);
            setDisplayName(null);
            setStatus('session_expired');
            setErrorMessage(
              'Your session has expired. Please sign in again to continue.'
            );
          } else {
            // Network error or unexpected server error.
            setSessionId(null);
            setBearerToken(null);
            setStatus('error');
            setErrorMessage(
              'Could not reach the server. Please check your connection and try again.'
            );
          }
        }
      };

      validateRegistered();
      return () => {
        cancelled = true;
      };
    }

    // ── Guest path ────────────────────────────────────────────────────────────
    // GuestContext loads the display name from localStorage on mount (sync).
    if (guestSession?.displayName) {
      setStatus('reconnecting');

      const validateGuest = async () => {
        const name = guestSession.displayName;

        try {
          // 1. Try the locally-cached bearer token first (no network).
          const cachedToken = getCachedToken(name);

          if (cachedToken) {
            try {
              const me = await validateSession(cachedToken);
              if (cancelled) return;

              // Cached token is still valid on the backend.
              setSessionId(me.sessionId ?? null);
              setBearerToken(cachedToken);
              setIsGuest(true);
              setDisplayName(me.displayName || name);
              setErrorMessage(null);
              setStatus('ready');
              return;
            } catch (err) {
              if (cancelled) return;

              if (err instanceof ApiError && err.status === 401) {
                // Cached token was rejected by the backend (e.g. server was
                // restarted and lost its in-memory guest-session store).
                // Clear the stale token and fall through to create a fresh
                // session below — this is transparent to the player.
                clearToken();
              } else {
                // Network error while validating.  Proceed with the cached
                // token anyway; the WebSocket server will reject it with
                // close code 4001 if it is truly invalid (rare).
                setSessionId(null);
                setBearerToken(cachedToken);
                setIsGuest(true);
                setDisplayName(name);
                setErrorMessage(null);
                setStatus('ready');
                return;
              }
            }
          }

          // 2. No valid cached token — register a fresh guest session.
          //    POST /api/auth/guest creates a new in-memory session and
          //    caches the returned token in backendSession.ts.
          const freshToken = await getGuestBearerToken(name);
          if (cancelled) return;

          // Validate to get the server-assigned sessionId.
          const me = await validateSession(freshToken);
          if (cancelled) return;

          setSessionId(me.sessionId ?? null);
          setBearerToken(freshToken);
          setIsGuest(true);
          setDisplayName(me.displayName || name);
          setErrorMessage(null);
          setStatus('ready');
        } catch {
          if (cancelled) return;
          // Backend is unreachable — can't create or validate a guest session.
          setSessionId(null);
          setBearerToken(null);
          setStatus('error');
          setErrorMessage(
            'Could not connect to the server. Please check your connection and try again.'
          );
        }
      };

      validateGuest();
      return () => {
        cancelled = true;
      };
    }

    // ── No session at all ─────────────────────────────────────────────────────
    // There is no Supabase session and the guest has not set a display name.
    setStatus('no_session');
    setSessionId(null);
    setBearerToken(null);
    setIsGuest(false);
    setDisplayName(null);
    setErrorMessage(null);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, session, user, guestSession, retryCounter]);

  return {
    status,
    sessionId,
    bearerToken,
    isGuest,
    displayName,
    errorMessage,
    retry,
  };
}
