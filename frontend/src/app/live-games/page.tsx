'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useLiveGamesSocket } from '@/hooks/useLiveGamesSocket';
import type { LiveGame } from '@/lib/api';

// ── Variant labels ──────────────────────────────────────────────────────────

const VARIANT_LABELS: Record<string, string> = {
  remove_2s: 'Remove 2s',
  remove_7s: 'Remove 7s (Classic)',
  remove_8s: 'Remove 8s',
};

function variantLabel(variant: string): string {
  return VARIANT_LABELS[variant] ?? variant;
}

// ── Elapsed-time helpers ────────────────────────────────────────────────────

/**
 * Format a millisecond duration as "Xm Ys" (e.g. "12m 34s").
 * Shows "< 1m" for sub-minute durations.
 */
function formatElapsed(ms: number): string {
  if (ms < 0) return '—';
  const totalSec = Math.floor(ms / 1_000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs.toString().padStart(2, '0')}s`;
}

/**
 * Compute elapsed milliseconds for a live game.
 * Uses startedAt for in-progress games, createdAt otherwise.
 */
function computeElapsed(game: LiveGame): number {
  const base = game.startedAt ?? game.createdAt;
  return Date.now() - base;
}

// ── Score badge ─────────────────────────────────────────────────────────────

function ScoreBadge({ scores }: { scores: { team1: number; team2: number } }) {
  return (
    <div
      className="flex items-center gap-1 font-mono text-sm"
      aria-label={`Score: Team 1 has ${scores.team1}, Team 2 has ${scores.team2}`}
    >
      <span
        className={`
          px-2 py-0.5 rounded-md font-bold text-white
          ${scores.team1 > scores.team2 ? 'bg-emerald-600' : 'bg-slate-600'}
        `}
      >
        {scores.team1}
      </span>
      <span className="text-slate-400 text-xs">vs</span>
      <span
        className={`
          px-2 py-0.5 rounded-md font-bold text-white
          ${scores.team2 > scores.team1 ? 'bg-emerald-600' : 'bg-slate-600'}
        `}
      >
        {scores.team2}
      </span>
    </div>
  );
}

// ── Live timer component ─────────────────────────────────────────────────────

/**
 * Renders an auto-updating elapsed time counter for a single game.
 * Ticks once per second to keep the display live.
 */
function ElapsedTimer({ game }: { game: LiveGame }) {
  const [elapsed, setElapsed] = useState(() => computeElapsed(game));

  useEffect(() => {
    // Tick immediately, then every second
    setElapsed(computeElapsed(game));
    const id = setInterval(() => setElapsed(computeElapsed(game)), 1_000);
    return () => clearInterval(id);
  }, [game]);

  return (
    <span
      className="tabular-nums text-slate-400 text-xs"
      aria-label={`Elapsed: ${formatElapsed(elapsed)}`}
    >
      ⏱ {formatElapsed(elapsed)}
    </span>
  );
}

// ── Status badge ─────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const isActive = status === 'in_progress';
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${
        isActive ? 'bg-emerald-400 animate-pulse' : 'bg-yellow-400'
      }`}
      aria-hidden="true"
    />
  );
}

// ── Game row ─────────────────────────────────────────────────────────────────

function GameRow({ game }: { game: LiveGame }) {
  const router = useRouter();

  return (
    <li
      key={game.roomCode}
      data-testid={`live-game-row-${game.roomCode}`}
      className="
        bg-slate-800/60 border border-slate-700/50 rounded-xl
        px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3
        transition-all duration-300
      "
    >
      {/* Left: room identity */}
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <StatusDot status={game.status} />
          <span className="text-white font-bold tracking-widest text-lg">
            {game.roomCode}
          </span>
          <ElapsedTimer game={game} />
        </div>

        {/* Metadata chips */}
        <div className="flex flex-wrap gap-1.5 text-xs">
          <span className="bg-slate-700/60 rounded-full px-2 py-0.5 text-slate-300">
            {game.playerCount}-player
          </span>
          <span className="bg-slate-700/60 rounded-full px-2 py-0.5 text-slate-300">
            {variantLabel(game.cardVariant)}
          </span>
          {game.status === 'in_progress' && (
            <span className="bg-emerald-900/40 border border-emerald-700/40 rounded-full px-2 py-0.5 text-emerald-300">
              In Progress
            </span>
          )}
          {game.status === 'waiting' && (
            <span className="bg-yellow-900/40 border border-yellow-700/40 rounded-full px-2 py-0.5 text-yellow-300">
              Starting Soon
            </span>
          )}
        </div>
      </div>

      {/* Centre: live score */}
      <div className="flex-shrink-0">
        <ScoreBadge scores={game.scores} />
      </div>

      {/* Right: spectate button */}
      <div className="flex-shrink-0">
        <button
          onClick={() => router.push(`/game/${game.roomCode}`)}
          className="
            w-full sm:w-auto py-2 px-5 rounded-xl font-semibold text-sm
            bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700
            text-white shadow-lg shadow-emerald-900/40
            transition-all duration-150 active:scale-[0.97]
            focus:outline-none focus:ring-2 focus:ring-emerald-400
            focus:ring-offset-2 focus:ring-offset-slate-950
          "
          aria-label={`Spectate game ${game.roomCode}`}
        >
          Spectate
        </button>
      </div>
    </li>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function LiveGamesPage() {
  const router = useRouter();
  const { games, isConnected, isFallback, error } = useLiveGamesSocket();

  return (
    <div
      data-testid="live-games-page"
      className="flex min-h-screen flex-col items-center bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 px-4 py-12"
    >
      {/* Background decorative suits */}
      <div
        className="pointer-events-none fixed inset-0 overflow-hidden opacity-5 select-none"
        aria-hidden="true"
      >
        <span className="absolute text-[30rem] -top-24 -left-24 text-white">♣</span>
        <span className="absolute text-[20rem] bottom-0 right-0 text-white">♥</span>
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
          <h1 className="text-4xl font-black text-white tracking-tight">Live Games</h1>
          <div className="flex items-center justify-center gap-2 text-sm">
            {isConnected ? (
              <span className="flex items-center gap-1.5 text-emerald-400">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
                Live
              </span>
            ) : isFallback ? (
              <span className="text-yellow-400">Reconnecting… (refreshing every 15s)</span>
            ) : (
              <span className="text-slate-400">Connecting…</span>
            )}
          </div>
        </div>

        {/* Error banner (non-fatal) */}
        {error && !isConnected && (
          <div
            className="bg-yellow-900/30 border border-yellow-700/50 rounded-xl px-4 py-3 text-yellow-300 text-sm text-center"
            role="status"
          >
            {error}
          </div>
        )}

        {/* Empty state */}
        {games.length === 0 && (
          <p
            className="text-slate-400 text-center py-16"
            data-testid="live-games-empty"
          >
            No active games right now.
          </p>
        )}

        {/* Game list */}
        {games.length > 0 && (
          <ul
            className="flex flex-col gap-3"
            aria-label={`${games.length} active game${games.length === 1 ? '' : 's'}`}
          >
            {games.map((game) => (
              <GameRow key={game.roomCode} game={game} />
            ))}
          </ul>
        )}

        {/* Footer: game count */}
        {games.length > 0 && (
          <p className="text-center text-xs text-slate-500">
            {games.length} active game{games.length === 1 ? '' : 's'}
          </p>
        )}
      </main>
    </div>
  );
}
