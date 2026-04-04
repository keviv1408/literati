'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Avatar from '@/components/Avatar';
import {
  ApiError,
  getProfileByUsername,
  type PublicProfile,
} from '@/lib/api';

interface PageProps {
  params: Promise<{ username: string }>;
}

function formatPercent(value: number): string {
  const percent = value * 100;
  if (Number.isInteger(percent)) return `${percent}%`;
  return `${percent.toFixed(1).replace(/\.0$/, '')}%`;
}

function formatDeclarationSuccess(profile: PublicProfile): string {
  if (profile.declarationsAttempted === 0) return '—';
  return formatPercent(
    profile.declarationsCorrect / profile.declarationsAttempted,
  );
}

function StatCard({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-2xl border border-slate-700/60 bg-slate-900/70 px-4 py-4 shadow-lg shadow-slate-950/40">
      <div className="text-2xl font-black text-white">{value}</div>
      <div className="mt-1 text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
        {label}
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div
      role="status"
      aria-label="Loading profile"
      className="flex min-h-[18rem] flex-col items-center justify-center gap-3 rounded-3xl border border-slate-700/60 bg-slate-900/60 text-slate-300"
    >
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-emerald-400/25 border-t-emerald-400" />
      <p className="text-sm font-medium">Loading profile…</p>
    </div>
  );
}

function ProfileContent({ username }: { username: string }) {
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    getProfileByUsername(username)
      .then((response) => {
        if (cancelled) return;
        setProfile(response.profile);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
          setLoading(false);
          return;
        }

        if (err instanceof ApiError) {
          setError(err.message);
        } else {
          setError('Please try again in a moment.');
        }
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [username]);

  const stats = profile
    ? [
        { label: 'Games Completed', value: profile.gamesCompleted },
        { label: 'Win Rate', value: formatPercent(profile.winRate) },
        { label: 'Wins', value: profile.wins },
        { label: 'Losses', value: profile.losses },
        { label: 'Total Declarations', value: profile.declarationsAttempted },
        { label: 'Declaration Success Rate', value: formatDeclarationSuccess(profile) },
        { label: 'Declarations Correct', value: profile.declarationsCorrect },
        { label: 'Declarations Incorrect', value: profile.declarationsIncorrect },
      ]
    : [];

  if (loading) {
    return <LoadingState />;
  }

  if (notFound) {
    return (
      <section className="rounded-3xl border border-slate-700/60 bg-slate-900/70 px-6 py-12 text-center">
        <h1 className="text-3xl font-black text-white">Profile Not Found</h1>
        <p className="mt-3 text-sm text-slate-300">
          We couldn&apos;t find a public profile for{' '}
          <span className="font-semibold text-emerald-300">{username}</span>.
        </p>
      </section>
    );
  }

  if (error) {
    return (
      <section
        role="alert"
        className="rounded-3xl border border-rose-800/60 bg-rose-950/40 px-6 py-8 text-center"
      >
        <h1 className="text-2xl font-black text-white">Error loading profile</h1>
        <p className="mt-3 text-sm text-rose-200">{error}</p>
      </section>
    );
  }

  if (!profile) {
    return <LoadingState />;
  }

  return (
    <>
      <section className="rounded-3xl border border-slate-700/60 bg-slate-900/70 px-6 py-8 shadow-2xl shadow-slate-950/40">
        <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:text-left">
          <Avatar
            displayName={profile.displayName}
            imageUrl={profile.avatarId ?? undefined}
            size="xl"
          />
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-emerald-300">
              Public Profile
            </p>
            <h1 className="text-4xl font-black tracking-tight text-white">
              {profile.displayName}
            </h1>
            <p className="text-sm text-slate-400">
              Lifetime Literature stats and declaration history.
            </p>
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
          <StatCard
            key={stat.label}
            label={stat.label}
            value={stat.value}
          />
        ))}
      </section>
    </>
  );
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
        <button
          type="button"
          onClick={() => router.push('/')}
          className="self-start rounded-full border border-slate-700/60 bg-slate-900/60 px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:border-emerald-500 hover:text-white"
        >
          ← Back to Home
        </button>

        {username ? <ProfileContent key={username} username={username} /> : <LoadingState />}
      </main>
    </div>
  );
}
