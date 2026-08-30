'use client';

/**
 * useTurnIndicator — manages the "your turn" visual + turn-start nudges.
 *
 * Persists the glow visual until the player submits a valid
 * action, then clears it immediately (optimistic clear before the server
 * acknowledges the action). Audio and vibration fire once when the turn
 * starts; the tab title flashes while the turn is pending and the tab is
 * in the background.
 *
 * ### Lifecycle
 * 1. When `isMyTurn` transitions **false → true**: activates the indicator,
 * plays a single turn-start chime and vibrates (where supported).
 * 2. When `clearIndicator()` is called (player taps Ask or Declare): the
 * indicator is cleared *immediately*, before the server responds.
 * 3. When `isMyTurn` transitions **true → false** (server confirmed the
 * action or enforced a timeout): remaining state is cleaned up so the hook
 * is ready for the next turn.
 *
 * ### Usage in the game page
 * ```tsx
 * const { indicatorActive, clearIndicator } = useTurnIndicator(isMyTurn);
 *
 * function handleAsk(targetId, cardId) {
 * clearIndicator(); // <— immediate optimistic clear
 * sendAsk(targetId, cardId);
 * }
 *
 * // Pass indicatorActive to the seat so the glow clears immediately:
 * <GamePlayerSeat
 * ...
 * isActiveTurn={player.playerId === myPlayerId ? indicatorActive: undefined}
 * />
 * ```
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { playTurnChime } from '@/lib/audio';

const TURN_VIBRATION_PATTERN = [200, 100, 200];
const TURN_TITLE = '🔔 Your turn!';
const TITLE_FLASH_INTERVAL_MS = 1000;

// ── Public API ────────────────────────────────────────────────────────────────

export interface UseTurnIndicatorReturn {
  /**
   * `true` while it is the player's turn and no valid action has been
   * submitted yet. Drive the `isActiveTurn` prop on `GamePlayerSeat` from
   * this value to show/clear the amber glow.
   */
  indicatorActive: boolean;

  /**
   * Call immediately when the player submits a valid action (ask or declare).
   *
   * Sets `indicatorActive = false` *before* the server confirms the action,
   * giving instant UI feedback that the player's input was received.
   */
  clearIndicator: () => void;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * `useTurnIndicator`
 *
 * @param isMyTurn – Whether it is currently this client's turn.
 */
export function useTurnIndicator(
  isMyTurn: boolean,
): UseTurnIndicatorReturn {
  const [indicatorActive, setIndicatorActive] = useState(false);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const activeRef = useRef(false);
  // Tracks the previous isMyTurn value to detect false → true transitions.
  const prevTurnRef = useRef(false);

  // ── Public: clearIndicator ────────────────────────────────────────────────

  const clearIndicator = useCallback(() => {
    activeRef.current = false;
    setIndicatorActive(false);
  }, []);

  // ── Turn-change effect ────────────────────────────────────────────────────

  useEffect(() => {
    const wasMine = prevTurnRef.current;
    prevTurnRef.current = isMyTurn;

    if (isMyTurn && !wasMine) {
      // ── Turn just became mine ──────────────────────────────────────────
      activeRef.current = true;
      setIndicatorActive(true);

      // Immediate chime + haptic on turn start
      playTurnChime();
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate(TURN_VIBRATION_PATTERN);
      }
    } else if (!isMyTurn && wasMine) {
      // ── Turn passed (server confirmed action or enforced timeout) ──────
      activeRef.current = false;
      setIndicatorActive(false);
    }
  }, [isMyTurn]);

  // ── Tab title flash ───────────────────────────────────────────────────────
  // Only alternates while the tab is hidden, so a player looking at the
  // table never sees the title change. Restores the original on clear.

  useEffect(() => {
    if (!indicatorActive || typeof document === 'undefined') return;

    const originalTitle = document.title;
    const id = setInterval(() => {
      document.title =
        document.hidden && document.title === originalTitle ? TURN_TITLE : originalTitle;
    }, TITLE_FLASH_INTERVAL_MS);

    return () => {
      clearInterval(id);
      document.title = originalTitle;
    };
  }, [indicatorActive]);

  return { indicatorActive, clearIndicator };
}
