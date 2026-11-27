'use client';

import Link from 'next/link';
import { useAccount } from '@/contexts/AccountContext';
import { LoadingState, ProfileContent } from '@/components/ProfileContent';
import AccountControls from '@/components/AccountControls';

export default function MyStatsPage() {
  const { session, loading } = useAccount();
  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-4 py-10 text-white">
      <Link className="self-start text-sm text-emerald-200 underline" href="/">Back to home</Link>
      {loading ? <LoadingState /> : session ? (
        <ProfileContent key={session.user.id} userId={session.user.id} />
      ) : (
        <section className="space-y-4 text-center">
          <h1 className="text-2xl font-bold">Sign in to see your stats</h1>
          <AccountControls />
        </section>
      )}
    </main>
  );
}
