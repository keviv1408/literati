'use client';

/**
 * DeclarationResultOverlay —
 *
 * Full-screen overlay shown to all players immediately after a
 * `declaration_result` WebSocket event is received.
 *
 * Features:
 * • Shows ✅ / ❌ for correct / incorrect declaration
 * • Names the winning team and the declared half-suit
 * • Displays the `lastMove` summary string from the server
 * • 3-second auto-dismiss countdown with a visible "N s" timer pill
 * • Explicit "Dismiss" button cancels the countdown and dismisses immediately
 * • `onDismiss` callback is called exactly once (auto or manual)
 *
 * After `onDismiss` fires the parent dispatches the game-advance action
 * (sends `{ type: 'game_advance' }` to the server) so the next turn can
 * visually proceed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeclarationResultPayload, GamePlayer } from '@/types/game';
import { halfSuitLabel } from '@/types/game';

export interface DeclarationResultOverlayProps {
  /** The declaration result payload from the server. */
  result: DeclarationResultPayload;
  /** All connected players — used to resolve declarer display name. */
  players: GamePlayer[];
  /** The local player's team ID (1 | 2 | null for spectators). */
  myTeamId: 1 | 2 | null;
  /**
   * Called exactly once when the overlay is dismissed — either by the
   * auto-countdown reaching 0 or by an explicit "Dismiss" button press.
   *
   * After this callback fires the parent should dispatch the game-advance
   * action to continue to the next turn.
   */
  onDismiss: () => void;
  /**
   * Auto-dismiss delay in ms. Defaults to 3 000 (3 seconds).
   * Exposed for testing.
   */
  autoDismissMs?: number;
}

/**
 * DeclarationResultOverlay
 *
 * Mounts as a fixed full-screen backdrop (z-50) so it renders above all other
 * game UI. The inner card is centred and constrained to a readable width on
 * both mobile and desktop.
 */
export default function DeclarationResultOverlay({
  result,
  players,
  myTeamId,
  onDismiss,
  autoDismissMs = 3_000,
}: DeclarationResultOverlayProps) {
  const totalSeconds = Math.max(1, Math.ceil(autoDismissMs / 1_000));
  const [countdown, setCountdown] = useState(totalSeconds);

  // Refs so interval callbacks never capture stale closures
  const intervalRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const dismissedRef  = useRef(false);
  const onDismissRef  = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  /** Fire onDismiss exactly once and clear the interval. */
  const dismiss = useCallback(() => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    onDismissRef.current();
  }, []);

  // Track countdown in a ref so the interval callback can read it without a
  // closure over stale state.
  const countdownRef = useRef(totalSeconds);

  // ── Auto-dismiss countdown ─────────────────────────────────────────────────
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      countdownRef.current -= 1;
      // Update the display state
      setCountdown(countdownRef.current);
      // When the countdown reaches zero, fire dismiss directly from the
      // interval callback (not inside a setState updater) so fake-timer-based
      // tests can observe the call synchronously.
      if (countdownRef.current <= 0) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        if (!dismissedRef.current) {
          dismissedRef.current = true;
          onDismissRef.current();
        }
      }
    }, 1_000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount-once — `dismiss` and `autoDismissMs` are stable

  // ── Derived display values ─────────────────────────────────────────────────
  const { correct, winningTeam, halfSuitId, lastMove, declarerId } = result;

  const declarerName =
    players.find((p) => p.playerId === declarerId)?.displayName ?? 'Unknown';

  const halfSuitName = halfSuitLabel(halfSuitId);

  // My team scored if myTeamId matches winningTeam; null = spectator
  const myTeamScored = myTeamId !== null && myTeamId === winningTeam;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Declaration result"
      data-testid="declaration-result-overlay"
    >
      <div
        className="relative w-full max-w-sm rounded-2xl border border-slate-700/60 bg-slate-900 shadow-2xl p-6 flex flex-col items-center gap-4 text-center"
        data-testid="declaration-result-card"
      >
        {/* ── Result icon ────────────────────────────────────────────────── */}
        <div
          className="text-5xl leading-none"
          aria-hidden="true"
          data-testid="declaration-result-icon"
        >
          {correct ? '✅' : '❌'}
        </div>

        {/* ── Result headline ────────────────────────────────────────────── */}
        <div className="flex flex-col gap-1">
          <p
            className={[
              'text-xl font-bold',
              correct ? 'text-emerald-300' : 'text-red-400',
            ].join(' ')}
            data-testid="declaration-result-headline"
          >
            {correct ? 'Correct Declaration!' : 'Incorrect Declaration!'}
          </p>

          <p className="text-sm text-slate-400" data-testid="declaration-result-declarer">
            Declared by <strong className="text-slate-200">{declarerName}</strong>
          </p>

          <p className="text-sm text-slate-300 font-medium" data-testid="declaration-result-suit">
            {halfSuitName}
          </p>
        </div>

        {/* ── Team score ─────────────────────────────────────────────────── */}
        <div
          className={[
            'px-4 py-2 rounded-xl text-sm font-semibold border',
            winningTeam === 1
              ? 'bg-emerald-900/50 border-emerald-700/50 text-emerald-300'
              : 'bg-violet-900/50 border-violet-700/50 text-violet-300',
          ].join(' ')}
          data-testid="declaration-result-team"
          aria-label={`Team ${winningTeam} scores`}
        >
          {myTeamId === null
            ? `Team ${winningTeam} scores!`
            : myTeamScored
            ? `Your team scores! 🎉`
            : `Opponent team scores`}
        </div>

        {/* ── Last move text ──────────────────────────────────────────────── */}
        {lastMove && (
          <p
            className="text-xs text-slate-500 italic"
            data-testid="declaration-result-last-move"
          >
            {lastMove}
          </p>
        )}

        {/* ── Auto-dismiss countdown + Dismiss button ─────────────────────── */}
        <div className="flex items-center gap-3 pt-2">
          {/* Visible countdown pill */}
          <span
            className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-slate-800 border border-slate-700 text-slate-300 text-sm font-mono font-bold tabular-nums"
            aria-live="polite"
            aria-label={`Auto-closing in ${countdown} second${countdown !== 1 ? 's' : ''}`}
            data-testid="declaration-result-countdown"
          >
            {countdown}s
          </span>

          {/* Explicit dismiss button — cancels the countdown */}
          <button
            onClick={dismiss}
            className="px-4 py-2 rounded-xl text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-white transition-colors focus:outline-none focus:ring-2 focus:ring-slate-400"
            aria-label="Dismiss declaration result overlay"
            data-testid="declaration-result-dismiss-btn"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
