'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  getLeaderboard,
  type LeaderboardEntry,
  ApiError,
} from '@/lib/api';

export default function LeaderboardPage() {
  const router = useRouter();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getLeaderboard()
      .then((res) => setEntries(res.leaderboard))
      .catch((err) => {
        setError(
          err instanceof ApiError
            ? err.message
            : 'Failed to load leaderboard. Please try again.'
        );
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div
      data-testid="leaderboard-page"
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

      <main className="relative z-10 w-full max-w-2xl flex flex-col gap-8">
        {/* Back button */}
        <button
          onClick={() => router.push('/')}
          className="self-start text-sm text-slate-400 hover:text-emerald-400 transition-colors"
        >
          ← Back to Home
        </button>

        {/* Header */}
        <div className="space-y-1 text-center">
          <h1 className="text-4xl font-black text-white tracking-tight">Leaderboard</h1>
          <p className="text-emerald-300 text-sm">
            Top players by wins (min. 5 completed games)
          </p>
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex justify-center py-16">
            <div
              className="w-12 h-12 border-4 border-emerald-600 border-t-transparent rounded-full animate-spin"
              role="status"
              aria-label="Loading leaderboard"
            />
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

        {/* Empty */}
        {!loading && !error && entries.length === 0 && (
          <p className="text-slate-400 text-center py-16">No players qualify yet.</p>
        )}

        {/* Table */}
        {!loading && !error && entries.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-slate-700/50">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-800/60 text-slate-400 text-xs uppercase tracking-wider">
                  <th className="px-4 py-3 text-left">Rank</th>
                  <th className="px-4 py-3 text-left">Player</th>
                  <th className="px-4 py-3 text-right">W / L</th>
                  <th className="px-4 py-3 text-right">Win Rate</th>
                  <th className="px-4 py-3 text-right">Games</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr
                    key={entry.userId}
                    className="border-t border-slate-700/40 hover:bg-slate-800/30 transition-colors cursor-pointer"
                    onClick={() => router.push(`/profile/${entry.userId}`)}
                    title={`View ${entry.displayName}'s profile`}
                  >
                    {/* Rank */}
                    <td className="px-4 py-3 font-bold text-white">
                      {entry.rank === 1 ? (
                        <span>🏆 #1</span>
                      ) : (
                        <span className="text-slate-300">#{entry.rank}</span>
                      )}
                    </td>

                    {/* Player */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {entry.avatarId ? (
                          <img
                            src={entry.avatarId}
                            alt={entry.displayName}
                            className="w-8 h-8 rounded-full"
                          />
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-emerald-700/60 flex items-center justify-center text-emerald-200 text-xs font-bold flex-shrink-0">
                            {entry.displayName.slice(0, 2).toUpperCase()}
                          </div>
                        )}
                        <span className="text-white font-medium">{entry.displayName}</span>
                      </div>
                    </td>

                    {/* W / L */}
                    <td className="px-4 py-3 text-right">
                      <span className="text-emerald-400 font-semibold">{entry.wins}</span>
                      <span className="text-slate-500 mx-1">/</span>
                      <span className="text-red-400">{entry.losses}</span>
                    </td>

                    {/* Win Rate */}
                    <td className="px-4 py-3 text-right text-slate-200">
                      {(entry.winRate * 100).toFixed(1)}%
                    </td>

                    {/* Games */}
                    <td className="px-4 py-3 text-right text-slate-400">
                      {entry.gamesCompleted}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
