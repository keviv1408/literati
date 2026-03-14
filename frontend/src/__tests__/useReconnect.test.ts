/**
 * Unit tests for the useReconnect hook.
 *
 * The hook validates the stored session (Supabase JWT or guest bearer token)
 * against the backend via GET /api/auth/me, then exposes a validated session
 * identity for WebSocket reconnection.
 *
 * Test matrix:
 *   Registered-user path:
 *     • Returns 'loading' while AuthContext is still hydrating
 *     • Returns 'ready' with correct identity when token is valid
 *     • Returns 'session_expired' when backend rejects the JWT (401)
 *     • Returns 'error' on network failure
 *
 *   Guest path:
 *     • Returns 'reconnecting' then 'ready' with valid cached token
 *     • Clears stale token and creates fresh session when backend returns 401
 *     • Reuses cached token on network error (graceful degradation)
 *     • Creates fresh session when no cached token exists
 *     • Returns 'error' when fresh session creation also fails
 *
 *   No-session path:
 *     • Returns 'no_session' when neither auth session nor guest name exists
 *
 *   Retry:
 *     • retry() re-triggers validation after an error
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';

// ── Mocks ──────────────────────────────────────────────────────────────────────

// Mock AuthContext
const mockUseAuth = jest.fn();
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

// Mock GuestContext
const mockUseGuest = jest.fn();
jest.mock('@/contexts/GuestContext', () => ({
  useGuest: () => mockUseGuest(),
}));

// Mock backendSession
const mockGetCachedToken = jest.fn<string | null, [string]>();
const mockClearToken = jest.fn();
jest.mock('@/lib/backendSession', () => ({
  getCachedToken: (name: string) => mockGetCachedToken(name),
  clearToken: () => mockClearToken(),
  saveToken: jest.fn(),
}));

// Mock api module
const mockValidateSession = jest.fn();
const mockGetGuestBearerToken = jest.fn<Promise<string>, [string]>();
jest.mock('@/lib/api', () => ({
  validateSession: (...args: unknown[]) => mockValidateSession(...args),
  getGuestBearerToken: (...args: unknown[]) => mockGetGuestBearerToken(...args as [string]),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
}));

import { useReconnect } from '@/hooks/useReconnect';
import { ApiError } from '@/lib/api';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Stub a fully-loaded Supabase session (registered user). */
function stubRegisteredSession(overrides?: {
  accessToken?: string;
  userId?: string;
  email?: string;
}) {
  const accessToken = overrides?.accessToken ?? 'test-access-token';
  const userId = overrides?.userId ?? 'user-uuid-123';
  const email = overrides?.email ?? 'test@example.com';

  mockUseAuth.mockReturnValue({
    user: { id: userId, email },
    session: { access_token: accessToken, user: { id: userId, email } },
    loading: false,
  });
  mockUseGuest.mockReturnValue({ guestSession: null });
}

/** Stub AuthContext still loading (initial render before session hydration). */
function stubAuthLoading() {
  mockUseAuth.mockReturnValue({ user: null, session: null, loading: true });
  mockUseGuest.mockReturnValue({ guestSession: null });
}

/** Stub a guest session with no Supabase account. */
function stubGuestSession(displayName = 'TestGuest') {
  mockUseAuth.mockReturnValue({ user: null, session: null, loading: false });
  mockUseGuest.mockReturnValue({
    guestSession: { type: 'guest', displayName, sessionId: 'client-sid', createdAt: Date.now() },
  });
}

/** Stub no session — neither Supabase nor guest. */
function stubNoSession() {
  mockUseAuth.mockReturnValue({ user: null, session: null, loading: false });
  mockUseGuest.mockReturnValue({ guestSession: null });
}

/** Resolve a validateSession call successfully. */
function resolveValidateSession(response: {
  isGuest: boolean;
  sessionId?: string;
  id?: string;
  email?: string;
  displayName: string;
  avatarId: string | null;
}) {
  mockValidateSession.mockResolvedValueOnce(response);
}

