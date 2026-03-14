/**
 * Tests for AuthContext / AuthProvider.
 *
 * We mock the Supabase browser client so no real network calls are made.
 * These tests verify:
 *  - The context exposes user/session/loading correctly.
 *  - signInWithGoogle calls supabase.auth.signInWithOAuth with the right args.
 *  - signOut calls supabase.auth.signOut.
 *  - Auth state changes are reflected in the context value.
 *  - useAuth throws when used outside the provider.
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Mock the Supabase browser client module BEFORE importing the context.
// ---------------------------------------------------------------------------

const mockGetSession = jest.fn();
const mockSignInWithOAuth = jest.fn();
const mockSignOut = jest.fn();
let authStateChangeCallback: ((event: string, session: unknown) => void) | null =
  null;
const mockUnsubscribe = jest.fn();

const mockSupabase = {
  auth: {
    getSession: mockGetSession,
    onAuthStateChange: jest.fn((cb: (event: string, session: unknown) => void) => {
      authStateChangeCallback = cb;
      return { data: { subscription: { unsubscribe: mockUnsubscribe } } };
    }),
    signInWithOAuth: mockSignInWithOAuth,
    signOut: mockSignOut,
  },
};

jest.mock('@/lib/supabase/client', () => ({
  getSupabaseBrowserClient: jest.fn(() => mockSupabase),
  _resetSupabaseClient: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocking
// ---------------------------------------------------------------------------

import { AuthProvider, useAuth } from '@/contexts/AuthContext';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function TestConsumer() {
  const { user, session, loading, signInWithGoogle, signOut } = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="user">{user?.email ?? 'null'}</span>
      <span data-testid="session">{session ? 'has-session' : 'no-session'}</span>
      <button onClick={() => signInWithGoogle()}>Sign In</button>
      <button onClick={() => signOut()}>Sign Out</button>
    </div>
  );
}

function renderWithProvider() {
  return render(
    <AuthProvider>
      <TestConsumer />
    </AuthProvider>
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  authStateChangeCallback = null;

  // Default: no active session
  mockGetSession.mockResolvedValue({ data: { session: null } });
  mockSignInWithOAuth.mockResolvedValue({ error: null });
  mockSignOut.mockResolvedValue({ error: null });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuthProvider — initial state', () => {
  it('starts in loading=true, then settles to loading=false with no session', async () => {
    renderWithProvider();

    // Initially loading
    expect(screen.getByTestId('loading').textContent).toBe('true');

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    expect(screen.getByTestId('user').textContent).toBe('null');
    expect(screen.getByTestId('session').textContent).toBe('no-session');
  });

  it('restores an existing session on mount', async () => {
    const fakeSession = {
      user: { id: 'u1', email: 'alice@example.com' },
      access_token: 'tok',
    };
    mockGetSession.mockResolvedValue({ data: { session: fakeSession } });

    renderWithProvider();

    await waitFor(() => {
      expect(screen.getByTestId('user').textContent).toBe('alice@example.com');
    });

    expect(screen.getByTestId('session').textContent).toBe('has-session');
    expect(screen.getByTestId('loading').textContent).toBe('false');
  });
});

describe('AuthProvider — auth state changes', () => {
  it('updates user/session when onAuthStateChange fires with a new session', async () => {
    renderWithProvider();

    await waitFor(() =>
      expect(screen.getByTestId('loading').textContent).toBe('false')
    );

    const newSession = {
      user: { id: 'u2', email: 'bob@example.com' },
      access_token: 'new-tok',
    };

    act(() => {
      authStateChangeCallback?.('SIGNED_IN', newSession);
    });

    await waitFor(() => {
      expect(screen.getByTestId('user').textContent).toBe('bob@example.com');
    });
    expect(screen.getByTestId('session').textContent).toBe('has-session');
  });

  it('clears user/session when onAuthStateChange fires with null', async () => {
    const fakeSession = {
      user: { id: 'u3', email: 'carol@example.com' },
      access_token: 'tok',
    };
    mockGetSession.mockResolvedValue({ data: { session: fakeSession } });

    renderWithProvider();

    await waitFor(() =>
      expect(screen.getByTestId('user').textContent).toBe('carol@example.com')
    );

    act(() => {
      authStateChangeCallback?.('SIGNED_OUT', null);
    });

    await waitFor(() => {
      expect(screen.getByTestId('user').textContent).toBe('null');
    });
    expect(screen.getByTestId('session').textContent).toBe('no-session');
  });
});

describe('signInWithGoogle', () => {
  it('calls supabase.auth.signInWithOAuth with google provider', async () => {
    renderWithProvider();

    await waitFor(() =>
      expect(screen.getByTestId('loading').textContent).toBe('false')
    );

    await userEvent.click(screen.getByText('Sign In'));

    expect(mockSignInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'google',
        options: expect.objectContaining({
          redirectTo: expect.stringContaining('/auth/callback'),
          queryParams: expect.objectContaining({ access_type: 'offline' }),
        }),
      })
    );
  });

  it('throws when supabase returns an error', async () => {
    mockSignInWithOAuth.mockResolvedValue({
      error: { message: 'Provider disabled' },
    });

    renderWithProvider();

    await waitFor(() =>
      expect(screen.getByTestId('loading').textContent).toBe('false')
    );

    // Capture the thrown error via the click handler
    const { signInWithGoogle } = (() => {
      let captured: ReturnType<typeof useAuth> | undefined;
      function Capture() {
        captured = useAuth();
        return null;
      }
      render(
        <AuthProvider>
          <Capture />
        </AuthProvider>
      );
      return captured!;
    })();

    await expect(signInWithGoogle()).rejects.toThrow('Provider disabled');
  });
});

describe('signOut', () => {
  it('calls supabase.auth.signOut', async () => {
    renderWithProvider();

    await waitFor(() =>
      expect(screen.getByTestId('loading').textContent).toBe('false')
    );

    await userEvent.click(screen.getByText('Sign Out'));

    expect(mockSignOut).toHaveBeenCalled();
  });

  it('throws when supabase returns an error', async () => {
    mockSignOut.mockResolvedValue({ error: { message: 'Sign-out failed' } });

    let capturedSignOut: (() => Promise<void>) | undefined;
    function Capture() {
      capturedSignOut = useAuth().signOut;
      return null;
    }
    render(
      <AuthProvider>
        <Capture />
      </AuthProvider>
    );

    await waitFor(() => expect(capturedSignOut).toBeDefined());
    await expect(capturedSignOut!()).rejects.toThrow('Sign-out failed');
  });
});

describe('useAuth outside provider', () => {
  it('throws a descriptive error', () => {
    // Suppress the React error boundary output in test output.
    const consoleSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    function Orphan() {
      useAuth();
      return null;
    }

    expect(() => render(<Orphan />)).toThrow(
      'useAuth must be used within an AuthProvider'
    );

    consoleSpy.mockRestore();
  });
});
