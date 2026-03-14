'use client';

/**
 * AuthContext — manages the Supabase-authenticated (registered) user session.
 *
 * This context is separate from GuestContext; the two are independent:
 *  - GuestContext handles ephemeral, client-side-only display name sessions.
 *  - AuthContext handles persistent Supabase sessions (Google OAuth,
 *    email/password).
 *
 * Consumer responsibilities:
 *  - Read `user` to know who is signed in (null = no registered session).
 *  - Read `session` to get the raw Supabase session (access_token, etc.).
 *  - Call `signInWithGoogle()` to initiate the Google OAuth flow.
 *  - Call `signInWithEmail(email, password)` for email/password sign-in.
 *  - Call `registerWithEmail(email, password, displayName, avatarId?)` to
 *    create an account. The backend auto-confirms the email
 *    (email_confirm: true — no email verification gate).
 *  - Call `signOut()` to end the Supabase session.
 *  - Read `loading` to show a spinner while the session is being restored.
 *
 * Important: the access_token from `session.access_token` is the Bearer token
 * that must be sent to the backend as `Authorization: Bearer <token>`.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import type { AuthChangeEvent, Session, User } from '@supabase/supabase-js';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import { API_URL } from '@/lib/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegisterResult {
  /** Present on successful registration with immediate sign-in. */
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  user: {
    id: string;
    email: string;
    displayName: string;
    avatarId: string;
  };
  /** Set when account was created but auto sign-in failed. */
  message?: string;
}

export interface AuthContextValue {
  /** The Supabase user object, or null if not signed in. */
  user: User | null;
  /** The full Supabase session (includes access_token). Null if not signed in. */
  session: Session | null;
  /** True while the initial session is being restored from storage. */
  loading: boolean;
  /**
   * Initiate Google OAuth. The browser will be redirected to Google,
   * then back to /auth/callback when complete.
   *
   * @param next  Optional relative path to redirect to after sign-in (default: '/').
   */
  signInWithGoogle: (next?: string) => Promise<void>;
  /**
   * Sign in with email and password.
   * Uses the Supabase browser client directly (anon key).
   * Throws on failure (wrong credentials, network error, etc.).
   */
  signInWithEmail: (email: string, password: string) => Promise<void>;
  /**
   * Create a new account with email + password.
   *
   * Calls the backend /api/auth/register endpoint which uses
   * Supabase's Admin API with email_confirm: true, so the newly
   * registered user can join or create a game immediately
   * WITHOUT any email verification step.
   *
   * A fresh user_stats row (wins, losses, etc.) is created atomically
   * in the database by the on_auth_user_created trigger as part of the
   * same transaction — stats are ready from the moment the account exists.
   *
   * On success the returned JWT is loaded into the Supabase browser client
   * so `user` and `session` update immediately.
   *
   * @throws Error with a human-readable message on failure.
   */
  registerWithEmail: (
    email: string,
    password: string,
    displayName: string,
    avatarId?: string
  ) => Promise<RegisterResult>;
  /** Sign out of the Supabase session. */
  signOut: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const AuthContext = createContext<AuthContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let supabase: ReturnType<typeof getSupabaseBrowserClient>;

    try {
      supabase = getSupabaseBrowserClient();
    } catch {
      // Supabase not configured (e.g. unit tests without env vars).
      setLoading(false);
      return;
    }

    // 1. Restore the session from cookie/localStorage on first render.
    supabase.auth.getSession().then(({ data }: { data: { session: Session | null } }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
      setLoading(false);
    });

    // 2. Subscribe to auth state changes (sign-in, sign-out, token refresh).
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event: AuthChangeEvent, newSession: Session | null) => {
      setSession(newSession);
      setUser(newSession?.user ?? null);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  // ── Actions ─────────────────────────────────────────────────────────────────

  const signInWithGoogle = useCallback(async (next = '/') => {
    const supabase = getSupabaseBrowserClient();

    const redirectTo =
      typeof window !== 'undefined'
        ? `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`
        : `/auth/callback?next=${encodeURIComponent(next)}`;

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
        queryParams: {
          access_type: 'offline',
          prompt: 'select_account',
        },
      },
    });

    if (error) {
      throw new Error(error.message);
    }
    // On success the browser is redirected — nothing more to do here.
  }, []);

  /**
   * Email + password sign-in via the Supabase browser client.
   * Since accounts are created with email_confirm: true, there is no
   * "unconfirmed email" gate here either.
   */
  const signInWithEmail = useCallback(async (email: string, password: string) => {
    const supabase = getSupabaseBrowserClient();

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });

    if (error) {
      // Surface a user-friendly error without leaking whether the email exists.
      if (
        error.message.toLowerCase().includes('invalid') ||
        error.message.toLowerCase().includes('credentials')
      ) {
        throw new Error('Invalid email address or password.');
      }
      throw new Error(error.message);
    }
    // On success `onAuthStateChange` fires and updates `user` / `session`.
  }, []);

  /**
   * Email + password registration via the backend API.
   *
   * The backend calls Supabase Admin's createUser with email_confirm: true
   * so the account is immediately usable — no email verification step.
   *
   * On success the JWT returned by the backend is injected into the Supabase
   * browser client via setSession() so the auth state updates in place and
   * the user is logged in right away.
   */
  const registerWithEmail = useCallback(
    async (
      email: string,
      password: string,
      displayName: string,
      avatarId?: string
    ): Promise<RegisterResult> => {
      const body: Record<string, string> = { email, password, displayName };
      if (avatarId) body.avatarId = avatarId;

      const res = await fetch(`${API_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        // Surface the first validation detail or the top-level error message.
        const message =
          (data.details?.[0] as string | undefined) ??
          (data.message as string | undefined) ??
          (data.error as string | undefined) ??
          'Registration failed. Please try again.';
        throw new Error(message);
      }

      const result = data as RegisterResult;

      // If we received tokens, inject the session into the Supabase browser
      // client so the user is immediately signed in without a second step.
      if (result.accessToken && result.refreshToken) {
        try {
          const supabase = getSupabaseBrowserClient();
          await supabase.auth.setSession({
            access_token: result.accessToken,
            refresh_token: result.refreshToken,
          });
          // `onAuthStateChange` will fire and update `user` / `session`.
        } catch {
          // setSession failure is non-fatal — the user can sign in manually.
        }
      }

      return result;
    },
    []
  );

  const signOut = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    const { error } = await supabase.auth.signOut();
    if (error) {
      throw new Error(error.message);
    }
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        loading,
        signInWithGoogle,
        signInWithEmail,
        registerWithEmail,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Access the AuthContext from any Client Component.
 *
 * @example
 *   const { user, signInWithEmail, registerWithEmail, signOut } = useAuth();
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
