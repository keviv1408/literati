'use client';

/**
 * useAudio — React hook for managing game audio cues, mute preference, and
 * volume control.
 *
 * Reads the initial mute state from localStorage on first render (via the
 * `audio` utility), exposes a reactive `muted` boolean, a `toggleMute`
 * callback that both updates localStorage and triggers a React re-render,
 * and stable sound callbacks for every game event.
 *
 * Volume is managed by the `soundManager` service — a persistent AudioContext
 * singleton that supports preloading (to unlock audio on mobile browsers) and
 * a per-session volume level stored in localStorage.
 *
 * All sound callbacks are safe to use in SSR and are no-ops when muted.
 *
 * | Callback                 | When to call                                  |
 * |--------------------------|-----------------------------------------------|
 * | playTurnChime()          | Turn starts / repeats (useTurnIndicator)      |
 * | playCardDeal()           | `game_init` with first hand                   |
 * | playAskSuccess()         | `ask_result` where `success === true`         |
 * | playAskFail()            | `ask_result` where `success === false`        |
 * | playDeclarationFanfare() | Any `declaration_result` (correct or not)     |
 *
 * @example
 * const { muted, toggleMute, volume, setVolume, preload,
 *         playAskSuccess, playAskFail, playDeclarationFanfare } = useAudio();
 *
 * // Unlock audio on the very first user interaction
 * <button onClick={preload}>Start game</button>
 *
 * // React to ask results
 * useEffect(() => {
 *   if (lastAskResult?.success) playAskSuccess();
 *   else if (lastAskResult) playAskFail();
 * }, [lastAskResult]);
 *
 * // Volume slider
 * <input type="range" min={0} max={1} step={0.05}
 *   value={volume} onChange={e => setVolume(Number(e.target.value))} />
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
import { soundManager } from '@/lib/soundManager';

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

  // --- SoundManager-backed features -----------------------------------------

  /**
   * Current master volume level (0.0 = silent, 1.0 = full).
   * Persisted to localStorage; survives page refresh.
   */
  volume: number;
  /**
   * Set the master volume for all SoundManager-based audio events.
   * Value is clamped to [0.0, 1.0] and persisted automatically.
   */
  setVolume: (level: number) => void;
  /**
   * Preload / unlock the AudioContext.
   * Call once on the first user interaction to ensure audio plays immediately
   * on subsequent events (especially important on iOS Safari).
   */
  preload: () => void;
  /**
   * Play a brief "swoosh" when cards are dealt.
   * Backed by SoundManager (respects volume + mute).
   */
  playCardDeal: () => void;
  /**
   * Play a triumphant fanfare when any half-suit declaration fires.
   * Backed by SoundManager (respects volume + mute).
   */
  playDeclarationFanfare: () => void;
}

export function useAudio(): UseAudioReturn {
  // Initialise muted state from localStorage so the preference survives a
  // page refresh.
  const [muted, setMutedState] = useState<boolean>(() => isMuted());

  // Volume state is seeded from soundManager (which reads localStorage).
  const [volume, setVolumeState] = useState<number>(() => soundManager.volume);

  const toggleMute = useCallback(() => {
    setMutedState((prev) => {
      const next = !prev;
      setMuted(next);
      return next;
    });
  }, []);

  // Legacy audio.ts-backed callbacks (no volume control, recreate AudioContext
  // per call — kept for backwards compatibility with existing callers).
  const playTurnChime          = useCallback(() => rawPlayChime(), []);
  const playDealSound          = useCallback(() => rawPlayDealSound(), []);
  const playAskSuccess         = useCallback(() => rawPlayAskSuccess(), []);
  const playAskFail            = useCallback(() => rawPlayAskFail(), []);
  const playDeclarationSuccess = useCallback(() => rawPlayDeclarationSuccess(), []);
  const playDeclarationFail    = useCallback(() => rawPlayDeclarationFail(), []);

  // SoundManager-backed callbacks (persistent AudioContext, volume-aware).
  const setVolume = useCallback((level: number) => {
    soundManager.setVolume(level);
    setVolumeState(soundManager.volume); // read back clamped value
  }, []);

  const preload = useCallback(() => {
    soundManager.preload();
  }, []);

  const playCardDeal = useCallback(() => {
    soundManager.playCardDeal();
  }, []);

  const playDeclarationFanfare = useCallback(() => {
    soundManager.playDeclarationFanfare();
  }, []);

  return {
    muted,
    toggleMute,
    playTurnChime,
    playDealSound,
    playAskSuccess,
    playAskFail,
    playDeclarationSuccess,
    playDeclarationFail,
    volume,
    setVolume,
    preload,
    playCardDeal,
    playDeclarationFanfare,
  };
}
