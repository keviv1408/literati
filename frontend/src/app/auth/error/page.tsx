'use client';

/**
 * Auth Error Page
 *
 * Shown when the OAuth callback fails. Displays a human-readable error
 * message and provides a link back to the login page to retry.
 */

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function ErrorContent() {
  const searchParams = useSearchParams();
  const reason = searchParams.get('reason') ?? 'unknown';

  const messages: Record<string, string> = {
    missing_code: 'The sign-in link is invalid or has already been used.',
    misconfigured: 'Authentication is not configured. Please contact support.',
    exchange_failed: 'Failed to complete sign-in. Please try again.',
    unknown: 'An unexpected error occurred during sign-in.',
  };

  const message = messages[reason] ?? messages.unknown;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 px-4">
      <div className="max-w-md w-full bg-slate-800/60 border border-slate-700/50 rounded-2xl p-8 text-center space-y-6">
        <div className="text-5xl" aria-hidden="true">
          ⚠️
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-white">Sign-in Failed</h1>
          <p className="text-slate-400 text-sm">{message}</p>
          {process.env.NODE_ENV === 'development' && (
            <p className="text-slate-500 text-xs font-mono mt-2">
              reason: {reason}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-3">
          <a
            href="/auth/login"
            className="
              py-3 px-6 rounded-xl font-semibold text-sm
              bg-emerald-600 hover:bg-emerald-500
              text-white shadow-lg
              transition-colors duration-150
              focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-slate-800
            "
          >
            Try Again
          </a>
          <a
            href="/"
            className="
              py-3 px-6 rounded-xl font-semibold text-sm
              text-slate-400 hover:text-white
              transition-colors duration-150
              focus:outline-none focus:underline
            "
          >
            Back to Home
          </a>
        </div>
      </div>
    </div>
  );
}

export default function AuthErrorPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-400">
          Loading…
        </div>
      }
    >
      <ErrorContent />
    </Suspense>
  );
}
