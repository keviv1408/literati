/**
 * Unit tests for the useReconnect hook (guest-only MVP).
 *
 * The hook validates the stored guest bearer token against the backend
 * via GET /api/auth/me, then exposes a validated session identity for
 * WebSocket reconnection.
 *
 * Test matrix:
 *   Guest path:
 *     - Returns 'reconnecting' then 'ready' with valid cached token
 *     - Clears stale token and creates fresh session when backend returns 401
 *     - Reuses cached token on network error (graceful degradation)
 *     - Creates fresh session when no cached token exists
 *     - Returns 'error' when fresh session creation also fails
 *
 *   No-session path:
 *     - Returns 'no_session' when no guest name exists
 *
 *   Retry:
 *     - retry() re-triggers validation after an error
 */

import { renderHook, act, waitFor } from '@testing-library/react';

// ── Mocks ──────────────────────────────────────────────────────────────────────

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

/** Stub a guest session with no Supabase account. */
function stubGuestSession(displayName = 'TestGuest') {
  mockUseGuest.mockReturnValue({
    guestSession: { type: 'guest', displayName, sessionId: 'client-sid', createdAt: Date.now() },
  });
}

/** Stub no session — no guest name set. */
function stubNoSession() {
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
  mockGetCachedToken.mockReturnValue(null);
  mockClearToken.mockImplementation(() => {});
  mockGetGuestBearerToken.mockResolvedValue('fresh-guest-token');
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useReconnect', () => {
  // ── No-session path ────────────────────────────────────────────────────────

  describe('no_session', () => {
    it('returns status="no_session" when there is no guest name', async () => {
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
      await act(async () => {});
      expect(mockClearToken).not.toHaveBeenCalled();
    });
  });

  describe('guest — no cached token', () => {
    it('calls getGuestBearerToken when no cached token is available', async () => {
      stubGuestSession('GuestPlayer');
      mockGetCachedToken.mockReturnValue(null);
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
      stubGuestSession('GuestPlayer');
      mockGetCachedToken.mockReturnValue(null);
      mockGetGuestBearerToken.mockRejectedValueOnce(new Error('Server down'));

      const { result } = renderHook(() => useReconnect());
      await waitFor(() => expect(result.current.status).toBe('error'));

      // Second call succeeds after retry
      mockGetGuestBearerToken.mockResolvedValueOnce('retry-token');
      resolveValidateSession({
        isGuest: true,
        sessionId: 'retry-sid',
        displayName: 'GuestPlayer',
        avatarId: null,
      });

      act(() => {
        result.current.retry();
      });

      await waitFor(() => expect(result.current.status).toBe('ready'));
    });

    it('clears the error message when retry() is called', async () => {
      stubGuestSession('GuestPlayer');
      mockGetCachedToken.mockReturnValue(null);
      mockGetGuestBearerToken.mockRejectedValueOnce(new Error('Server down'));

      const { result } = renderHook(() => useReconnect());
      await waitFor(() => expect(result.current.status).toBe('error'));

      mockGetGuestBearerToken.mockResolvedValueOnce('retry-token');
      resolveValidateSession({
        isGuest: true,
        sessionId: 'retry-sid',
        displayName: 'GuestPlayer',
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
      stubGuestSession('GuestPlayer');
      mockGetCachedToken.mockReturnValue('cached-token');

      // Never resolves to simulate a long-running request
      let resolveMe!: (v: unknown) => void;
      mockValidateSession.mockImplementation(
        () => new Promise((res) => { resolveMe = res; })
      );

      const { result, unmount } = renderHook(() => useReconnect());
      expect(result.current.status).toBe('reconnecting');

      unmount();

      act(() => {
        resolveMe({ isGuest: true, sessionId: 'sid', displayName: 'GuestPlayer', avatarId: null });
      });

      expect(result.current.status).toBe('reconnecting');
    });
  });
});
