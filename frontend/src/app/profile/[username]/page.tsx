'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getProfileByUsername, type PublicProfile, ApiError } from '@/lib/api';

interface Props {
  params: Promise<{ username: string }>;
}

export default function ProfilePage({ params }: Props) {
  const router = useRouter();
  const { username } = use(params);

  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!username) return;
    getProfileByUsername(username)
      .then((res) => setProfile(res.profile))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
        } else {
          setError(
            err instanceof ApiError ? err.message : 'Error loading profile. Please try again.'
          );
        }
      })
      .finally(() => setLoading(false));
  }, [username]);

  return (
    <div
      data-testid="profile-page"
      className="flex min-h-screen flex-col items-center bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 px-4 py-12"
    >
      {/* Background decorative suits */}
      <div
        className="pointer-events-none fixed inset-0 overflow-hidden opacity-5 select-none"
        aria-hidden="true"
      >
        <span className="absolute text-[30rem] -top-24 -left-24 text-white">♠</span>
        <span className="absolute text-[20rem] bottom-0 right-0 text-white">♦</span>
      </div>

      <main className="relative z-10 w-full max-w-lg flex flex-col gap-8">
        {/* Back button */}
        <button
          onClick={() => router.push('/')}
          className="self-start text-sm text-slate-400 hover:text-emerald-400 transition-colors"
        >
          ← Back to Home
        </button>

        {/* Loading */}
        {loading && (
          <div className="flex justify-center py-16">
            <div
              className="w-12 h-12 border-4 border-emerald-600 border-t-transparent rounded-full animate-spin"
              role="status"
              aria-label="Loading profile"
            />
          </div>
        )}

        {/* Not Found */}
        {!loading && notFound && (
          <div className="text-center py-16 space-y-2">
            <p className="text-2xl font-bold text-white">Profile Not Found</p>
            <p className="text-slate-400 text-sm">
              No player with the name &ldquo;{username}&rdquo; exists or has no public stats yet.
            </p>
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div
            className="bg-red-900/30 border border-red-700/50 rounded-xl px-4 py-3 text-red-300 text-sm text-center"
            role="alert"
          >
            {error}
          </div>
        )}

        {/* Profile */}
        {!loading && profile && (
          <div className="flex flex-col items-center gap-8">
            {/* Avatar + name */}
            <div className="flex flex-col items-center gap-3">
              {profile.avatarId ? (
                <img
                  src={profile.avatarId}
                  alt={profile.displayName}
                  className="w-20 h-20 rounded-full"
                />
              ) : (
                <div className="w-20 h-20 rounded-full bg-emerald-700/60 flex items-center justify-center text-emerald-200 text-2xl font-bold">
                  {profile.displayName.slice(0, 2).toUpperCase()}
                </div>
              )}
              <h1 className="text-3xl font-black text-white tracking-tight">
                {profile.displayName}
              </h1>
            </div>

            {/* Stats grid */}
            <div className="w-full grid grid-cols-2 gap-3">
              <StatCard label="Games Completed" value={profile.gamesCompleted} />
              <StatCard
                label="Win Rate"
                value={`${(profile.winRate * 100).toFixed(1)}%`}
                highlight
              />
              <StatCard label="Wins" value={profile.wins} positive />
              <StatCard label="Losses" value={profile.losses} negative />
              <StatCard
                label="Total Declarations"
                value={profile.declarationsAttempted}
              />
              <StatCard
                label="Declaration Success Rate"
                value={
                  profile.declarationsAttempted > 0
                    ? `${Math.round(
                        (profile.declarationsCorrect / profile.declarationsAttempted) * 100
                      )}%`
                    : '—'
                }
                highlight
              />
              <StatCard
                label="Declarations Correct"
                value={profile.declarationsCorrect}
                positive
              />
              <StatCard
                label="Declarations Incorrect"
                value={profile.declarationsIncorrect}
                negative
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function StatCard({
  label,
  value,
  highlight,
  positive,
  negative,
}: {
  label: string;
  value: string | number;
  highlight?: boolean;
  positive?: boolean;
  negative?: boolean;
}) {
  const valueClass = highlight
    ? 'text-emerald-400'
    : positive
    ? 'text-emerald-300'
    : negative
    ? 'text-red-400'
    : 'text-white';

  return (
    <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl px-4 py-4 flex flex-col gap-1">
      <span className="text-slate-400 text-xs uppercase tracking-wider">{label}</span>
      <span className={`text-2xl font-bold ${valueClass}`}>{value}</span>
    </div>
  );
}
