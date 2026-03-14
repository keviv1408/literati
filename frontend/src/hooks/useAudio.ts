'use client';

/**
 * useAudio — React hook for managing game audio cues and mute preference.
 *
 * Reads the initial mute state from localStorage on first render (via the
 * `audio` utility), exposes a reactive `muted` boolean, a `toggleMute`
 * callback that both updates localStorage and triggers a React re-render,
 * and a `playTurnChime` callback that delegates to the Audio API utility.
 *
 * The hook is safe to use in SSR — both `isMuted()` and `playTurnChime()`
 * are no-ops outside a browser environment.
 *
 * @example
 * const { muted, toggleMute, playTurnChime } = useAudio();
 *
 * // Play chime on your turn
 * useEffect(() => {
 *   if (isMyTurn) playTurnChime();
 * }, [isMyTurn]);
 *
 * // Mute toggle button
 * <button onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
 *   {muted ? '🔇' : '🔔'}
 * </button>
 */

import { useState, useCallback } from 'react';
import {
  isMuted,
  setMuted,
  playTurnChime as rawPlayChime,
} from '@/lib/audio';

export interface UseAudioReturn {
  /** Whether game sounds are currently muted. */
  muted: boolean;
  /** Toggle mute on/off and persist the preference. */
  toggleMute: () => void;
  /** Play the turn-start chime (respects mute preference). */
  playTurnChime: () => void;
}

export function useAudio(): UseAudioReturn {
  // Initialise from localStorage so the preference survives a page refresh.
  const [muted, setMutedState] = useState<boolean>(() => isMuted());

  const toggleMute = useCallback(() => {
    setMutedState((prev) => {
      const next = !prev;
      setMuted(next);
      return next;
    });
  }, []);

  const playTurnChime = useCallback(() => {
    rawPlayChime();
  }, []);

  return { muted, toggleMute, playTurnChime };
}
