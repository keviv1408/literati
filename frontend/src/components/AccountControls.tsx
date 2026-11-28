'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAccount } from '@/contexts/AccountContext';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';

export default function AccountControls({ signInOnly = false, onSignInFailure }: { signInOnly?: boolean; onSignInFailure?: () => void }) {
  const { session, loading, displayName } = useAccount();
  const signedIn = !!session && !signInOnly;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('signin') === 'failed') {
      setMessage('Google sign-in didn’t finish. You can try again.');
      onSignInFailure?.();
      url.searchParams.delete('signin');
      window.history.replaceState(window.history.state, '', url);
    }
  }, [onSignInFailure]);

  async function _changeAccount() {
    setBusy(true);
    setMessage('');
    try {
      const { auth } = getSupabaseBrowserClient();
      const { error } = signedIn
        ? await auth.signOut({ scope: 'local' })
        : await auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: new URL('/auth/callback', window.location.origin).href },
          });
      if (error) throw error;
    } catch {
      setMessage(signedIn ? 'Couldn’t sign out. Try again.' : 'Couldn’t start Google sign-in. Try again.');
      setBusy(false);
    }
  }

  return (
    <section aria-label="Player account" className="space-y-2 text-sm text-emerald-100">
      {signedIn && <p>Signed in as {displayName}</p>}
      <div className="flex items-center justify-center gap-4">
        {signedIn && <Link className="font-semibold underline underline-offset-4" href="/stats">My stats</Link>}
        <button type="button" onClick={_changeAccount} disabled={busy || loading}
          className="rounded-lg border border-emerald-700 px-4 py-2 hover:bg-emerald-900 disabled:opacity-60">
          {signedIn ? 'Sign out' : 'Sign in with Google'}
        </button>
      </div>
      {message && <p role="alert">{message}</p>}
    </section>
  );
}
