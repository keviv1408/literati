'use client';

/**
 * Registration Page
 *
 * Allows new users to create a Literati account with:
 *   1. Email + password (primary method)
 *   2. Google OAuth (delegates to the login page)
 *
 * Key guarantee (Sub-AC 3):
 *   - The backend creates users with email_confirm: true, so newly registered
 *     accounts can join or create a game IMMEDIATELY — no email verification
 *     gate.
 *   - A fresh user_stats row (wins, losses, etc.) is created atomically by
 *     the on_auth_user_created database trigger the moment the account exists.
 *
 * After successful registration the user is signed in automatically and
 * redirected to the home page (or the `next` query-param path).
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import {
  validateDisplayName,
  DISPLAY_NAME_MIN_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
} from '@/types/user';

/** Valid avatar IDs — keep in sync with backend VALID_AVATAR_IDS */
const AVATAR_IDS = Array.from({ length: 12 }, (_, i) => `avatar-${i + 1}`);
const PASSWORD_MIN_LENGTH = 8;

// ---------------------------------------------------------------------------
// Validation helpers (client-side only; server is always authoritative)
// ---------------------------------------------------------------------------

function validateEmail(email: string): string | null {
  if (!email.trim()) return 'Email is required.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
    return 'Please enter a valid email address.';
  return null;
}

function validatePassword(pw: string): string | null {
  if (!pw) return 'Password is required.';
  if (pw.length < PASSWORD_MIN_LENGTH)
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (!/[a-zA-Z]/.test(pw)) return 'Password must contain at least one letter.';
  if (!/[0-9]/.test(pw)) return 'Password must contain at least one digit.';
  return null;
}

