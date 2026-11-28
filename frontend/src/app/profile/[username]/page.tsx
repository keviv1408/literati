'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ProfileContent, LoadingState } from '@/components/ProfileContent';
import BackToHomeButton from '@/components/BackToHomeButton';

interface PageProps {
  params: Promise<{ username: string }>;
}

export default function ProfilePage({ params }: PageProps) {
  const router = useRouter();
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    params.then((resolved) => {
      if (cancelled) return;
      setUsername(resolved.username);
    });

    return () => {
      cancelled = true;
    };
  }, [params]);

  return (
    <div
      data-testid="profile-page"
      className="min-h-screen bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 px-4 py-10"
    >
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <BackToHomeButton onClick={() => router.push('/')} className="self-start" />

        {username ? <ProfileContent key={username} username={username} /> : <LoadingState />}
      </main>
    </div>
  );
}
