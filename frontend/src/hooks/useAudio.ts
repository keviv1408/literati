'use client';

/**
 * useAudio — React hook for managing game audio cues and mute preference.
 *
 * Reads the initial mute state from localStorage on first render (via the
 * `audio` utility), exposes a reactive `muted` boolean, a `toggleMute`
 * callback that both updates localStorage and triggers a React re-render,
 * and stable sound callbacks that delegate to the Audio API utility.
 *
 * All sound callbacks are safe to use in SSR and are no-ops when muted.
 *
 * | Callback               | When to call                          |
 * |------------------------|---------------------------------------|
 * | playTurnChime()        | Turn starts / repeats (useTurnIndicator) |
 * | playDealSound()        | `game_init` with first hand           |
 * | playAskSuccess()       | `ask_result` where `success === true` |
 * | playAskFail()          | `ask_result` where `success === false`|
 * | playDeclarationSuccess | `declaration_result` where `correct === true` |
 * | playDeclarationFail()  | `declaration_result` where `correct === false` |
 *
 * @example
 * const { muted, toggleMute, playAskSuccess, playAskFail } = useAudio();
 *
 * // React to ask results
 * useEffect(() => {
 *   if (lastAskResult?.success) playAskSuccess();
 *   else if (lastAskResult) playAskFail();
 * }, [lastAskResult]);
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
  playDealSound as rawPlayDealSound,
  playAskSuccess as rawPlayAskSuccess,
  playAskFail as rawPlayAskFail,
  playDeclarationSuccess as rawPlayDeclarationSuccess,
  playDeclarationFail as rawPlayDeclarationFail,
} from '@/lib/audio';

export interface UseAudioReturn {
  /** Whether game sounds are currently muted. */
  muted: boolean;
  /** Toggle mute on/off and persist the preference. */
  toggleMute: () => void;
  /** Play the turn-start chime (respects mute preference). */
  playTurnChime: () => void;
  /** Play the card-deal sound when cards are distributed at game start. */
  playDealSound: () => void;
  /** Play a positive confirmation sound when a card request succeeds. */
  playAskSuccess: () => void;
  /** Play a negative sound when a card request fails. */
  playAskFail: () => void;
  /** Play a triumphant fanfare when a declaration is correct. */
  playDeclarationSuccess: () => void;
  /** Play a somber motif when a declaration is incorrect. */
  playDeclarationFail: () => void;
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

  const playTurnChime        = useCallback(() => rawPlayChime(), []);
  const playDealSound        = useCallback(() => rawPlayDealSound(), []);
  const playAskSuccess       = useCallback(() => rawPlayAskSuccess(), []);
  const playAskFail          = useCallback(() => rawPlayAskFail(), []);
  const playDeclarationSuccess = useCallback(() => rawPlayDeclarationSuccess(), []);
  const playDeclarationFail  = useCallback(() => rawPlayDeclarationFail(), []);

  return {
    muted,
    toggleMute,
    playTurnChime,
    playDealSound,
    playAskSuccess,
    playAskFail,
    playDeclarationSuccess,
    playDeclarationFail,
  };
}
