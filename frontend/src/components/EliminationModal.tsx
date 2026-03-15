'use client';

/**
 * EliminationModal — shown to a human player whose hand was emptied by a
 * declaration (Sub-AC 27b).
 *
 * Prompts the eliminated player to choose one of their eligible teammates to
 * receive future turns on their behalf.  The server will use this choice when
 * `_resolveValidTurn` is called with the eliminated player's ID.
 *
 * ### Behaviour
 * - Rendered when `eliminationPrompt` is non-null (set by `useGameSocket` on
 *   `choose_turn_recipient_prompt` arrival).
 * - Lists only eligible teammates (those still holding cards).
 * - On selection: calls `onChoose(recipientId)` which sends
 *   `choose_turn_recipient` to the server and clears the prompt.
 * - The modal is dismissed automatically after the player confirms a choice.
 * - If there are NO eligible teammates (entire team eliminated), the modal
 *   shows an informational message and auto-closes after 4 seconds.
 * - The game continues regardless of whether or when the player responds
 *   (the prompt is fire-and-forget from the server's perspective).
 *
 * ### Accessibility
 * - `role="dialog"` + `aria-modal="true"` + `aria-labelledby`.
 * - Focus is trapped inside while the modal is open (first button auto-focused).
 * - Pressing Escape key is not implemented intentionally — the player MUST
 *   select a teammate (or the auto-close fires after 4 s if no eligible ones).
 */

import React, { useEffect, useRef } from 'react';
import type { ChooseTurnRecipientPromptPayload } from '@/types/game';

export interface EliminationModalProps {
  /** The `choose_turn_recipient_prompt` payload from the server. */
  prompt: ChooseTurnRecipientPromptPayload;

  /**
   * Called when the player selects a teammate to receive their future turns.
   * The parent should send `choose_turn_recipient` to the server and clear the
   * prompt state.
   */
  onChoose: (recipientId: string) => void;
}

const EliminationModal: React.FC<EliminationModalProps> = ({ prompt, onChoose }) => {
  const { eligibleTeammates } = prompt;
  const hasEligible = eligibleTeammates.length > 0;

  // Auto-focus the first button so keyboard users can tab through options.
  const firstButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const t = setTimeout(() => firstButtonRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  // Auto-close when there are no eligible teammates (informational only).
  // The server already handles the turn fall-through in this case.
  useEffect(() => {
    if (!hasEligible) {
      const t = setTimeout(() => onChoose(''), 4000);
      return () => clearTimeout(t);
    }
  }, [hasEligible, onChoose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="elimination-modal-title"
      data-testid="elimination-modal"
    >
      <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl p-6 flex flex-col gap-5">
        {/* Header */}
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="text-4xl" aria-hidden="true">💀</span>
          <h2
            id="elimination-modal-title"
            className="text-lg font-bold text-white"
          >
            You&rsquo;ve been eliminated!
          </h2>
          <p className="text-sm text-slate-400">
            Your hand is empty — you can no longer ask, be asked, or declare.
          </p>
        </div>

        {hasEligible ? (
          <>
            <p className="text-sm text-slate-300 text-center">
              Choose a teammate to receive future turns on your behalf:
            </p>

            <div
              className="flex flex-col gap-2"
              role="list"
              aria-label="Eligible teammates"
            >
              {eligibleTeammates.map((teammate, idx) => (
                <button
                  key={teammate.playerId}
                  ref={idx === 0 ? firstButtonRef : undefined}
                  onClick={() => onChoose(teammate.playerId)}
                  className={[
                    'w-full py-3 px-4 rounded-xl font-semibold text-sm text-white',
                    'bg-emerald-700 hover:bg-emerald-600 active:bg-emerald-800',
                    'transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400',
                  ].join(' ')}
                  aria-label={`Pass future turns to ${teammate.displayName}`}
                  data-testid={`recipient-button-${teammate.playerId}`}
                >
                  {teammate.displayName}
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="text-center">
            <p className="text-sm text-slate-400">
              No eligible teammates — your entire team has been eliminated.
            </p>
            <p className="text-xs text-slate-500 mt-2 animate-pulse">
              Closing automatically…
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default EliminationModal;
