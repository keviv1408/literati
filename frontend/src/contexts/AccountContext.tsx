'use client';

import { createContext, Fragment, useContext, useEffect, useState } from 'react';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import { isAndroidBuild } from '@/lib/appPaths';

const AccountContext = createContext<{ session: Session | null; loading: boolean }>({
  session: null, loading: false,
});

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(!isAndroidBuild());

  useEffect(() => {
    if (isAndroidBuild()) return;
    const { data } = getSupabaseBrowserClient().auth.onAuthStateChange((_event: AuthChangeEvent, next: Session | null) => {
      setSession(next);
      setLoading(false);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  return (
    <AccountContext.Provider value={{ session, loading }}>
      <Fragment key={session?.user.id ?? 'guest'}>{children}</Fragment>
    </AccountContext.Provider>
  );
}

export function useAccount() {
  const account = useContext(AccountContext);
  const user = account.session?.user;
  const metadata = user?.user_metadata;
  const name = [metadata?.display_name, metadata?.full_name, metadata?.name, user?.email?.split('@')[0]]
    .find((value): value is string => typeof value === 'string' && !!value.trim());
  const displayName = user ? Array.from(name?.trim() || 'Player').slice(0, 20).join('') : null;
  return { ...account, displayName };
}