function validateConfirmPassword(pw: string, confirm: string): string | null {
  if (!confirm) return 'Please confirm your password.';
  if (pw !== confirm) return 'Passwords do not match.';
  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RegisterPage() {
  const router = useRouter();
  const { registerWithEmail, signInWithGoogle } = useAuth();

  // Form state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [selectedAvatar, setSelectedAvatar] = useState('avatar-1');

  // UI state
  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // ── Validation ─────────────────────────────────────────────────────────────

  function validateForm(): boolean {
    const errors: Record<string, string> = {};

    const emailErr = validateEmail(email);
    if (emailErr) errors.email = emailErr;

    const pwErr = validatePassword(password);
    if (pwErr) errors.password = pwErr;

    const confirmErr = validateConfirmPassword(password, confirmPassword);
    if (confirmErr) errors.confirmPassword = confirmErr;

    const nameErr = validateDisplayName(displayName);
    if (nameErr) errors.displayName = nameErr;

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  // ── Submit — email + password registration ─────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!validateForm()) return;

    setSubmitting(true);

    try {
      const result = await registerWithEmail(
        email.trim(),
        password,
        displayName.trim(),
        selectedAvatar
      );

      if (result.accessToken) {
        // Account created and auto sign-in succeeded.
        // The AuthContext already updated user/session via onAuthStateChange.
        router.push('/');
      } else {
        // Account was created but auto sign-in failed — redirect to login.
        router.push('/auth/login?registered=1');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Registration failed.';
      // Surface duplicate-email error with a link to the login page.
      if (msg.toLowerCase().includes('already')) {
        setError(
          'An account with this email already exists. ' +
            'Try signing in instead.'
        );
      } else {
        setError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  }

  // ── Google OAuth sign-up (delegates to the existing OAuth flow) ────────────

  async function handleGoogleSignUp() {
    setGoogleLoading(true);
    setError(null);
    try {
      await signInWithGoogle('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-up failed.');
      setGoogleLoading(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 px-4 py-8">
      {/* Background suits */}
      <div
        className="pointer-events-none fixed inset-0 overflow-hidden opacity-5 select-none"
        aria-hidden="true"
      >
        <span className="absolute text-[30rem] -top-24 -left-24 text-white">♠</span>
        <span className="absolute text-[20rem] bottom-0 right-0 text-white">♦</span>
      </div>

      <div className="relative z-10 max-w-sm w-full space-y-6">
        {/* Logo */}
        <div className="text-center space-y-1">
          <a
            href="/"
            className="inline-block text-4xl font-black text-white tracking-tight hover:text-emerald-300 transition-colors"
          >
            Literati
          </a>
          <p className="text-slate-400 text-sm">
            Create an account to save stats and play ranked games.
          </p>
        </div>

        {/* Card */}
        <div className="bg-slate-800/60 border border-slate-700/50 rounded-2xl p-7 space-y-5 shadow-xl">
          <h1 className="text-xl font-bold text-white text-center">Create account</h1>

          {/* Top-level error */}
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 bg-red-900/40 border border-red-700/50 rounded-lg px-4 py-3 text-sm text-red-300"
            >
              <span aria-hidden="true" className="shrink-0 mt-0.5">
                ⚠️
              </span>
              <span>{error}</span>
            </div>
          )}

          {/* Registration form */}
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            {/* Display name */}
            <Field label="Display Name" error={fieldErrors.displayName}>
              <input
                id="displayName"
                type="text"
                autoComplete="nickname"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g. Ace_Player"
                maxLength={DISPLAY_NAME_MAX_LENGTH}
                className={inputClass(!!fieldErrors.displayName)}
                aria-describedby={fieldErrors.displayName ? 'displayName-error' : undefined}
              />
              <p className="text-xs text-slate-500 mt-1">
                {DISPLAY_NAME_MIN_LENGTH}–{DISPLAY_NAME_MAX_LENGTH} characters; shown to other
                players.
              </p>
            </Field>

            {/* Email */}
            <Field label="Email" error={fieldErrors.email}>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className={inputClass(!!fieldErrors.email)}
              />
            </Field>

            {/* Password */}
            <Field label="Password" error={fieldErrors.password}>
              <input
                id="password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Minimum 8 characters"
                className={inputClass(!!fieldErrors.password)}
              />
              <p className="text-xs text-slate-500 mt-1">
                At least 8 characters, including a letter and a number.
              </p>
            </Field>

            {/* Confirm password */}
            <Field label="Confirm Password" error={fieldErrors.confirmPassword}>
              <input
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter your password"
                className={inputClass(!!fieldErrors.confirmPassword)}
              />
            </Field>

            {/* Avatar picker */}
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-2">
                Choose Avatar
              </label>
              <div
                className="grid grid-cols-6 gap-1.5"
                role="radiogroup"
                aria-label="Choose avatar"
              >
                {AVATAR_IDS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSelectedAvatar(id)}
                    className={[
                      'w-full aspect-square rounded-lg flex items-center justify-center text-lg',
                      'transition-all duration-100 focus:outline-none focus:ring-2 focus:ring-emerald-400',
                      selectedAvatar === id
                        ? 'bg-emerald-600 ring-2 ring-emerald-400 scale-105'
                        : 'bg-slate-700/60 hover:bg-slate-600/60',
                    ].join(' ')}
                    aria-pressed={selectedAvatar === id}
                    aria-label={id.replace('-', ' ')}
                    title={id}
                  >
                    {/* Emoji placeholder — real avatar images rendered once assets exist */}
                    <span aria-hidden="true">
                      {['🃏', '♠️', '♣️', '♥️', '♦️', '🎴',
                        '👑', '⚡', '🔥', '🌊', '🌙', '⭐'][
                        parseInt(id.split('-')[1]) - 1
                      ]}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={submitting || googleLoading}
              className="
                w-full py-3 px-4 rounded-xl font-semibold text-sm
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
                  Creating account…
                </span>
              ) : (
                'Create Account'
              )}
            </button>
          </form>

          {/* Divider */}
          <div className="relative flex items-center gap-3 text-slate-600 text-xs">
            <div className="flex-1 border-t border-slate-700" />
            <span>or</span>
            <div className="flex-1 border-t border-slate-700" />
          </div>

          {/* Google OAuth sign-up */}
          <button
            onClick={handleGoogleSignUp}
            disabled={googleLoading || submitting}
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
            aria-label="Sign up with Google"
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
        </div>

        {/* Sign-in link + Guest link */}
        <div className="text-center text-sm text-slate-500 space-y-2">
          <p>
            Already have an account?{' '}
            <a
              href="/auth/login"
              className="text-emerald-400 hover:text-emerald-300 font-medium transition-colors underline-offset-2 hover:underline"
            >
              Sign in
            </a>
          </p>
          <p>
            <a
              href="/"
              className="hover:text-slate-400 transition-colors"
            >
              Play as guest instead
            </a>
          </p>
        </div>

        {/* Privacy note */}
        <p className="text-center text-xs text-slate-600">
          No email verification required — you can play immediately after signing up.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  const id = label.toLowerCase().replace(/\s+/g, '-');
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-slate-300 mb-1.5">
        {label}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-red-400 mt-1">
          {error}
        </p>
      )}
    </div>
  );
}

function inputClass(hasError: boolean): string {
  return [
    'w-full px-3 py-2.5 rounded-lg text-sm text-white bg-slate-700/80',
    'placeholder-slate-500',
    'border transition-colors',
    'focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-1 focus:ring-offset-slate-800',
    hasError ? 'border-red-500' : 'border-slate-600 focus:border-emerald-500',
  ].join(' ');
}

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
