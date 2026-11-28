'use client';

import CardFan from '@/components/CardFan';
import { useEffect, useState } from 'react';
import Avatar from '@/components/Avatar';
import { getMyStats } from '@/lib/supabase/myStats';
import {
  ApiError,
  getProfileByUsername,
  type PublicProfile,
} from '@/lib/api';

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

export function LoadingState() {
  return (
    <div
      role="status"
      aria-label="Loading profile"
      className="flex min-h-[18rem] flex-col items-center justify-center gap-3 rounded-3xl border border-slate-700/60 bg-slate-900/60 text-slate-300"
    >
      <CardFan />
      <p className="text-sm font-medium">Loading profile…</p>
    </div>
  );
}

export function ProfileContent({ username, userId }: { username?: string; userId?: string }) {
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const request = userId ? getMyStats(userId) : getProfileByUsername(username ?? '');
    request
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
  }, [username, userId]);

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
          We couldn&apos;t find a profile {username && 'for '}
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
            avatarId={profile.avatarId}
            size="xl"
          />
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-emerald-300">
              {userId ? 'My stats' : 'Public Profile'}
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