/** Make validateSession reject with ApiError(401). */
function rejectValidateWithUnauthorized() {
  mockValidateSession.mockRejectedValueOnce(new ApiError(401, 'Unauthorized'));
}

/** Make validateSession reject with a network error. */
function rejectValidateWithNetworkError() {
  mockValidateSession.mockRejectedValueOnce(new Error('Network error'));
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default: all mocks return reasonable defaults
  mockGetCachedToken.mockReturnValue(null);
  mockClearToken.mockImplementation(() => {});
  mockGetGuestBearerToken.mockResolvedValue('fresh-guest-token');
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useReconnect', () => {
  // ── Loading state ──────────────────────────────────────────────────────────

  describe('loading state', () => {
    it('returns status="loading" while AuthContext is hydrating', () => {
      stubAuthLoading();
      const { result } = renderHook(() => useReconnect());
      expect(result.current.status).toBe('loading');
    });

    it('has null sessionId and bearerToken while loading', () => {
      stubAuthLoading();
      const { result } = renderHook(() => useReconnect());
      expect(result.current.sessionId).toBeNull();
      expect(result.current.bearerToken).toBeNull();
    });
  });

  // ── No-session path ────────────────────────────────────────────────────────

  describe('no_session', () => {
    it('returns status="no_session" when there is no auth session and no guest name', async () => {
      stubNoSession();
      const { result } = renderHook(() => useReconnect());
      await waitFor(() => expect(result.current.status).toBe('no_session'));
    });

    it('has null sessionId and bearerToken when no_session', async () => {
      stubNoSession();
      const { result } = renderHook(() => useReconnect());
      await waitFor(() => expect(result.current.status).toBe('no_session'));
      expect(result.current.sessionId).toBeNull();
      expect(result.current.bearerToken).toBeNull();
    });

    it('reports isGuest=false when no_session', async () => {
      stubNoSession();
      const { result } = renderHook(() => useReconnect());
      await waitFor(() => expect(result.current.status).toBe('no_session'));
      expect(result.current.isGuest).toBe(false);
    });
  });

  // ── Registered-user path ───────────────────────────────────────────────────

  describe('registered user — valid session', () => {
    it('returns status="ready" after successful token validation', async () => {
      stubRegisteredSession();
      resolveValidateSession({
        isGuest: false,
        id: 'user-uuid-123',
        email: 'test@example.com',
        displayName: 'Alice',
        avatarId: null,
      });

      const { result } = renderHook(() => useReconnect());

      await waitFor(() => expect(result.current.status).toBe('ready'));
    });

    it('populates bearerToken from the Supabase access token', async () => {
      stubRegisteredSession({ accessToken: 'jwt-abc' });
      resolveValidateSession({
        isGuest: false,
        id: 'user-uuid-123',
        email: 'test@example.com',
        displayName: 'Alice',
        avatarId: null,
      });

      const { result } = renderHook(() => useReconnect());

      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current.bearerToken).toBe('jwt-abc');
    });

    it('populates sessionId from the ME response id', async () => {
      stubRegisteredSession({ userId: 'user-uuid-abc' });
      resolveValidateSession({
        isGuest: false,
        id: 'user-uuid-abc',
        email: 'test@example.com',
        displayName: 'Alice',
        avatarId: null,
      });

      const { result } = renderHook(() => useReconnect());

      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current.sessionId).toBe('user-uuid-abc');
    });

    it('reports isGuest=false for registered users', async () => {
      stubRegisteredSession();
      resolveValidateSession({
        isGuest: false,
        id: 'user-uuid-123',
        email: 'test@example.com',
        displayName: 'Alice',
        avatarId: null,
      });

      const { result } = renderHook(() => useReconnect());

      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current.isGuest).toBe(false);
    });

    it('populates displayName from the ME response', async () => {
      stubRegisteredSession();
      resolveValidateSession({
        isGuest: false,
        id: 'user-uuid-123',
        email: 'test@example.com',
        displayName: 'Alice Wonderland',
        avatarId: null,
      });

      const { result } = renderHook(() => useReconnect());

      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current.displayName).toBe('Alice Wonderland');
    });

    it('calls validateSession with the Supabase access token', async () => {
      stubRegisteredSession({ accessToken: 'my-jwt' });
      resolveValidateSession({
        isGuest: false,
        id: 'uid',
        displayName: 'User',
        avatarId: null,
      });

      renderHook(() => useReconnect());

      await waitFor(() => expect(mockValidateSession).toHaveBeenCalledWith('my-jwt'));
    });
  });

  describe('registered user — session expired', () => {
    it('returns status="session_expired" when backend rejects the JWT with 401', async () => {
      stubRegisteredSession();
      rejectValidateWithUnauthorized();

      const { result } = renderHook(() => useReconnect());

      await waitFor(() => expect(result.current.status).toBe('session_expired'));
    });

    it('provides a human-readable errorMessage on session_expired', async () => {
      stubRegisteredSession();
      rejectValidateWithUnauthorized();

      const { result } = renderHook(() => useReconnect());

      await waitFor(() => expect(result.current.status).toBe('session_expired'));
      expect(result.current.errorMessage).toBeTruthy();
      expect(typeof result.current.errorMessage).toBe('string');
    });

    it('nullifies sessionId and bearerToken on session_expired', async () => {
      stubRegisteredSession();
      rejectValidateWithUnauthorized();

      const { result } = renderHook(() => useReconnect());

      await waitFor(() => expect(result.current.status).toBe('session_expired'));
      expect(result.current.sessionId).toBeNull();
      expect(result.current.bearerToken).toBeNull();
    });
  });

  describe('registered user — network error', () => {
    it('returns status="error" when the network request fails', async () => {
      stubRegisteredSession();
      rejectValidateWithNetworkError();

      const { result } = renderHook(() => useReconnect());

      await waitFor(() => expect(result.current.status).toBe('error'));
    });

    it('provides a human-readable errorMessage on error', async () => {
      stubRegisteredSession();
      rejectValidateWithNetworkError();

      const { result } = renderHook(() => useReconnect());

      await waitFor(() => expect(result.current.status).toBe('error'));
      expect(result.current.errorMessage).toBeTruthy();
    });
  });

  // ── Guest path ─────────────────────────────────────────────────────────────

  describe('guest — valid cached token', () => {
    it('returns status="ready" after validating a cached token', async () => {
      stubGuestSession('GuestPlayer');
      mockGetCachedToken.mockReturnValue('cached-token-abc');
      resolveValidateSession({
        isGuest: true,
        sessionId: 'server-sid-xyz',
        displayName: 'GuestPlayer',
        avatarId: null,
      });

      const { result } = renderHook(() => useReconnect());

      await waitFor(() => expect(result.current.status).toBe('ready'));
    });

    it('populates sessionId from the server-side sessionId in the ME response', async () => {
      stubGuestSession('GuestPlayer');
      mockGetCachedToken.mockReturnValue('cached-token-abc');
      resolveValidateSession({
        isGuest: true,
        sessionId: 'server-sid-xyz',
        displayName: 'GuestPlayer',
        avatarId: null,
      });

      const { result } = renderHook(() => useReconnect());

      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current.sessionId).toBe('server-sid-xyz');
    });

    it('populates bearerToken with the cached token', async () => {
      stubGuestSession('GuestPlayer');
      mockGetCachedToken.mockReturnValue('cached-token-abc');
      resolveValidateSession({
        isGuest: true,
        sessionId: 'server-sid-xyz',
        displayName: 'GuestPlayer',
        avatarId: null,
      });

      const { result } = renderHook(() => useReconnect());

      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current.bearerToken).toBe('cached-token-abc');
    });

    it('reports isGuest=true for guest sessions', async () => {
      stubGuestSession('GuestPlayer');
      mockGetCachedToken.mockReturnValue('cached-token-abc');
      resolveValidateSession({
        isGuest: true,
        sessionId: 'server-sid-xyz',
        displayName: 'GuestPlayer',
        avatarId: null,
      });

      const { result } = renderHook(() => useReconnect());

      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current.isGuest).toBe(true);
    });

    it('does NOT call getGuestBearerToken when a valid cached token exists', async () => {
      stubGuestSession('GuestPlayer');
      mockGetCachedToken.mockReturnValue('cached-token-abc');
      resolveValidateSession({
        isGuest: true,
        sessionId: 'server-sid-xyz',
        displayName: 'GuestPlayer',
        avatarId: null,
      });

      renderHook(() => useReconnect());

      await waitFor(() => expect(mockValidateSession).toHaveBeenCalled());
      expect(mockGetGuestBearerToken).not.toHaveBeenCalled();
    });
  });

  describe('guest — stale cached token (server restarted)', () => {
    it('clears the stale token when backend returns 401', async () => {
      stubGuestSession('GuestPlayer');
      mockGetCachedToken.mockReturnValue('stale-token');
      // First validateSession call (stale token) → 401
      rejectValidateWithUnauthorized();
      // getGuestBearerToken creates fresh session
      mockGetGuestBearerToken.mockResolvedValueOnce('fresh-token-abc');
      // Second validateSession call (fresh token) → success
      resolveValidateSession({
        isGuest: true,
        sessionId: 'new-server-sid',
        displayName: 'GuestPlayer',
        avatarId: null,
      });

      const { result } = renderHook(() => useReconnect());

      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(mockClearToken).toHaveBeenCalledTimes(1);
    });

    it('creates a fresh guest session after clearing the stale token', async () => {
      stubGuestSession('GuestPlayer');
      mockGetCachedToken.mockReturnValue('stale-token');
      rejectValidateWithUnauthorized();
      mockGetGuestBearerToken.mockResolvedValueOnce('fresh-token-abc');
      resolveValidateSession({
        isGuest: true,
        sessionId: 'new-server-sid',
        displayName: 'GuestPlayer',
        avatarId: null,
      });

      const { result } = renderHook(() => useReconnect());

      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(mockGetGuestBearerToken).toHaveBeenCalledWith('GuestPlayer');
    });

    it('returns status="ready" after transparently re-creating the guest session', async () => {
      stubGuestSession('GuestPlayer');
      mockGetCachedToken.mockReturnValue('stale-token');
      rejectValidateWithUnauthorized();
      mockGetGuestBearerToken.mockResolvedValueOnce('fresh-token-abc');
      resolveValidateSession({
        isGuest: true,
        sessionId: 'new-server-sid',
        displayName: 'GuestPlayer',
        avatarId: null,
      });

      const { result } = renderHook(() => useReconnect());

      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current.bearerToken).toBe('fresh-token-abc');
      expect(result.current.sessionId).toBe('new-server-sid');
    });
  });

  describe('guest — network error while validating cached token', () => {
    it('returns status="ready" with cached token on network error (graceful degradation)', async () => {
      stubGuestSession('GuestPlayer');
      mockGetCachedToken.mockReturnValue('cached-token-abc');
      // Network error (not 401) — fall back to using the cached token
      rejectValidateWithNetworkError();

      const { result } = renderHook(() => useReconnect());

      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current.bearerToken).toBe('cached-token-abc');
    });

    it('does NOT clear the token on a network error', async () => {
      stubGuestSession('GuestPlayer');
      mockGetCachedToken.mockReturnValue('cached-token-abc');
      rejectValidateWithNetworkError();

      renderHook(() => useReconnect());

      await waitFor(() =>
        expect(mockGetCachedToken).toHaveBeenCalledWith('GuestPlayer')
      );
      // Give async ops time to settle
      await act(async () => {});
      expect(mockClearToken).not.toHaveBeenCalled();
    });
  });

  describe('guest — no cached token', () => {
    it('calls getGuestBearerToken when no cached token is available', async () => {
      stubGuestSession('GuestPlayer');
      mockGetCachedToken.mockReturnValue(null); // no cached token
      mockGetGuestBearerToken.mockResolvedValueOnce('brand-new-token');
      resolveValidateSession({
        isGuest: true,
        sessionId: 'fresh-sid',
        displayName: 'GuestPlayer',
        avatarId: null,
      });

      renderHook(() => useReconnect());

      await waitFor(() => expect(mockGetGuestBearerToken).toHaveBeenCalledWith('GuestPlayer'));
    });

    it('returns status="ready" with the fresh token', async () => {
      stubGuestSession('GuestPlayer');
      mockGetCachedToken.mockReturnValue(null);
      mockGetGuestBearerToken.mockResolvedValueOnce('brand-new-token');
      resolveValidateSession({
        isGuest: true,
        sessionId: 'fresh-sid',
        displayName: 'GuestPlayer',
        avatarId: null,
      });

      const { result } = renderHook(() => useReconnect());

      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current.bearerToken).toBe('brand-new-token');
    });
  });

  describe('guest — all token sources fail', () => {
    it('returns status="error" when both cached-token validation and fresh-token creation fail', async () => {
      stubGuestSession('GuestPlayer');
      mockGetCachedToken.mockReturnValue(null);
      mockGetGuestBearerToken.mockRejectedValueOnce(new Error('Server down'));

      const { result } = renderHook(() => useReconnect());

      await waitFor(() => expect(result.current.status).toBe('error'));
    });

    it('provides a human-readable errorMessage on guest error', async () => {
      stubGuestSession('GuestPlayer');
      mockGetCachedToken.mockReturnValue(null);
      mockGetGuestBearerToken.mockRejectedValueOnce(new Error('Server down'));

      const { result } = renderHook(() => useReconnect());

      await waitFor(() => expect(result.current.status).toBe('error'));
      expect(result.current.errorMessage).toBeTruthy();
    });
  });

  // ── retry() ───────────────────────────────────────────────────────────────

  describe('retry()', () => {
    it('transitions back to "loading" and re-runs validation', async () => {
      stubRegisteredSession();
      // First call fails
      rejectValidateWithNetworkError();

      const { result } = renderHook(() => useReconnect());
      await waitFor(() => expect(result.current.status).toBe('error'));

      // Second call succeeds after retry
      resolveValidateSession({
        isGuest: false,
        id: 'user-uuid-123',
        displayName: 'Alice',
        avatarId: null,
      });

      act(() => {
        result.current.retry();
      });

      await waitFor(() => expect(result.current.status).toBe('ready'));
    });

    it('clears the error message when retry() is called', async () => {
      stubRegisteredSession();
      rejectValidateWithNetworkError();

      const { result } = renderHook(() => useReconnect());
      await waitFor(() => expect(result.current.status).toBe('error'));

      resolveValidateSession({
        isGuest: false,
        id: 'uid',
        displayName: 'User',
        avatarId: null,
      });

      act(() => {
        result.current.retry();
      });

      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current.errorMessage).toBeNull();
    });
  });

  // ── Cancellation ──────────────────────────────────────────────────────────

  describe('cancellation', () => {
    it('does not update state after unmount (prevents memory leak)', async () => {
      stubRegisteredSession();

      // Never resolves to simulate a long-running request
      let resolveMe!: (v: unknown) => void;
      mockValidateSession.mockImplementation(
        () => new Promise((res) => { resolveMe = res; })
      );

      const { result, unmount } = renderHook(() => useReconnect());
      expect(result.current.status).toBe('reconnecting');

      // Unmount before the promise resolves
      unmount();

      // Resolve the promise after unmount
      act(() => {
        resolveMe({ isGuest: false, id: 'uid', displayName: 'User', avatarId: null });
      });

      // Status should not have changed to 'ready' after unmount
      // (React Testing Library will warn if setState is called after unmount)
      expect(result.current.status).toBe('reconnecting');
    });
  });
});
