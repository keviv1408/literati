'use client';

/**
 * InferenceContext — provides inference mode state to the game view.
 *
 * Inference mode shows card-location probability indicators on player seats,
 * derived from the public game event history (ask results, declarations).
 *
 * ### Behaviour by viewer type
 * | Viewer type | Default state | Toggle available?              |
 * |-------------|---------------|-------------------------------|
 * | Player      | Off           | Yes (via toggle button)        |
 * | Spectator   | On (forced)   | No — spectators always see it  |
 *
 * Spectators are identified by `isSpectator=true` on the provider.
 * When `isSpectator` is true, `toggleInferenceMode()` is a no-op and
 * `inferenceMode` is permanently `true`.
 *
 * ### Usage
 * ```tsx
 * // In game page:
 * const { cardInferences } = useCardInference({ lastAskResult, lastDeclareResult, variant });
 * const isSpectator = myPlayerId === null && wsStatus === 'connected' && players.length > 0;
 *
 * return (
 *   <InferenceProvider isSpectator={isSpectator} cardInferences={cardInferences}>
 *     <GameView />
 *   </InferenceProvider>
 * );
 *
 * // In a child component:
 * const { inferenceMode, cardInferences } = useInferenceContext();
 * const playerData = cardInferences[playerId] ?? {};
 * ```
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import type { CardInferenceState } from '@/hooks/useCardInference';

// ── Context value ─────────────────────────────────────────────────────────────

export interface InferenceContextValue {
  /**
   * Whether inference-mode overlays are currently visible.
   *
   * - For spectators: always `true`.
   * - For players: controlled by the toggle; defaults to `false`.
   */
  inferenceMode: boolean;

  /**
   * Toggle inference mode on / off.
   *
   * For spectators this is a **no-op** — inference mode is always on.
   */
  toggleInferenceMode: () => void;

  /**
   * Whether the current viewer is a spectator.
   *
   * `true` when the viewer has no player ID but has received valid game state.
   */
  isSpectator: boolean;

  /**
   * Per-player, per-card inference data derived from ask / declaration events.
   * `{ [playerId]: { [cardId]: 'confirmed' | 'excluded' } }`
   *
   * Absence of a (player, card) entry means "unknown".
   */
  cardInferences: CardInferenceState;
}

// ── Context instance ──────────────────────────────────────────────────────────

const InferenceContext = createContext<InferenceContextValue | null>(null);
InferenceContext.displayName = 'InferenceContext';

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Access inference mode state from within an `<InferenceProvider>` subtree.
 *
 * @throws {Error} If called outside an `<InferenceProvider>`.
 */
export function useInferenceContext(): InferenceContextValue {
  const ctx = useContext(InferenceContext);
  if (!ctx) {
    throw new Error(
      '[InferenceContext] useInferenceContext() must be called inside an <InferenceProvider>.',
    );
  }
  return ctx;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export interface InferenceProviderProps {
  /**
   * Whether the current viewer is a spectator.
   * If true, inference mode is permanently on and the toggle is disabled.
   */
  isSpectator: boolean;

  /**
   * Current inference data from `useCardInference`.
   * Passed in from the parent to keep the context lightweight.
   */
  cardInferences: CardInferenceState;

  children: ReactNode;
}

/**
 * Provides inference mode state and card inference data to all descendants.
 */
export function InferenceProvider({
  isSpectator,
  cardInferences,
  children,
}: InferenceProviderProps) {
  // Spectators: inference mode is permanently on (no internal toggle state needed).
  // Players:    start with inference mode off; toggle via button.
  const [playerInferenceMode, setPlayerInferenceMode] = useState(false);

  const inferenceMode = isSpectator ? true : playerInferenceMode;

  const toggleInferenceMode = useCallback(() => {
    if (isSpectator) return; // spectators cannot toggle
    setPlayerInferenceMode((prev) => !prev);
  }, [isSpectator]);

  const value = useMemo<InferenceContextValue>(
    () => ({
      inferenceMode,
      toggleInferenceMode,
      isSpectator,
      cardInferences,
    }),
    [inferenceMode, toggleInferenceMode, isSpectator, cardInferences],
  );

  return (
    <InferenceContext.Provider value={value}>
      {children}
    </InferenceContext.Provider>
  );
}
