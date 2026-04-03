'use client';

/**
 * Matchmaking waiting room.
 *
 * Flow:
 *   1. Guest ensures they have a display name (name modal if needed).
 *   2. Select player count (6 or 8) and card-removal variant.
 *   3. Click "Find Game":
 *      a. Backend bearer token is fetched for the guest name.
 *      b. WebSocket connects with autoJoinFilter set.
 *      c. Server authenticates → hook auto-sends 'join-queue'.
 *   4. Page shows "Searching…" with live queue counter.
 *   5. 'match-found' received → redirect to /room/{roomCode}.
 *   6. "Cancel" button sends 'leave-queue' and resets to filter form.
 */

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useGuestSession } from '@/hooks/useGuestSession';
import {
  useMatchmakingSocket,
  type MatchmakingFilter,
} from '@/hooks/useMatchmakingSocket';
import { getGuestBearerToken, getLiveGames, getMatchmakingQueues } from '@/lib/api';
import { VARIANT_OPTIONS } from '@/types/room';
import type { CardRemovalVariant } from '@/types/room';

const ACTIVITY_REFRESH_MS = 15_000;

interface MatchmakingActivitySummary {
  totalOnline: number;
  totalWaiting: number;
  livePlayers: number;
  activeGames: number;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MatchmakingPage() {
  const router = useRouter();
  const { guestSession, ensureGuestName } = useGuestSession();

  // ── Filter selection ────────────────────────────────────────────────────────
  const [playerCount, setPlayerCount] = useState<6 | 8>(6);
  const [cardVariant, setCardVariant] = useState<CardRemovalVariant>('remove_7s');

  // ── Auth / connection state ─────────────────────────────────────────────────
  const [bearerToken, setBearerToken] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [autoJoinFilter, setAutoJoinFilter] = useState<MatchmakingFilter | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [activitySummary, setActivitySummary] = useState<MatchmakingActivitySummary | null>(null);

  // ── WebSocket matchmaking hook ───────────────────────────────────────────────
  const { status, queueSize, leaveQueue } = useMatchmakingSocket({
    sessionId,
    bearerToken,
    autoJoinFilter,
    onMatchFound: useCallback(
      (roomCode: string) => {
        router.push(`/room/${roomCode}`);
      },
      [router]
    ),
  });

  useEffect(() => {
    let cancelled = false;

    async function loadActivitySummary() {
      try {
        const [queuesRes, liveGamesRes] = await Promise.all([
          getMatchmakingQueues(),
          getLiveGames(),
        ]);

        if (cancelled) return;

        const livePlayers = liveGamesRes.games.reduce(
          (sum, game) => sum + game.currentPlayers,
          0
        );

        setActivitySummary({
          totalOnline: queuesRes.totalWaiting + livePlayers,
          totalWaiting: queuesRes.totalWaiting,
          livePlayers,
          activeGames: liveGamesRes.total,
        });
      } catch {
        if (!cancelled) {
          setActivitySummary(null);
        }
      }
    }

    loadActivitySummary();
    const intervalId = window.setInterval(loadActivitySummary, ACTIVITY_REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  // ── "Find Game" handler ─────────────────────────────────────────────────────

  async function handleFindGame() {
    setFetchError(null);
    setIsFetching(true);

    try {
      // Ensure the guest has a display name (opens modal if not set)
      const session = await ensureGuestName();
      if (!session) {
        setIsFetching(false);
        return; // user dismissed the name modal
      }

      // Obtain backend bearer token (uses cached token if still valid)
      const token = await getGuestBearerToken(session.displayName, session.sessionId);

      // Setting bearerToken + autoJoinFilter triggers the hook to:
      //   1. Open a WebSocket to /ws?token=<token>
      //   2. On server 'connected' event, auto-send 'join-queue'
      setSessionId(session.sessionId);
      setBearerToken(token);
      setAutoJoinFilter({ playerCount, cardRemovalVariant: cardVariant });
    } catch (err) {
      setFetchError(
        err instanceof Error
          ? err.message
          : 'Failed to connect to matchmaking. Please try again.'
      );
    } finally {
      setIsFetching(false);
    }
  }

  // ── "Cancel" handler ─────────────────────────────────────────────────────────

  function handleCancel() {
    // Ask the server to remove us from the queue so others see the updated count
    leaveQueue();
    // Tear down the WS connection by nulling the auth state
    setBearerToken(null);
    setSessionId(null);
    setAutoJoinFilter(null);
  }

  // ── Derived UI state ─────────────────────────────────────────────────────────

  const isSearching =
    status === 'connecting' || status === 'ready' || status === 'in-queue';
  const isMatchFound = status === 'match-found';
  const hasConnectionError = status === 'error' || status === 'disconnected';
  const showForm = !isSearching && !isMatchFound;

  const variantLabel =
    VARIANT_OPTIONS.find((v) => v.value === cardVariant)?.label ?? cardVariant;

  const neededCount = playerCount - queueSize;

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 px-4">
      {/* Background decorative suits */}
      <div
        className="pointer-events-none fixed inset-0 overflow-hidden opacity-5 select-none"
        aria-hidden="true"
      >
        <span className="absolute text-[30rem] -top-24 -left-24 text-white">♣</span>
        <span className="absolute text-[20rem] bottom-0 right-0 text-white">♥</span>
      </div>

      <main className="relative z-10 flex flex-col items-center text-center max-w-md w-full gap-8">
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="space-y-2">
          <h1 className="text-4xl font-black text-white tracking-tight">
            {isMatchFound
              ? '🎉 Match Found!'
              : isSearching
              ? '🔍 Finding Players…'
              : '🎮 Play Now'}
          </h1>
          <p className="text-emerald-300 text-base">
            {isMatchFound
              ? 'Redirecting you to your game room…'
              : isSearching
              ? 'Waiting for other players to join the queue'
              : 'Choose your game settings and join the queue'}
          </p>
        </div>

        {/* ── Guest name indicator ─────────────────────────────────────────── */}
        {guestSession && (
          <div className="flex items-center gap-2 bg-emerald-900/50 border border-emerald-700/50 rounded-full px-4 py-2 text-sm text-emerald-200">
            <span aria-hidden="true">👤</span>
            Playing as{' '}
            <span className="font-semibold">{guestSession.displayName}</span>
          </div>
        )}

        {activitySummary && (
          <div
            className="w-full bg-slate-800/60 border border-slate-700/50 rounded-xl px-5 py-4 text-left"
            aria-live="polite"
            data-testid="matchmaking-activity-summary"
          >
            <p className="text-white font-semibold text-sm">
              {activitySummary.totalOnline} player
              {activitySummary.totalOnline === 1 ? '' : 's'} online now
            </p>
            <p className="mt-1 text-slate-300 text-xs">
              {activitySummary.totalWaiting} waiting for a public match
              {' '}·{' '}
              {activitySummary.livePlayers} in {activitySummary.activeGames} live public game
              {activitySummary.activeGames === 1 ? '' : 's'}
            </p>
          </div>
        )}

        {/* ── Match Found ──────────────────────────────────────────────────── */}
        {isMatchFound && (
          <div className="flex flex-col items-center gap-4">
            <div
              className="text-6xl animate-bounce"
              role="img"
              aria-label="Match found"
            >
              🃏
            </div>
            <p className="text-emerald-300 text-sm">Your game is ready — heading there now!</p>
          </div>
        )}

        {/* ── Searching / In-Queue ──────────────────────────────────────────── */}
        {isSearching && (
          <div
            className="w-full flex flex-col items-center gap-6"
            aria-live="polite"
            aria-label="Matchmaking queue status"
          >
            {/* Spinner */}
            <div
              className="w-16 h-16 border-4 border-emerald-600 border-t-transparent rounded-full animate-spin"
              role="status"
              aria-label="Searching for players"
            />

            {/* Queue info */}
            {status === 'in-queue' && (
              <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl px-6 py-4 w-full space-y-2 text-left">
                <p className="text-emerald-200 text-sm font-medium">
                  {queueSize === 1
                    ? "You're first in the queue — waiting for others…"
                    : `${queueSize} player${queueSize !== 1 ? 's' : ''} waiting`}
                </p>
                <p className="text-slate-400 text-xs">
                  {playerCount} players · {variantLabel}
                </p>
                <p className="text-slate-500 text-xs">
                  {neededCount > 0
                    ? `${neededCount} more player${neededCount !== 1 ? 's' : ''} needed to start`
                    : 'Starting soon!'}
                </p>
              </div>
            )}

            {/* Progress bar */}
            {status === 'in-queue' && (
              <div
                className="w-full bg-slate-700/50 rounded-full h-2 overflow-hidden"
                role="progressbar"
                aria-valuenow={queueSize}
                aria-valuemin={0}
                aria-valuemax={playerCount}
                aria-label={`Queue progress: ${queueSize} of ${playerCount} players`}
              >
                <div
                  className="bg-emerald-500 h-full rounded-full transition-all duration-500"
                  style={{ width: `${Math.min((queueSize / playerCount) * 100, 100)}%` }}
                />
              </div>
            )}

            {/* Cancel button */}
            <button
              onClick={handleCancel}
              className="
                w-full py-3 px-6 rounded-xl font-semibold text-base
                border border-slate-600 text-slate-300
                hover:bg-slate-800/50 hover:border-slate-400 hover:text-white
                active:scale-[0.97] transition-all duration-150
                focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2 focus:ring-offset-slate-950
              "
            >
              ✕ Cancel
            </button>
          </div>
        )}

        {/* ── Filter form (idle / error state) ─────────────────────────────── */}
        {showForm && (
          <div className="w-full space-y-6">
            {/* Error banner */}
            {(fetchError || hasConnectionError) && (
              <div
                className="bg-red-900/30 border border-red-700/50 rounded-xl px-4 py-3 text-red-300 text-sm text-left"
                role="alert"
              >
                {fetchError ?? 'Connection lost. Please try again.'}
              </div>
            )}

            {/* Player count selector */}
            <fieldset>
              <legend className="text-sm font-medium text-slate-300 mb-3 block text-left">
                Players per game
              </legend>
              <div className="grid grid-cols-2 gap-3">
                {([6, 8] as const).map((count) => (
                  <button
                    key={count}
                    type="button"
                    onClick={() => setPlayerCount(count)}
                    aria-pressed={playerCount === count}
                    className={`
                      py-3 px-4 rounded-xl font-semibold text-base border transition-all duration-150
                      focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-slate-950
                      ${
                        playerCount === count
                          ? 'bg-emerald-700/50 border-emerald-500 text-white'
                          : 'border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white'
                      }
                    `}
                  >
                    {count} Players
                  </button>
                ))}
              </div>
            </fieldset>

            {/* Card variant selector */}
            <fieldset>
              <legend className="text-sm font-medium text-slate-300 mb-3 block text-left">
                Card variant
              </legend>
              <div className="flex flex-col gap-2">
                {VARIANT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setCardVariant(opt.value)}
                    aria-pressed={cardVariant === opt.value}
                    className={`
                      w-full text-left py-3 px-4 rounded-xl border transition-all duration-150
                      focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-slate-950
                      ${
                        cardVariant === opt.value
                          ? 'bg-emerald-700/50 border-emerald-500 text-white'
                          : 'border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white'
                      }
                    `}
                  >
                    <div className="font-semibold text-sm">{opt.label}</div>
                    <div className="text-xs opacity-70 mt-0.5">{opt.description}</div>
                  </button>
                ))}
              </div>
            </fieldset>

            {/* Find Game button */}
            <button
              onClick={handleFindGame}
              disabled={isFetching}
              className="
                w-full py-4 px-6 rounded-xl font-bold text-lg
                bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700
                disabled:opacity-50 disabled:cursor-not-allowed
                text-white shadow-lg shadow-emerald-900/50
                transition-all duration-150 active:scale-[0.97]
                focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-slate-950
              "
            >
              {isFetching ? '⏳ Connecting…' : '🔍 Find Game'}
            </button>

            {/* Back to home */}
            <button
              onClick={() => router.push('/')}
              className="w-full text-sm text-slate-500 hover:text-slate-300 transition-colors"
            >
              ← Back to home
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
