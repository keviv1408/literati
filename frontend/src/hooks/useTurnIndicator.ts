'use client';

/**
 * useTurnIndicator — manages the "your turn" visual + audio notification loop.
 *
 * Sub-AC 14-3: Persists both the glow visual and audio chime until the player
 * submits a valid action, then clears them immediately (optimistic clear
 * before the server acknowledges the action).
 *
 * ### Lifecycle
 * 1. When `isMyTurn` transitions **false → true**: activates the indicator,
 *    plays a turn-start chime, and starts a repeat interval so the player
 *    cannot miss their cue.
 * 2. When `clearIndicator()` is called (player taps Ask or Declare): the
 *    indicator and repeat interval are cleared *immediately*, before the
 *    server responds.
 * 3. When `isMyTurn` transitions **true → false** (server confirmed the
 *    action or enforced a timeout): any remaining state is cleaned up so the
 *    hook is ready for the next turn.
 *
 * ### Usage in the game page
 * ```tsx
 * const { indicatorActive, clearIndicator } = useTurnIndicator(isMyTurn);
 *
 * function handleAsk(targetId, cardId) {
 *   clearIndicator(); // <— immediate optimistic clear
 *   sendAsk(targetId, cardId);
 * }
 *
 * // Pass indicatorActive to the seat so the glow clears immediately:
 * <GamePlayerSeat
 *   ...
 *   isActiveTurn={player.playerId === myPlayerId ? indicatorActive : undefined}
 * />
 * ```
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { playTurnChime } from '@/lib/audio';

// ── Public API ────────────────────────────────────────────────────────────────

export interface UseTurnIndicatorReturn {
  /**
   * `true` while it is the player's turn and no valid action has been
   * submitted yet.  Drive the `isActiveTurn` prop on `GamePlayerSeat` from
   * this value to show/clear the amber glow.
   */
  indicatorActive: boolean;

  /**
   * Call immediately when the player submits a valid action (ask or declare).
   *
   * Sets `indicatorActive = false` and cancels the audio repeat interval
   * *before* the server confirms the action, giving instant UI feedback that
   * the player's input was received.
   */
  clearIndicator: () => void;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * `useTurnIndicator`
 *
 * @param isMyTurn  – Whether it is currently this client's turn.
 * @param repeatMs  – Milliseconds between audio re-triggers while waiting.
 *                    Defaults to 8 000 ms (8 seconds).
 */
export function useTurnIndicator(
  isMyTurn: boolean,
  repeatMs = 8_000,
): UseTurnIndicatorReturn {
  const [indicatorActive, setIndicatorActive] = useState(false);

  // ── Refs ──────────────────────────────────────────────────────────────────
  // activeRef mirrors `indicatorActive` without a re-render cost, so the
  // setInterval callback can read it without a stale-closure issue.
  const activeRef   = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Tracks the previous isMyTurn value to detect false → true transitions.
  const prevTurnRef = useRef(false);

  // ── Helpers ───────────────────────────────────────────────────────────────

  const stopInterval = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // ── Public: clearIndicator ────────────────────────────────────────────────

  const clearIndicator = useCallback(() => {
    activeRef.current = false;
    setIndicatorActive(false);
    stopInterval();
  }, [stopInterval]);

  // ── Turn-change effect ────────────────────────────────────────────────────

  useEffect(() => {
    const wasMine = prevTurnRef.current;
    prevTurnRef.current = isMyTurn;

    if (isMyTurn && !wasMine) {
      // ── Turn just became mine ──────────────────────────────────────────
      activeRef.current = true;
      setIndicatorActive(true);

      // Immediate chime on turn start
      playTurnChime();

      // Re-fire chime on interval so the cue persists until the player acts
      stopInterval();
      intervalRef.current = setInterval(() => {
        // Guard: clearIndicator() may have run between interval ticks
        if (activeRef.current) playTurnChime();
      }, repeatMs);
    } else if (!isMyTurn && wasMine) {
      // ── Turn passed (server confirmed action or enforced timeout) ──────
      // clearIndicator() may have already cleaned up; safe to call again.
      activeRef.current = false;
      setIndicatorActive(false);
      stopInterval();
    }
  }, [isMyTurn, repeatMs, stopInterval]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────

  useEffect(() => () => stopInterval(), [stopInterval]);

  return { indicatorActive, clearIndicator };
}
