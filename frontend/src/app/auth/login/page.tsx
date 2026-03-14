'use client';

/**
 * Login Page
 *
 * Supports two sign-in methods:
 *   1. Email + password  (via Supabase browser client signInWithPassword)
 *   2. Google OAuth      (via Supabase signInWithOAuth → /auth/callback)
 *
 * Since all accounts are created with email_confirm: true (Sub-AC 3 guarantee),
 * there is no "please verify your email" block on either sign-in path.
 *
 * After a successful email/password sign-in the user is redirected to the
 * `next` search-param path (default: '/').
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';

interface LoginPageProps {
  searchParams?: Promise<{ next?: string; error?: string; registered?: string }>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function LoginPage({ searchParams: _searchParams }: LoginPageProps) {
  const router = useRouter();
  const { signInWithEmail, signInWithGoogle } = useAuth();

  // Email/password form state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  // UI state
  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage] = useState<string | null>(
    // Show a success message if redirected from the registration page.
    typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('registered') === '1'
      ? 'Account created! Sign in to start playing.'
      : null
  );

  // ── Email/password sign-in ─────────────────────────────────────────────────

  function validateFields(): boolean {
    let valid = true;
    setEmailError(null);
    setPasswordError(null);

    if (!email.trim()) {
      setEmailError('Email is required.');
      valid = false;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setEmailError('Please enter a valid email address.');
      valid = false;
    }

    if (!password) {
      setPasswordError('Password is required.');
      valid = false;
    }

    return valid;
  }

  async function handleEmailSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!validateFields()) return;

    setSubmitting(true);
    try {
      await signInWithEmail(email.trim(), password);
      // `onAuthStateChange` fires; navigate to home (or `next` param).
      const next =
        typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search).get('next') ?? '/'
          : '/';
      router.push(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Google OAuth ───────────────────────────────────────────────────────────

  async function handleGoogleSignIn() {
    setGoogleLoading(true);
    setError(null);
    try {
      const next =
        typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search).get('next') ?? '/'
          : '/';
      await signInWithGoogle(next);
      // On success the browser is redirected — no need to unset googleLoading.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed.');
      setGoogleLoading(false);
    }
  }

  const busy = submitting || googleLoading;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 px-4">
      {/* Background suits */}
      <div
        className="pointer-events-none fixed inset-0 overflow-hidden opacity-5 select-none"
        aria-hidden="true"
      >
        <span className="absolute text-[30rem] -top-24 -left-24 text-white">♠</span>
        <span className="absolute text-[20rem] bottom-0 right-0 text-white">♦</span>
      </div>

      <div className="relative z-10 max-w-sm w-full space-y-6">
        {/* Logo / Title */}
        <div className="text-center space-y-1">
          <a
            href="/"
            className="inline-block text-4xl font-black text-white tracking-tight hover:text-emerald-300 transition-colors"
          >
            Literati
          </a>
          <p className="text-slate-400 text-sm">Sign in to save your stats and play ranked games.</p>
        </div>

        {/* Card */}
        <div className="bg-slate-800/60 border border-slate-700/50 rounded-2xl p-8 space-y-5 shadow-xl">
          <h1 className="text-xl font-bold text-white text-center">Welcome back</h1>

          {/* Success message (e.g. redirected from registration) */}
          {successMessage && (
            <div
              role="status"
              className="flex items-start gap-2 bg-emerald-900/40 border border-emerald-700/50 rounded-lg px-4 py-3 text-sm text-emerald-300"
            >
              <span aria-hidden="true" className="shrink-0 mt-0.5">✅</span>
              <span>{successMessage}</span>
            </div>
          )}

          {/* Top-level error */}
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 bg-red-900/40 border border-red-700/50 rounded-lg px-4 py-3 text-sm text-red-300"
            >
              <span aria-hidden="true" className="shrink-0 mt-0.5">⚠️</span>
              <span>{error}</span>
            </div>
          )}

          {/* ── Email + Password form ─────────────────────────────────────── */}
          <form onSubmit={handleEmailSignIn} noValidate className="space-y-3">
            {/* Email field */}
            <div>
              <label
                htmlFor="email"
                className="block text-xs font-medium text-slate-300 mb-1.5"
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                disabled={busy}
                className={[
                  'w-full px-3 py-2.5 rounded-lg text-sm text-white bg-slate-700/80',
                  'placeholder-slate-500 border transition-colors',
                  'focus:outline-none focus:ring-2 focus:ring-emerald-400',
                  emailError
                    ? 'border-red-500'
                    : 'border-slate-600 focus:border-emerald-500',
                  busy ? 'opacity-60 cursor-not-allowed' : '',
                ].join(' ')}
              />
              {emailError && (
                <p role="alert" className="text-xs text-red-400 mt-1">
                  {emailError}
                </p>
              )}
            </div>

            {/* Password field */}
            <div>
              <label
                htmlFor="password"
                className="block text-xs font-medium text-slate-300 mb-1.5"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password"
                disabled={busy}
                className={[
                  'w-full px-3 py-2.5 rounded-lg text-sm text-white bg-slate-700/80',
                  'placeholder-slate-500 border transition-colors',
                  'focus:outline-none focus:ring-2 focus:ring-emerald-400',
                  passwordError
                    ? 'border-red-500'
                    : 'border-slate-600 focus:border-emerald-500',
                  busy ? 'opacity-60 cursor-not-allowed' : '',
                ].join(' ')}
              />
              {passwordError && (
                <p role="alert" className="text-xs text-red-400 mt-1">
                  {passwordError}
                </p>
              )}
            </div>

            {/* Sign-in submit button */}
            <button
              type="submit"
              disabled={busy}
              className="
                w-full py-3 px-4 rounded-xl font-semibold text-sm mt-1
                bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700
                text-white shadow-lg shadow-emerald-900/50
                transition-all duration-150 active:scale-[0.98]
                focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-slate-800
                disabled:opacity-60 disabled:cursor-not-allowed disabled:active:scale-100
              "
            >
              {submitting ? (
                <span className="flex items-center justify-center gap-2">
                  <Spinner />
                  Signing in…
                </span>
              ) : (
                'Sign In'
              )}
            </button>
          </form>

          {/* Divider */}
          <div className="relative flex items-center gap-3 text-slate-600 text-xs">
            <div className="flex-1 border-t border-slate-700" />
            <span>or</span>
            <div className="flex-1 border-t border-slate-700" />
          </div>

          {/* ── Google OAuth button ───────────────────────────────────────── */}
          <button
            onClick={handleGoogleSignIn}
            disabled={busy}
            className="
              w-full flex items-center justify-center gap-3
              py-3 px-4 rounded-xl font-semibold text-sm
              bg-white hover:bg-gray-50 active:bg-gray-100
              text-gray-700
              shadow-sm border border-gray-200
              transition-all duration-150 active:scale-[0.98]
              focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-slate-800
              disabled:opacity-60 disabled:cursor-not-allowed disabled:active:scale-100
            "
            aria-label="Sign in with Google"
          >
            {googleLoading ? (
              <>
                <Spinner className="text-gray-400" />
                <span>Redirecting to Google…</span>
              </>
            ) : (
              <>
                <GoogleLogo />
                <span>Continue with Google</span>
              </>
            )}
          </button>

          {/* Divider */}
          <div className="relative flex items-center gap-3 text-slate-600 text-xs">
            <div className="flex-1 border-t border-slate-700" />
            <span>or</span>
            <div className="flex-1 border-t border-slate-700" />
          </div>

          {/* Guest play */}
          <a
            href="/"
            className="
              w-full flex items-center justify-center gap-2
              py-3 px-4 rounded-xl font-semibold text-sm
              border border-emerald-700 text-emerald-200
              hover:bg-emerald-900/40 hover:border-emerald-500 hover:text-white
              transition-all duration-150 active:scale-[0.98]
              focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-slate-800
            "
          >
            👤 Play as Guest
          </a>
        </div>

        {/* Registration link */}
        <p className="text-center text-sm text-slate-500">
          Don&apos;t have an account?{' '}
          <a
            href="/auth/register"
            className="text-emerald-400 hover:text-emerald-300 font-medium transition-colors underline-offset-2 hover:underline"
          >
            Create one free
          </a>
          {' '}— no email verification required.
        </p>

        {/* Footer */}
        <p className="text-center text-xs text-slate-600">
          By signing in you agree to our{' '}
          <a href="/terms" className="underline hover:text-slate-400 transition-colors">
            Terms of Service
          </a>{' '}
          and{' '}
          <a href="/privacy" className="underline hover:text-slate-400 transition-colors">
            Privacy Policy
          </a>
          .
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Spinner({ className = 'text-white' }: { className?: string }) {
  return (
    <svg
      className={`animate-spin h-4 w-4 shrink-0 ${className}`}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

/** Google multi-colour 'G' logo as an inline SVG. */
function GoogleLogo() {
  return (
    <svg
      className="h-5 w-5 shrink-0"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}
